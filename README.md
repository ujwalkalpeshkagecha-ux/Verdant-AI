# Verdant AI — LeafScan 3D 🌿

> **Next-Generation Plant Pathology Vision System**: Classify bean leaf diseases with high accuracy, explainable Grad-CAM saliency heatmaps, and real-time interactive 3D visualizations in Three.js.

[![Accuracy](https://img.shields.io/badge/Test%20Accuracy-94.53%25-34ff9a.svg?style=flat-square)](#model-performance)
[![Inference](https://img.shields.io/badge/Inference%20Latency-%3C1s-b6ff3c.svg?style=flat-square)](#architecture)
[![Stack](https://img.shields.io/badge/Stack-Node.js%20%7C%20TensorFlow%20%7C%20Three.js-00f5ff.svg?style=flat-square)](#architecture)
[![Offline](https://img.shields.io/badge/Frontend-100%25%20Local%20(Zero%20CDN)-success.svg?style=flat-square)](#frontend-design-system)

---

## ⚡ Quick Start: One Command Run

Run everything with a single command from the project root:

```bash
npm start
```

### What `npm start` automatically executes:
1. **Environment Check**: Detects Python 3.10–3.12, creates a clean virtual environment (`.venv`), and installs all required dependencies from `requirements.txt`.
2. **Autonomous Dataset & Training**: If `model/model.keras` is missing, downloads the iBeans dataset (`train.zip`, `validation.zip`, `test.zip`), trains MobileNetV2 with two-phase transfer learning, evaluates on the test set, and exports Grad-CAM validation samples.
3. **Persistent Worker & Web Server**: Spawns the persistent Python inference daemon and starts the Express application at `http://localhost:3000`.

---

## 📁 Project Architecture & Structure

```
Verdant AI/
├── package.json                   # Node dependencies & start script
├── requirements.txt               # Python ML/CV dependencies (TF, OpenCV, etc.)
├── start.js                       # Autonomous runner (venv, train, serve)
├── server.js                      # Express API & persistent Python worker manager
├── README.md                      # Comprehensive documentation & Viva guide
├── model/
│   ├── model.keras                # Saved fine-tuned MobileNetV2 model
│   └── labels.json                # Class labels index mapping
├── python/
│   ├── train.py                   # Data ingestion, augmentation & training pipeline
│   ├── predict_worker.py          # Persistent IPC worker for sub-second inference
│   └── gradcam.py                 # Grad-CAM heatmap & alpha-blend generator
├── data/                          # iBeans dataset (train, validation, test)
├── results/                       # Empirical evaluation & visual artifacts
│   ├── metrics.json               # Accuracy, precision, recall, F1 per class
│   ├── classification_report.txt  # Detailed scikit-learn metrics
│   ├── confusion_matrix.png       # Normalized multi-class confusion matrix
│   ├── accuracy_loss_curves.png   # Training & validation trajectories
│   └── gradcam_sample_*.png       # Benchmark explainability test images
├── samples/                       # 6 validated test specimens (healthy, rust, spot)
└── public/                        # Premium frontend client (100% offline)
    ├── index.html                 # Semantic HTML5 layout (7 sections + modals + drawer)
    ├── css/
    │   └── style.css              # Glassmorphic cinema design system (#BAC8D9, #193940, #9BF272)
    └── js/
        ├── main.js                # Client bootstrap & coordination
        ├── features.js            # Additive field intelligence (Camera, Batch, Logbook, PDF, Risk, Compare, XAI)
        ├── scene3d.js             # Three.js 4-layer leaf dissection & scroll-in camera dolly
        ├── scanner.js             # Drag-and-drop, laser scan, before/after slider
        └── ui.js                  # Lenis smooth scroll, GSAP reveals, custom cursor
```

---

## 🌾 Comprehensive Field Intelligence Features

1. **Live Field Camera Capture**: Native WebRTC viewfinder with leaf alignment reticle and instant inference.
2. **Batch Field Audit Mode**: Multi-leaf evaluation (up to 15 specimens) via `POST /api/predict-batch` with canopy health % summary and worst-affected leaves ranked first.
3. **Infected Area % & Action Threshold**: Computer vision lesion surface quantification, severity staging, and agronomic intervention guidelines.
4. **Local Persistent Field Logbook**: Offline `localStorage` field notebook with thumbnail caching, timestamps, and editable plot notes.
5. **Downloadable Clinical PDF / Print Field Report**: Single-click clinical pathology field reports with embedded base64 imagery, diagnosis, and treatment protocols.
6. **Microclimate Outbreak Risk Calculator**: Agronomic weather simulation (temperature, humidity, leaf wetness hours) for *Pseudocercospora* and *Uromyces* spore propagation with presets (`Dry Sunny`, `Humid Rain`, `Cool Dew`).
7. **Side-by-Side Leaf Comparison Mode**: Interactive comparative pathology comparing baseline vs. follow-up specimens with delta shift quantification.
8. **Explainability Lab (4 Visual Modes + Calibration Telemetry)**: Real-time toggling between `Before / After`, `Grad-CAM Overlay`, `Pure Heatmap`, and `Lesion Contours` alongside live Raw→Calibrated probabilities, top-2 margins, normalized entropy, and TTA flip consistency metrics.

---

## 🔬 Model Performance & Benchmark

Evaluated exclusively on the held-out test split (128 images, zero split overlap) of the **iBeans** benchmark dataset with shared preprocessing (`python/common.py`), Test-Time Augmentation (TTA), and validation-fitted temperature scaling (`T = 0.3924`):

- **Overall Held-Out Test Accuracy**: **94.53%** (121 / 128)
- **Calibrated Test Log-Loss (NLL)**: **0.1406**
- **Input Resolution**: **256×256** RGB (`MobileNetV2` two-phase transfer learning, `BatchNormalization` frozen during fine-tuning)

### Per-Class Metrics (Held-Out Test Set)

| Pathology Class | Precision | Recall | F1-Score | Support |
| :--- | :---: | :---: | :---: | :---: |
| **Angular Leaf Spot** (*Pseudocercospora griseola*) | 89.58% | 100.00% | 94.51% | 43 |
| **Bean Rust** (*Uromyces appendiculatus*) | 97.37% | 86.05% | 91.36% | 43 |
| **Healthy Foliage** (No Pathogens) | 97.62% | 97.62% | 97.62% | 42 |
| **Macro Average** | **94.86%** | **94.56%** | **94.50%** | 128 |

---

## 🖼️ Visual Artifacts & Screenshots

### 1. Training & Validation Trajectories
Located at `results/accuracy_loss_curves.png`:
Demonstrates smooth convergence over Phase 1 (frozen backbone) and Phase 2 (fine-tuning last 20 layers with `Adam(lr=1e-5)` and `EarlyStopping`).

### 2. Multi-Class Confusion Matrix
Located at `results/confusion_matrix.png`:
Illustrates diagonal concentration confirming robust separation between healthy tissue and fungal pustules.

### 3. Grad-CAM Explainability Samples
Located at `results/gradcam_sample_1.png` through `results/gradcam_sample_4.png`:
Visualizes how the convolutional activations specifically align with necrotic chlorotic lesions.

---

## 🎓 Viva & Technical Defense Guide

### 1. Why Transfer Learning?
Agricultural datasets like iBeans contain ~1,200 labeled specimens. Training a deep convolutional neural network from scratch on small datasets leads to severe overfitting and poor generalization. Transfer learning repurposes rich visual representations (edge detection, textural gradients, geometric primitives) learned from over 1.4 million images in ImageNet, adapting only the upper semantic layers to bean foliar pathology.

### 2. Why MobileNetV2?
- **Depthwise Separable Convolutions**: Factorizes standard convolutions into a depthwise spatial filter and a 1x1 pointwise channel projection, slashing parameters to ~2.2M and reducing multiply-accumulate (MAC) operations by ~85%.
- **Inverted Residuals & Linear Bottlenecks**: Expands representations into high-dimensional space for non-linear activations before compressing to linear bottlenecks, preventing non-linearities from destroying manifold information in compressed domains.
- **CPU & Edge Friendly**: Executes in under 50ms on standard CPUs without GPU acceleration.

### 3. Understanding the Confusion Matrix
The confusion matrix maps true class distributions against model predictions:
- **Rows**: Ground-truth labels.
- **Columns**: Model inferences.
- **Diagonal Elements**: True positives for each class.
- Off-diagonal values reveal that any slight misclassification occurs primarily between early-stage angular leaf spot and rust lesions prior to sporulation, while healthy leaves achieve **97.6% recall**.

### 4. What is Grad-CAM (Gradient-Weighted Class Activation Mapping)?
Grad-CAM computes the gradient of the winning class score $y^c$ with respect to the feature map activations $A^k$ of the final convolutional layer (`out_relu`):
$$\alpha_k^c = \frac{1}{Z} \sum_i \sum_j \frac{\partial y^c}{\partial A_{i,j}^k}$$
The activation map is synthesized as a weighted linear combination followed by ReLU:
$$L_{\text{Grad-CAM}}^c = \text{ReLU}\left(\sum_k \alpha_k^c A^k\right)$$
This verifies that the network bases its diagnosis on actual necrotic lesions rather than photographic background artifacts (soil, stems, lighting).

### 5. Overfitting Mitigation Strategy
1. **Targeted Data Augmentation**: Random horizontal and vertical flips, affine rotations ($\pm 15^\circ$), zoom ($\pm 10\%$), and micro-translations prevent spatial memorization.
2. **Dropout Regularization**: A `Dropout(0.3)` layer before final classification prevents co-adaptation of feature detectors.
3. **Two-Stage Learning Rate Schedule**: Phase 1 uses $\eta = 10^{-3}$ with frozen weights; Phase 2 unfreezes only the last 20 layers with a cautious $\eta = 10^{-5}$ coupled with `EarlyStopping(patience=3)` to preserve pretrained weights.

---

## 🌐 API Reference

### `POST /api/predict`
Upload an image via `multipart/form-data` under key `image` (max 5MB).
```json
{
  "status": "success",
  "predicted_class": "healthy",
  "confidence": 91.18,
  "probabilities": {
    "angular_leaf_spot": 8.19,
    "bean_rust": 0.63,
    "healthy": 91.18
  },
  "gradcam_base64": "iVBORw0KGgo...",
  "heatmap_base64": "iVBORw0KGgo...",
  "details": {
    "name": "Healthy Foliage",
    "severity": "Optimal (No Pathogens)",
    "pathogen": "None detected",
    "recommendations": [...]
  },
  "inference_time_ms": 48
}
```

### `GET /api/health`
Returns system status, model availability, and worker state:
```json
{
  "status": "ok",
  "modelReady": true,
  "workerReady": true
}
```

### `GET /api/metrics`
Returns benchmark numbers and static result image paths.

### `GET /api/samples`
Returns 6 pre-configured leaf specimens for instantaneous testing.

---

## 🎨 Frontend Design System
- **Theme**: Deep obsidian-green (`#050807`) with dual neon emerald/lime accents (`#34ff9a` $\to$ `#b6ff3c`).
- **Typography**: Space Grotesk (headings, tabular data) & Inter (body).
- **Physics-Based 3D Engine**: Three.js floating low-poly leaves, bioluminescent particle field, and parametric hero leaf that reacts to user scroll, cursor angle, and scanning states.
- **Interactive Before/After Slider**: Real-time comparison between raw specimen photography and Grad-CAM neural attention maps.
- **Offline Reliability**: Zero external CDNs or external image dependencies.
