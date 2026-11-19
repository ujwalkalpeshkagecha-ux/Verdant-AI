import os
import sys
import json
import time
import hashlib
import zipfile
import shutil
import argparse
import requests
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from PIL import Image
from scipy.optimize import minimize_scalar
from sklearn.metrics import classification_report, confusion_matrix, log_loss
from sklearn.utils.class_weight import compute_class_weight

os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'
import tensorflow as tf

# Ensure local python/ imports work whether run from root or python/
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from common import (
    DEFAULT_IMG_SIZE,
    load_image_rgb,
    preprocess_rgb_array,
    prepare_inference_batch,
    apply_temperature_scaling,
)
from gradcam import make_gradcam_heatmap, overlay_gradcam, build_grad_model, find_last_conv_layer

BASE_DIR = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(BASE_DIR, "data")
MODEL_DIR = os.path.join(BASE_DIR, "model")
RESULTS_DIR = os.path.join(BASE_DIR, "results")
SAMPLES_DIR = os.path.join(BASE_DIR, "samples")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(MODEL_DIR, exist_ok=True)
os.makedirs(RESULTS_DIR, exist_ok=True)
os.makedirs(SAMPLES_DIR, exist_ok=True)

CLASSES = ["angular_leaf_spot", "bean_rust", "healthy"]


def download_file(url, target_path):
    print(f"Downloading {url} ...")
    resp = requests.get(url, stream=True, timeout=60)
    resp.raise_for_status()
    with open(target_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1024 * 1024):
            if chunk:
                f.write(chunk)
    print(f"Saved to {target_path} ({os.path.getsize(target_path):,} bytes)")


def ensure_dataset():
    splits = ["train", "validation", "test"]
    needed = False
    for s in splits:
        split_dir = os.path.join(DATA_DIR, s)
        if not os.path.exists(split_dir) or len(os.listdir(split_dir)) == 0:
            needed = True
            break

    if not needed:
        print("[DATA] Dataset already present in /data.")
        return

    print("[DATA] Downloading iBeans dataset...")
    urls_primary = {
        "train": "https://storage.googleapis.com/ibeans/train.zip",
        "validation": "https://storage.googleapis.com/ibeans/validation.zip",
        "test": "https://storage.googleapis.com/ibeans/test.zip"
    }
    urls_hf = {
        "train": "https://huggingface.co/datasets/beans/resolve/main/data/train.zip",
        "validation": "https://huggingface.co/datasets/beans/resolve/main/data/validation.zip",
        "test": "https://huggingface.co/datasets/beans/resolve/main/data/test.zip"
    }

    for split in splits:
        zip_path = os.path.join(DATA_DIR, f"{split}.zip")
        downloaded = False
        try:
            download_file(urls_primary[split], zip_path)
            downloaded = True
        except Exception as e:
            print(f"Primary URL failed for {split}: {e}. Trying HuggingFace mirror...")
            try:
                download_file(urls_hf[split], zip_path)
                downloaded = True
            except Exception as e2:
                print(f"HuggingFace mirror failed for {split}: {e2}.")

        if not downloaded:
            print("[DATA] Fallback to tensorflow_datasets 'beans'...")
            import tensorflow_datasets as tfds
            ds_dict = tfds.load("beans", split=["train", "validation", "test"], as_supervised=True)
            for split_name, ds in zip(["train", "validation", "test"], ds_dict):
                for idx, (img_tensor, label_tensor) in enumerate(ds):
                    label_name = CLASSES[int(label_tensor.numpy())]
                    target_folder = os.path.join(DATA_DIR, split_name, label_name)
                    os.makedirs(target_folder, exist_ok=True)
                    Image.fromarray(img_tensor.numpy()).save(
                        os.path.join(target_folder, f"{split_name}_{idx}.jpg")
                    )
            print("[DATA] Saved beans from tfds into /data successfully.")
            return

        print(f"Extracting {zip_path}...")
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(DATA_DIR)

        split_dir = os.path.join(DATA_DIR, split)
        nested_dir = os.path.join(split_dir, split)
        if os.path.exists(nested_dir):
            for c in os.listdir(nested_dir):
                shutil.move(os.path.join(nested_dir, c), split_dir)
            shutil.rmtree(nested_dir)

        try:
            os.remove(zip_path)
        except Exception:
            pass

    print("[DATA] Dataset extraction complete.")


def verify_splits_and_counts():
    """Verify split counts, stratification, and assert zero leakage across train/val/test."""
    splits = ["train", "validation", "test"]
    split_hashes = {}
    split_counts = {}

    for s in splits:
        s_dir = os.path.join(DATA_DIR, s)
        counts = {}
        hashes = set()
        for cls in sorted(os.listdir(s_dir)):
            c_dir = os.path.join(s_dir, cls)
            if not os.path.isdir(c_dir):
                continue
            files = sorted([f for f in os.listdir(c_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))])
            counts[cls] = len(files)
            for fname in files:
                with open(os.path.join(c_dir, fname), "rb") as fp:
                    hashes.add(hashlib.md5(fp.read()).hexdigest())
        split_counts[s] = counts
        split_hashes[s] = hashes
        print(f"[DATA] {s.upper()} (total={sum(counts.values())}): {counts}")

    for i in range(len(splits)):
        for j in range(i + 1, len(splits)):
            s1, s2 = splits[i], splits[j]
            overlap = len(split_hashes[s1] & split_hashes[s2])
            if overlap > 0:
                raise RuntimeError(f"Data leakage detected! {overlap} duplicate images between {s1} and {s2}.")
    print("[DATA] Verified 0 image overlap between train, validation, and test splits.")
    return split_counts


def populate_samples():
    print("[SAMPLES] Ensuring 6 sample images in /samples...")
    test_dir = os.path.join(DATA_DIR, "test")
    count_per_class = 2
    for cls in CLASSES:
        cls_dir = os.path.join(test_dir, cls)
        if not os.path.exists(cls_dir):
            continue
        files = sorted([f for f in os.listdir(cls_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))])
        for i in range(min(count_per_class, len(files))):
            src = os.path.join(cls_dir, files[i])
            dst = os.path.join(SAMPLES_DIR, f"sample_{cls}_{i+1}.jpg")
            shutil.copyfile(src, dst)


def collect_split_files(split_dir, class_names):
    """Return sorted list of (file_path, label_idx) for a split directory."""
    items = []
    for idx, cls in enumerate(class_names):
        c_dir = os.path.join(split_dir, cls)
        if not os.path.isdir(c_dir):
            continue
        files = sorted([f for f in os.listdir(c_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))])
        for fname in files:
            items.append((os.path.join(c_dir, fname), idx))
    return items


def build_model(img_size=(224, 224), num_classes=3):
    base_model = tf.keras.applications.MobileNetV2(
        input_shape=(img_size[0], img_size[1], 3),
        include_top=False,
        weights="imagenet"
    )
    base_model.trainable = False

    x = base_model.output
    x = tf.keras.layers.GlobalAveragePooling2D(name="gap")(x)
    x = tf.keras.layers.Dropout(0.3, name="dropout")(x)
    outputs = tf.keras.layers.Dense(num_classes, activation="softmax", name="predictions")(x)

    model = tf.keras.Model(inputs=base_model.input, outputs=outputs, name="verdant_ai_leafscan")
    return model, base_model


def predict_split_with_common(model, items, img_size, use_tta=True):
    """Run predictions on file items using the EXACT same python/common.py preprocessing as predict_worker.py."""
    all_probs = []
    all_labels = []
    for fpath, label_idx in items:
        orig_rgb = load_image_rgb(fpath)
        batch = prepare_inference_batch(orig_rgb, img_size=img_size, use_tta=use_tta)
        preds = model(batch, training=False).numpy()
        mean_prob = np.mean(preds, axis=0)
        all_probs.append(mean_prob)
        all_labels.append(label_idx)
    return np.array(all_probs, dtype=np.float64), np.array(all_labels, dtype=np.int64)


def safe_log_loss(y_true, probs):
    p = np.clip(probs, 1e-7, 1.0)
    p = p / np.sum(p, axis=1, keepdims=True)
    return float(log_loss(y_true, p, labels=list(range(p.shape[1]))))


def fit_temperature(val_probs, val_labels):
    """Fit temperature scaling scalar T on validation set minimizing cross-entropy (NLL)."""
    nll_before = safe_log_loss(val_labels, val_probs)

    def objective(temp):
        cal_p = apply_temperature_scaling(val_probs, temperature=temp)
        return safe_log_loss(val_labels, cal_p)

    res = minimize_scalar(objective, bounds=(0.15, 5.0), method="bounded")
    best_t = float(res.x)
    nll_after = float(res.fun)
    print(f"[CALIBRATION] Temperature T = {best_t:.4f} | Val NLL: {nll_before:.4f} -> {nll_after:.4f}")
    return best_t, float(nll_before), nll_after


def main():
    parser = argparse.ArgumentParser(description="Train Verdant AI MobileNetV2 Bean Disease Classifier")
    parser.add_argument("--img-size", type=int, default=256, help="Square image input size (e.g. 224 or 256)")
    parser.add_argument("--unfreeze", type=int, default=55, help="Number of top MobileNetV2 layers to fine-tune")
    parser.add_argument("--epochs-p1", type=int, default=10, help="Phase 1 epochs (frozen base)")
    parser.add_argument("--epochs-p2", type=int, default=14, help="Phase 2 epochs (fine-tuning)")
    parser.add_argument("--lr-p2", type=float, default=3e-5, help="Phase 2 learning rate")
    args = parser.parse_args()

    t_start = time.time()
    tf.keras.utils.set_random_seed(42)

    img_size = (args.img_size, args.img_size)
    batch_size = 32

    ensure_dataset()
    verify_splits_and_counts()
    populate_samples()

    train_dir = os.path.join(DATA_DIR, "train")
    val_dir = os.path.join(DATA_DIR, "validation")
    test_dir = os.path.join(DATA_DIR, "test")

    print(f"[TRAIN] Loading datasets at {img_size} ...")
    train_ds_raw = tf.keras.utils.image_dataset_from_directory(
        train_dir,
        image_size=img_size,
        batch_size=batch_size,
        label_mode="categorical",
        shuffle=True,
        seed=42
    )
    val_ds_raw = tf.keras.utils.image_dataset_from_directory(
        val_dir,
        image_size=img_size,
        batch_size=batch_size,
        label_mode="categorical",
        shuffle=False
    )

    class_names = train_ds_raw.class_names
    print(f"[TRAIN] Class names ({len(class_names)}): {class_names}")

    labels_file = os.path.join(MODEL_DIR, "labels.json")
    with open(labels_file, "w", encoding="utf-8") as f:
        json.dump(class_names, f, indent=2)
    print(f"[MODEL] Saved labels to {labels_file}")

    # Compute balanced class weights from training set
    train_items = collect_split_files(train_dir, class_names)
    val_items = collect_split_files(val_dir, class_names)
    test_items = collect_split_files(test_dir, class_names)

    y_train_int = np.array([lbl for _, lbl in train_items])
    weights = compute_class_weight(class_weight="balanced", classes=np.arange(len(class_names)), y=y_train_int)
    class_weight_dict = {i: float(w) for i, w in enumerate(weights)}
    print(f"[TRAIN] Balanced class weights: {class_weight_dict}")

    # Rich realistic augmentation applied in [0, 255] BEFORE MobileNetV2 preprocess_input
    # factor=0.06 corresponds to +/- 21.6 degrees (~20 deg)
    augmentation = tf.keras.Sequential([
        tf.keras.layers.RandomFlip("horizontal_and_vertical"),
        tf.keras.layers.RandomRotation(0.06),
        tf.keras.layers.RandomZoom(0.12),
        tf.keras.layers.RandomTranslation(0.08, 0.08),
        tf.keras.layers.RandomBrightness(0.15, value_range=(0.0, 255.0)),
        tf.keras.layers.RandomContrast(0.15),
    ], name="augmentation")

    def preprocess_train(x, y):
        x = augmentation(x, training=True)
        x = tf.clip_by_value(x, 0.0, 255.0)
        x = tf.keras.applications.mobilenet_v2.preprocess_input(x)
        return x, y

    def preprocess_eval(x, y):
        x = tf.keras.applications.mobilenet_v2.preprocess_input(x)
        return x, y

    train_ds = train_ds_raw.map(preprocess_train, num_parallel_calls=tf.data.AUTOTUNE).prefetch(tf.data.AUTOTUNE)
    val_ds = val_ds_raw.map(preprocess_eval, num_parallel_calls=tf.data.AUTOTUNE).prefetch(tf.data.AUTOTUNE)

    model_save_path = os.path.join(MODEL_DIR, "model.keras")
    loss_fn = tf.keras.losses.CategoricalCrossentropy(label_smoothing=0.1)

    model, base_model = build_model(img_size=img_size, num_classes=len(class_names))
    model.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=1e-3),
        loss=loss_fn,
        metrics=["accuracy"]
    )

    print("\n========================================================")
    print(f" PHASE 1: Frozen MobileNetV2 Base (up to {args.epochs_p1} epochs, lr=1e-3)")
    print("========================================================")
    cb_p1 = [
        tf.keras.callbacks.EarlyStopping(monitor="val_loss", patience=4, restore_best_weights=True, verbose=1),
        tf.keras.callbacks.ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=2, min_lr=1e-5, verbose=1),
        tf.keras.callbacks.ModelCheckpoint(
            filepath=model_save_path,
            monitor="val_accuracy",
            mode="max",
            save_best_only=True,
            verbose=1
        )
    ]

    history_p1 = model.fit(
        train_ds,
        validation_data=val_ds,
        epochs=args.epochs_p1,
        class_weight=class_weight_dict,
        callbacks=cb_p1,
        verbose=1
    )
    best_p1_val_acc = max(history_p1.history["val_accuracy"])
    print(f"[PHASE 1] Best validation accuracy: {best_p1_val_acc * 100:.2f}%")

    print("\n========================================================")
    print(f" PHASE 2: Fine-Tune Top {args.unfreeze} Layers (BN Frozen, up to {args.epochs_p2} epochs, lr={args.lr_p2})")
    print("========================================================")
    base_model.trainable = True
    for layer in base_model.layers[:-args.unfreeze]:
        layer.trainable = False
    # CRITICAL: Keep all BatchNormalization layers frozen during fine-tuning
    frozen_bn = 0
    trainable_conv = 0
    for layer in base_model.layers:
        if isinstance(layer, tf.keras.layers.BatchNormalization):
            layer.trainable = False
            frozen_bn += 1
        elif layer.trainable:
            trainable_conv += 1
    print(f"[PHASE 2] Trainable base layers: {trainable_conv} | Frozen BatchNorm layers: {frozen_bn}")

    model.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=args.lr_p2),
        loss=loss_fn,
        metrics=["accuracy"]
    )

    cb_p2 = [
        tf.keras.callbacks.EarlyStopping(monitor="val_loss", patience=4, restore_best_weights=True, verbose=1),
        tf.keras.callbacks.ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=2, min_lr=1e-6, verbose=1),
        tf.keras.callbacks.ModelCheckpoint(
            filepath=model_save_path,
            monitor="val_accuracy",
            mode="max",
            save_best_only=True,
            initial_value_threshold=best_p1_val_acc,
            verbose=1
        )
    ]

    history_p2 = model.fit(
        train_ds,
        validation_data=val_ds,
        epochs=args.epochs_p2,
        class_weight=class_weight_dict,
        callbacks=cb_p2,
        verbose=1
    )

    # Load best checkpoint saved on val_accuracy
    print(f"\n[MODEL] Loading best checkpoint from {model_save_path} for calibration & test evaluation...")
    best_model = tf.keras.models.load_model(model_save_path)

    # Fit temperature scaling on VALIDATION set (using TTA to match predict_worker.py)
    print("\n========================================================")
    print(" CALIBRATION: Fitting Temperature Scaling on Validation Set")
    print("========================================================")
    val_probs_tta, val_y_true = predict_split_with_common(best_model, val_items, img_size=img_size, use_tta=True)
    val_acc_tta = float(np.mean(np.argmax(val_probs_tta, axis=1) == val_y_true))
    print(f"[CALIBRATION] Validation Accuracy (with TTA): {val_acc_tta * 100:.2f}%")
    temperature, val_nll_before, val_nll_after = fit_temperature(val_probs_tta, val_y_true)

    calibration_data = {
        "temperature": round(temperature, 4),
        "img_size": [img_size[0], img_size[1]],
        "tta": True,
        "val_accuracy_tta": round(val_acc_tta * 100.0, 2),
        "val_nll_before": round(val_nll_before, 4),
        "val_nll_after": round(val_nll_after, 4)
    }
    cal_path = os.path.join(MODEL_DIR, "calibration.json")
    with open(cal_path, "w", encoding="utf-8") as f:
        json.dump(calibration_data, f, indent=2)
    print(f"[CALIBRATION] Saved calibration to {cal_path}")

    # Evaluate ONLY on HELD-OUT TEST SET using exact common.py pipeline
    print("\n========================================================")
    print(" FINAL EVALUATION ON HELD-OUT TEST SET (128 images)")
    print("========================================================")
    test_probs_raw, y_true = predict_split_with_common(best_model, test_items, img_size=img_size, use_tta=False)
    raw_acc = float(np.mean(np.argmax(test_probs_raw, axis=1) == y_true))

    test_probs_tta, _ = predict_split_with_common(best_model, test_items, img_size=img_size, use_tta=True)
    test_probs_cal = apply_temperature_scaling(test_probs_tta, temperature=temperature)
    y_pred = np.argmax(test_probs_cal, axis=1)

    test_acc = float(np.mean(y_pred == y_true))
    test_nll = safe_log_loss(y_true, test_probs_cal)

    print(f"Held-out Test Accuracy (Single-Pass): {raw_acc * 100:.2f}%")
    print(f"Held-out Test Accuracy (TTA + Calib): {test_acc * 100:.2f}%  |  Calibrated NLL: {test_nll:.4f}")

    clf_report = classification_report(y_true, y_pred, target_names=class_names, output_dict=True)
    clf_report_text = classification_report(y_true, y_pred, target_names=class_names)
    print("\nHeld-Out Test Classification Report:\n" + clf_report_text)

    cm = confusion_matrix(y_true, y_pred)
    print("Held-Out Test Confusion Matrix:\n", cm)

    with open(os.path.join(RESULTS_DIR, "classification_report.txt"), "w", encoding="utf-8") as f:
        f.write(clf_report_text)

    # Save Confusion Matrix image
    plt.figure(figsize=(6, 5))
    plt.imshow(cm, interpolation='nearest', cmap=plt.cm.Greens)
    plt.title(f"Verdant AI - Test Confusion Matrix ({test_acc*100:.2f}%)", fontsize=13, pad=12, color='#111111')
    plt.colorbar()
    tick_marks = np.arange(len(class_names))
    plt.xticks(tick_marks, class_names, rotation=30, ha='right', fontsize=10)
    plt.yticks(tick_marks, class_names, fontsize=10)
    thresh = cm.max() / 2.0
    for i in range(cm.shape[0]):
        for j in range(cm.shape[1]):
            plt.text(j, i, format(cm[i, j], 'd'),
                     ha="center", va="center",
                     color="white" if cm[i, j] > thresh else "black",
                     fontweight='bold', fontsize=12)
    plt.tight_layout()
    plt.ylabel('True Class', fontsize=11)
    plt.xlabel('Predicted Class', fontsize=11)
    plt.savefig(os.path.join(RESULTS_DIR, "confusion_matrix.png"), dpi=200, bbox_inches='tight')
    plt.close()

    # Save Accuracy / Loss Curves
    p1_len = len(history_p1.history['accuracy'])
    acc = history_p1.history['accuracy'] + history_p2.history['accuracy']
    val_acc = history_p1.history['val_accuracy'] + history_p2.history['val_accuracy']
    loss = history_p1.history['loss'] + history_p2.history['loss']
    val_loss = history_p1.history['val_loss'] + history_p2.history['val_loss']
    epochs_range = range(1, len(acc) + 1)

    plt.figure(figsize=(12, 5))
    plt.subplot(1, 2, 1)
    plt.plot(epochs_range, acc, label='Training Accuracy', color='#10b981', linewidth=2.5)
    plt.plot(epochs_range, val_acc, label='Validation Accuracy', color='#06b6d4', linewidth=2.5, linestyle='--')
    plt.axvline(x=p1_len, color='#ef4444', linestyle=':', label='Fine-Tuning Start')
    plt.title('Training & Validation Accuracy', fontsize=12, fontweight='bold')
    plt.xlabel('Epoch')
    plt.ylabel('Accuracy')
    plt.legend(loc='lower right')
    plt.grid(True, alpha=0.3)

    plt.subplot(1, 2, 2)
    plt.plot(epochs_range, loss, label='Training Loss', color='#f59e0b', linewidth=2.5)
    plt.plot(epochs_range, val_loss, label='Validation Loss', color='#ec4899', linewidth=2.5, linestyle='--')
    plt.axvline(x=p1_len, color='#ef4444', linestyle=':', label='Fine-Tuning Start')
    plt.title('Training & Validation Loss', fontsize=12, fontweight='bold')
    plt.xlabel('Epoch')
    plt.ylabel('Loss')
    plt.legend(loc='upper right')
    plt.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig(os.path.join(RESULTS_DIR, "accuracy_loss_curves.png"), dpi=200, bbox_inches='tight')
    plt.close()

    # Save Metrics JSON (held-out test set ONLY)
    metrics = {
        "accuracy": round(test_acc * 100.0, 2),
        "raw_test_accuracy": round(raw_acc * 100.0, 2),
        "test_loss": round(test_nll, 4),
        "temperature": round(temperature, 4),
        "img_size": [img_size[0], img_size[1]],
        "test_samples": int(len(y_true)),
        "classes": {},
        "macro_avg": {
            "precision": round(clf_report["macro avg"]["precision"] * 100.0, 2),
            "recall": round(clf_report["macro avg"]["recall"] * 100.0, 2),
            "f1_score": round(clf_report["macro avg"]["f1-score"] * 100.0, 2),
        },
        "confusion_matrix": {
            "labels": class_names,
            "matrix": cm.tolist()
        }
    }
    for cls in class_names:
        if cls in clf_report:
            metrics["classes"][cls] = {
                "precision": round(clf_report[cls]["precision"] * 100.0, 2),
                "recall": round(clf_report[cls]["recall"] * 100.0, 2),
                "f1_score": round(clf_report[cls]["f1-score"] * 100.0, 2),
                "support": int(clf_report[cls]["support"])
            }

    metrics_path = os.path.join(RESULTS_DIR, "metrics.json")
    with open(metrics_path, "w", encoding="utf-8") as f:
        json.dump(metrics, f, indent=2)
    print(f"[RESULTS] Saved metrics.json to {metrics_path}")

    # Generate 4 Grad-CAM examples (one from each class + 1 extra)
    print("[RESULTS] Generating 4 Grad-CAM example images...")
    grad_model = build_grad_model(best_model, last_conv_layer_name=find_last_conv_layer(best_model))
    sample_files = []
    for cls in class_names:
        c_dir = os.path.join(test_dir, cls)
        files = sorted([f for f in os.listdir(c_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))])
        if files:
            sample_files.append((os.path.join(c_dir, files[0]), cls))
    # Add 4th sample from bean_rust or angular_leaf_spot
    c_dir = os.path.join(test_dir, class_names[0])
    files = sorted([f for f in os.listdir(c_dir) if f.lower().endswith(('.jpg', '.jpeg', '.png'))])
    if len(files) > 1:
        sample_files.append((os.path.join(c_dir, files[1]), class_names[0]))

    for idx, (img_path, true_cls) in enumerate(sample_files[:4]):
        orig_rgb = load_image_rgb(img_path)
        tta_batch = prepare_inference_batch(orig_rgb, img_size=img_size, use_tta=True)
        raw_p = np.mean(best_model(tta_batch, training=False).numpy(), axis=0)
        cal_p = apply_temperature_scaling(raw_p, temperature=temperature)
        pred_idx = int(np.argmax(cal_p))
        pred_label = class_names[pred_idx]
        conf = float(cal_p[pred_idx]) * 100.0

        hm = make_gradcam_heatmap(tta_batch[0:1], best_model, pred_index=pred_idx, grad_model=grad_model)
        overlaid, _ = overlay_gradcam(orig_rgb, hm, alpha=0.5)

        fig, axes = plt.subplots(1, 2, figsize=(8, 4))
        axes[0].imshow(orig_rgb)
        axes[0].set_title(f"True: {true_cls}", fontsize=11, fontweight='bold')
        axes[0].axis('off')
        axes[1].imshow(overlaid)
        axes[1].set_title(f"Pred: {pred_label} ({conf:.1f}%)", fontsize=11, fontweight='bold', color='#10b981')
        axes[1].axis('off')
        plt.suptitle(f"Grad-CAM Heatmap Analysis #{idx+1}", fontsize=12, y=0.98)
        plt.tight_layout()
        plt.savefig(os.path.join(RESULTS_DIR, f"gradcam_sample_{idx+1}.png"), dpi=180, bbox_inches='tight')
        plt.close()

    elapsed = time.time() - t_start
    print(f"\n[DONE] Total training & evaluation time: {elapsed/60:.2f} minutes")


if __name__ == "__main__":
    main()
