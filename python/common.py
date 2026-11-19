import os
import json
import cv2
import numpy as np
from PIL import Image, ImageOps
import tensorflow as tf

DEFAULT_IMG_SIZE = (224, 224)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(BASE_DIR, "model")
CALIBRATION_PATH = os.path.join(MODEL_DIR, "calibration.json")
LABELS_PATH = os.path.join(MODEL_DIR, "labels.json")


def load_calibration():
    """Load saved calibration parameters (temperature, img_size, tta)."""
    defaults = {
        "temperature": 1.0,
        "img_size": list(DEFAULT_IMG_SIZE),
        "tta": True
    }
    if os.path.exists(CALIBRATION_PATH):
        try:
            with open(CALIBRATION_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                defaults.update(data)
        except Exception:
            pass
    return defaults


def load_labels():
    """Load class labels in exact index order used during training."""
    if os.path.exists(LABELS_PATH):
        with open(LABELS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return ["angular_leaf_spot", "bean_rust", "healthy"]


def load_image_rgb(image_path):
    """Load an image file as RGB uint8 numpy array (H, W, 3) with EXIF orientation applied."""
    with Image.open(image_path) as pil_img:
        pil_img = ImageOps.exif_transpose(pil_img)
        img_rgb = pil_img.convert("RGB")
        return np.array(img_rgb, dtype=np.uint8)


def preprocess_rgb_array(img_rgb, img_size=DEFAULT_IMG_SIZE):
    """
    Shared preprocessing for both training evaluation and live prediction.
    Input: RGB uint8/float32 array of shape (H, W, 3) or (N, H, W, 3) in [0, 255].
    Output: float32 tensor/array resized to img_size and scaled to [-1, 1] via MobileNetV2 preprocess_input.
    """
    arr = tf.convert_to_tensor(img_rgb, dtype=tf.float32)
    single = (len(arr.shape) == 3)
    if single:
        arr = tf.expand_dims(arr, axis=0)

    target_h, target_w = int(img_size[0]), int(img_size[1])
    if arr.shape[1] != target_h or arr.shape[2] != target_w:
        arr = tf.image.resize(arr, (target_h, target_w), method="bilinear")

    # MobileNetV2 expects inputs in [-1, 1] from [0, 255] (no double rescaling)
    arr = tf.keras.applications.mobilenet_v2.preprocess_input(arr)
    return arr.numpy()


def prepare_inference_batch(orig_rgb, img_size=DEFAULT_IMG_SIZE, use_tta=True):
    """
    Prepare preprocessed batch for inference.
    If use_tta=True, returns batch of 2: [original, horizontal_flip].
    Uses exact same TF bilinear resize & MobileNetV2 preprocess_input as training/eval.
    """
    orig_proc = preprocess_rgb_array(orig_rgb, img_size=img_size)
    if use_tta:
        flipped = np.ascontiguousarray(orig_rgb[:, ::-1, :])
        flip_proc = preprocess_rgb_array(flipped, img_size=img_size)
        return np.concatenate([orig_proc, flip_proc], axis=0)
    return orig_proc


def apply_temperature_scaling(probs, temperature=1.0):
    """
    Apply temperature scaling to softmax probability vector(s).
    Mathematically identical to softmax(logits / T) since log(softmax(z)) = z - const.
    """
    probs = np.asarray(probs, dtype=np.float64)
    eps = 1e-7
    clipped = np.clip(probs, eps, 1.0)
    log_probs = np.log(clipped)
    scaled = log_probs / max(float(temperature), 1e-4)
    # Numerically stable softmax
    scaled = scaled - np.max(scaled, axis=-1, keepdims=True)
    exp_s = np.exp(scaled)
    return exp_s / np.sum(exp_s, axis=-1, keepdims=True)


def prediction_entropy(probs):
    """Compute normalized Shannon entropy in [0, 1] (0 = certain, 1 = uniform)."""
    probs = np.asarray(probs, dtype=np.float64)
    probs = np.clip(probs, 1e-9, 1.0)
    h = -np.sum(probs * np.log(probs))
    max_h = np.log(len(probs))
    return float(h / max_h) if max_h > 0 else 0.0


def check_is_leaf(orig_rgb):
    """
    Lightweight plant/leaf check in HSV space + texture variance check.
    Returns (is_leaf: bool, details: dict).
    Verified on all 1,295 iBeans images: min green_ratio=0.096, min plant_ratio=0.141.
    """
    small = cv2.resize(orig_rgb, (160, 160), interpolation=cv2.INTER_AREA)
    color_std = float(np.std(small))

    hsv = cv2.cvtColor(small, cv2.COLOR_RGB2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]

    # Green foliage pixels (OpenCV Hue 0..179 -> 25..95 covers yellow-green to emerald/teal-green)
    green_mask = (h >= 25) & (h <= 95) & (s >= 25) & (v >= 25)
    # Chlorotic yellow-green / brownish-olive diseased leaf tissue
    yellow_green_mask = (h >= 15) & (h < 25) & (s >= 35) & (v >= 35)

    green_ratio = float(np.mean(green_mask))
    plant_ratio = float(np.mean(green_mask | yellow_green_mask))

    # Reject flat solid colors (even solid green) or images with very little plant color
    is_solid = color_std < 6.0
    is_leaf = (not is_solid) and (green_ratio >= 0.07) and (plant_ratio >= 0.11)

    return is_leaf, {
        "green_ratio": round(green_ratio, 4),
        "plant_ratio": round(plant_ratio, 4),
        "color_std": round(color_std, 2)
    }


def evaluate_uncertainty(calibrated_probs, conf_threshold=70.0, gap_threshold=15.0, entropy_threshold=0.72):
    """
    Evaluate whether a prediction is confident or uncertain.
    calibrated_probs: 1D array of probabilities summing to 1.0.
    Returns (is_uncertain: bool, reason: str or None, metrics: dict)
    """
    sorted_probs = np.sort(calibrated_probs)[::-1]
    top1_pct = float(sorted_probs[0]) * 100.0
    top2_pct = float(sorted_probs[1]) * 100.0 if len(sorted_probs) > 1 else 0.0
    gap_pct = top1_pct - top2_pct
    norm_entropy = prediction_entropy(calibrated_probs)

    reasons = []
    if top1_pct < conf_threshold:
        reasons.append(f"confidence {top1_pct:.1f}% < {conf_threshold:.0f}%")
    if gap_pct < gap_threshold:
        reasons.append(f"top-2 margin {gap_pct:.1f}% < {gap_threshold:.0f}%")
    if norm_entropy > entropy_threshold:
        reasons.append(f"entropy {norm_entropy:.2f} > {entropy_threshold:.2f}")

    return len(reasons) > 0, ("; ".join(reasons) if reasons else None), {
        "top1_pct": round(top1_pct, 2),
        "gap_pct": round(gap_pct, 2),
        "normalized_entropy": round(norm_entropy, 4)
    }
