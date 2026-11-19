import base64
import io
import cv2
import numpy as np
from PIL import Image
import tensorflow as tf


def find_last_conv_layer(model):
    """Find the name of the last 4D conv/activation layer before GlobalAveragePooling."""
    for layer in reversed(model.layers):
        try:
            if hasattr(layer, 'output'):
                out_shape = layer.output.shape
                if len(out_shape) == 4 and out_shape[1] is not None and out_shape[1] > 1:
                    return layer.name
        except Exception:
            continue
    return 'out_relu'


def build_grad_model(model, last_conv_layer_name=None):
    """Build a reusable Keras model returning [last_conv_output, model_output]."""
    if last_conv_layer_name is None:
        last_conv_layer_name = find_last_conv_layer(model)
    target_layer = model.get_layer(last_conv_layer_name)
    return tf.keras.models.Model(
        inputs=model.input,
        outputs=[target_layer.output, model.output]
    )


def make_gradcam_heatmap(img_array, model, last_conv_layer_name=None, pred_index=None, grad_model=None):
    """
    img_array: preprocessed batch array of shape (1, H, W, 3) in [-1, 1]
    model: tf.keras.Model
    last_conv_layer_name: name of target conv layer
    pred_index: class index for gradient computation
    grad_model: optional prebuilt grad_model for faster repeated calls
    """
    if grad_model is None:
        grad_model = build_grad_model(model, last_conv_layer_name=last_conv_layer_name)

    img_tensor = tf.convert_to_tensor(img_array, dtype=tf.float32)

    with tf.GradientTape() as tape:
        conv_outputs, predictions = grad_model(img_tensor, training=False)
        if pred_index is None:
            pred_index = int(tf.argmax(predictions[0]))
        class_channel = predictions[:, pred_index]

    grads = tape.gradient(class_channel, conv_outputs)
    pooled_grads = tf.reduce_mean(grads, axis=(0, 1, 2))

    conv_outputs = conv_outputs[0]
    heatmap = conv_outputs @ pooled_grads[..., tf.newaxis]
    heatmap = tf.squeeze(heatmap)

    heatmap = tf.maximum(heatmap, 0.0)
    max_val = tf.math.reduce_max(heatmap)
    if max_val > 0.0:
        heatmap = heatmap / max_val
    return heatmap.numpy()


def overlay_gradcam(orig_img_rgb, heatmap, alpha=0.45, colormap=cv2.COLORMAP_JET):
    """
    orig_img_rgb: uint8 numpy array (H, W, 3)
    heatmap: 2D numpy array [0, 1]
    Returns: (overlaid_rgb, heatmap_rgb)
    """
    h, w = orig_img_rgb.shape[:2]
    heatmap_resized = cv2.resize(heatmap, (w, h), interpolation=cv2.INTER_LINEAR)
    heatmap_uint8 = np.uint8(255 * np.clip(heatmap_resized, 0.0, 1.0))

    heatmap_bgr = cv2.applyColorMap(heatmap_uint8, colormap)
    heatmap_rgb = cv2.cvtColor(heatmap_bgr, cv2.COLOR_BGR2RGB)

    overlaid = (1.0 - alpha) * orig_img_rgb.astype(np.float32) + alpha * heatmap_rgb.astype(np.float32)
    overlaid = np.clip(overlaid, 0, 255).astype(np.uint8)
    return overlaid, heatmap_rgb


def image_to_base64_png(img_rgb):
    """Convert RGB uint8 numpy array to base64 data PNG string."""
    pil_img = Image.fromarray(img_rgb)
    buffer = io.BytesIO()
    pil_img.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode('utf-8')


def analyze_lesion_and_contours(orig_img_rgb, heatmap, predicted_class):
    """
    Estimate infected leaf surface percentage and render a high-activation lesion contour overlay.
    Purely additive post-processing — never alters model predictions.
    """
    h, w = orig_img_rgb.shape[:2]
    hm_resized = cv2.resize(heatmap, (w, h), interpolation=cv2.INTER_LINEAR)
    hm_norm = np.clip(hm_resized, 0.0, 1.0)

    hsv = cv2.cvtColor(orig_img_rgb, cv2.COLOR_RGB2HSV)
    hue, sat, val = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]

    # Broad foliage mask (green + chlorotic yellow + necrotic brown leaf area)
    leaf_mask = ((hue >= 10) & (hue <= 98) & (sat >= 22) & (val >= 20))
    leaf_pixels = int(np.sum(leaf_mask))
    if leaf_pixels < 100:
        leaf_mask = np.ones((h, w), dtype=bool)
        leaf_pixels = h * w

    # Render contour overlay copy
    contour_vis = orig_img_rgb.copy()

    if predicted_class == "healthy":
        # Draw subtle #9BF272 focus contour showing clean healthy attention region
        focus_bin = ((hm_norm >= 0.55) & leaf_mask).astype(np.uint8) * 255
        contours, _ = cv2.findContours(focus_bin, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(contour_vis, contours, -1, (155, 242, 114), 2, cv2.LINE_AA)
        return {
            "infected_area_pct": 0.0,
            "severity_stage": "Healthy Canopy (0%)",
            "action_threshold": "No Spray Required — Routine Weekly Scouting",
            "contour_rgb": contour_vis
        }

    # Diseased lesion cues inside leaf: chlorotic yellow / rust-orange / necrotic dark brown
    lesion_color = (
        ((hue < 28) & (sat >= 35) & (val >= 25)) |
        ((hue >= 28) & (hue <= 42) & (val < 115) & (sat >= 35))
    ) & leaf_mask

    # Combine Grad-CAM attention hotspot (>= 0.42) with visual lesion discoloration
    gradcam_hot = (hm_norm >= 0.48) & leaf_mask
    combined_lesion = (lesion_color & (hm_norm >= 0.25)) | (gradcam_hot & (hm_norm >= 0.62))

    # Morphological cleanup
    mask_u8 = combined_lesion.astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask_u8 = cv2.morphologyEx(mask_u8, cv2.MORPH_OPEN, kernel)
    mask_u8 = cv2.morphologyEx(mask_u8, cv2.MORPH_CLOSE, kernel)

    raw_pct = (float(np.sum(mask_u8 > 0)) / float(leaf_pixels)) * 100.0
    infected_pct = round(float(np.clip(raw_pct, 2.5, 82.0)), 1)

    if infected_pct < 15.0:
        stage = f"Early Stage ({infected_pct:.1f}%)"
        threshold = "Preventive Threshold — Targeted Foliar Spray Recommended"
    elif infected_pct < 35.0:
        stage = f"Moderate Spread ({infected_pct:.1f}%)"
        threshold = "Action Threshold Exceeded — Apply Fungicide & Isolate Row"
    else:
        stage = f"Severe Outbreak ({infected_pct:.1f}%)"
        threshold = "Critical Intervention — Immediate Treatment & Debris Removal"

    # Subtle translucent tint on detected lesion zones + crisp #e86f54 / #9BF272 contour borders
    tint = contour_vis.copy()
    tint[mask_u8 > 0] = (
        0.58 * tint[mask_u8 > 0].astype(np.float32) +
        0.42 * np.array([232, 111, 84], dtype=np.float32)
    ).astype(np.uint8)
    contour_vis = tint

    contours, _ = cv2.findContours(mask_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(contour_vis, contours, -1, (240, 177, 75), 2, cv2.LINE_AA)

    # Outer Grad-CAM attention perimeter in #9BF272
    hot_u8 = (hm_norm >= 0.52).astype(np.uint8) * 255
    hot_contours, _ = cv2.findContours(hot_u8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(contour_vis, hot_contours, -1, (155, 242, 114), 1, cv2.LINE_AA)

    return {
        "infected_area_pct": infected_pct,
        "severity_stage": stage,
        "action_threshold": threshold,
        "contour_rgb": contour_vis
    }
