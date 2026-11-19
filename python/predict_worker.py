import os
import sys
import json
import numpy as np
from PIL import Image

os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
import tensorflow as tf

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from common import (
    load_calibration,
    load_labels,
    load_image_rgb,
    prepare_inference_batch,
    apply_temperature_scaling,
    check_is_leaf,
    evaluate_uncertainty,
)
from gradcam import (
    make_gradcam_heatmap,
    overlay_gradcam,
    image_to_base64_png,
    find_last_conv_layer,
    build_grad_model,
    analyze_lesion_and_contours,
)

BASE_DIR = os.path.dirname(SCRIPT_DIR)
MODEL_PATH = os.path.join(BASE_DIR, "model", "model.keras")

UNCERTAIN_MESSAGE = "Not confident. Please upload a clear, close-up photo of a single bean leaf."
NOT_A_LEAF_MESSAGE = "This image does not appear to be a bean leaf. Please upload a clear, close-up photo of a single bean leaf."


def main():
    if not os.path.exists(MODEL_PATH):
        sys.stderr.write(f"Model file not found at {MODEL_PATH}\n")
        sys.stderr.flush()
        sys.exit(1)

    labels = load_labels()
    calibration = load_calibration()
    img_size = tuple(calibration.get("img_size", [224, 224]))
    temperature = float(calibration.get("temperature", 1.0))
    use_tta = bool(calibration.get("tta", True))

    try:
        model = tf.keras.models.load_model(MODEL_PATH)
    except Exception as e:
        sys.stderr.write(f"Error loading model: {e}\n")
        sys.stderr.flush()
        sys.exit(1)

    target_layer_name = find_last_conv_layer(model)
    grad_model = build_grad_model(model, last_conv_layer_name=target_layer_name)

    # Warmup inference & Grad-CAM graph
    dummy_input = np.zeros((1, img_size[0], img_size[1], 3), dtype=np.float32)
    _ = model(dummy_input, training=False)
    _ = grad_model(dummy_input, training=False)

    sys.stdout.write(json.dumps({
        "status": "ready",
        "labels": labels,
        "target_layer": target_layer_name,
        "img_size": list(img_size),
        "temperature": temperature,
        "tta": use_tta
    }) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            image_path = req.get("image_path")

            if not image_path or not os.path.exists(image_path):
                sys.stdout.write(json.dumps({"status": "error", "error": "Image file not found"}) + "\n")
                sys.stdout.flush()
                continue

            orig_rgb = load_image_rgb(image_path)

            # 1. Leaf visual sanity check
            is_leaf, leaf_stats = check_is_leaf(orig_rgb)
            if not is_leaf:
                sys.stdout.write(json.dumps({
                    "status": "not_a_leaf",
                    "message": NOT_A_LEAF_MESSAGE,
                    "leaf_check": leaf_stats
                }) + "\n")
                sys.stdout.flush()
                continue

            # 2. Shared preprocessing + Test-Time Augmentation (orig + horizontal flip)
            batch = prepare_inference_batch(orig_rgb, img_size=img_size, use_tta=use_tta)
            raw_preds = model(batch, training=False).numpy()
            mean_raw_probs = np.mean(raw_preds, axis=0)

            # TTA agreement telemetry (purely observational)
            if len(raw_preds) >= 2:
                orig_top_idx = int(np.argmax(raw_preds[0]))
                flip_top_idx = int(np.argmax(raw_preds[1]))
                tta_agreement = {
                    "original_top": labels[orig_top_idx] if orig_top_idx < len(labels) else str(orig_top_idx),
                    "flipped_top": labels[flip_top_idx] if flip_top_idx < len(labels) else str(flip_top_idx),
                    "agree": orig_top_idx == flip_top_idx,
                    "max_delta_pct": round(float(np.max(np.abs(raw_preds[0] - raw_preds[1])) * 100.0), 2)
                }
            else:
                tta_agreement = {"original_top": None, "flipped_top": None, "agree": True, "max_delta_pct": 0.0}

            raw_probabilities = {
                labels[i]: round(float(mean_raw_probs[i]) * 100.0, 2)
                for i in range(min(len(labels), len(mean_raw_probs)))
            }

            # 3. Temperature-scaled calibrated probabilities
            cal_probs = apply_temperature_scaling(mean_raw_probs, temperature=temperature)

            top_idx = int(np.argmax(cal_probs))
            confidence = float(cal_probs[top_idx]) * 100.0
            predicted_class = labels[top_idx] if top_idx < len(labels) else f"class_{top_idx}"

            probabilities = {
                labels[i]: round(float(cal_probs[i]) * 100.0, 2)
                for i in range(min(len(labels), len(cal_probs)))
            }

            # 4. Uncertainty check (confidence < 70%, gap < 15pts, or high entropy)
            is_uncertain, reason, unc_metrics = evaluate_uncertainty(
                cal_probs,
                conf_threshold=70.0,
                gap_threshold=15.0,
                entropy_threshold=0.72
            )

            if is_uncertain:
                sys.stdout.write(json.dumps({
                    "status": "uncertain",
                    "message": UNCERTAIN_MESSAGE,
                    "reason": reason,
                    "uncertainty": unc_metrics,
                    "probabilities": probabilities,
                    "top_candidate": predicted_class,
                    "leaf_check": leaf_stats
                }) + "\n")
                sys.stdout.flush()
                continue

            # 5. Generate Grad-CAM heatmap on original orientation preprocessed image (does not alter predictions)
            heatmap = make_gradcam_heatmap(
                batch[0:1],
                model,
                last_conv_layer_name=target_layer_name,
                pred_index=top_idx,
                grad_model=grad_model
            )

            # Resize display image if huge for fast PNG encoding
            max_dim = max(orig_rgb.shape[0], orig_rgb.shape[1])
            if max_dim > 600:
                scale = 600.0 / max_dim
                new_w = int(orig_rgb.shape[1] * scale)
                new_h = int(orig_rgb.shape[0] * scale)
                display_np = np.array(Image.fromarray(orig_rgb).resize((new_w, new_h), Image.Resampling.BILINEAR))
            else:
                display_np = orig_rgb

            overlaid_rgb, heatmap_rgb = overlay_gradcam(display_np, heatmap, alpha=0.5)
            gradcam_b64 = image_to_base64_png(overlaid_rgb)
            heatmap_b64 = image_to_base64_png(heatmap_rgb)

            # 6. Additive Lesion Quantification & Contour Overlay (never alters predictions)
            lesion_info = analyze_lesion_and_contours(display_np, heatmap, predicted_class)
            contour_b64 = image_to_base64_png(lesion_info["contour_rgb"])

            response = {
                "status": "success",
                "predicted_class": predicted_class,
                "confidence": round(confidence, 2),
                "probabilities": probabilities,
                "raw_probabilities": raw_probabilities,
                "temperature": temperature,
                "tta_agreement": tta_agreement,
                "infected_area_pct": lesion_info["infected_area_pct"],
                "severity_stage": lesion_info["severity_stage"],
                "action_threshold": lesion_info["action_threshold"],
                "gradcam_base64": gradcam_b64,
                "heatmap_base64": heatmap_b64,
                "contour_base64": contour_b64,
                "uncertainty": unc_metrics,
                "leaf_check": leaf_stats
            }
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()

        except Exception as e:
            sys.stdout.write(json.dumps({"status": "error", "error": str(e)}) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
