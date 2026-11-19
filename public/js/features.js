// Additive Field Intelligence Features Module for Verdant AI
// 1. Live Camera | 2. Batch Field Audit | 3. Lesion Area % | 4. Logbook
// 5. Clinical PDF Report | 6. Outbreak Risk Calculator | 7. Side-by-Side Compare | 8. Explainability Lab

const LOGBOOK_KEY = 'verdant_ai_field_logbook_v1';
const MAX_LOGBOOK_ITEMS = 12;

let activeScanRecord = null; // { data, origSrc }
let cameraStream = null;
let currentXaiMode = 'slider';

export function initFeatures() {
  setupScannerModes();
  setupCameraCapture();
  setupBatchAudit();
  setupExplainabilityLab();
  setupLogbook();
  setupCompareModal();
  setupWeatherRiskCalculator();
  setupPdfExport();

  window.verdantFeatures = {
    onScanComplete,
    openCompareModal,
    exportClinicalPdf
  };
}

// ==========================================
// HELPER: Lightweight Thumbnail Generator (keeps localStorage lean & fast)
// ==========================================
function makeCompactDataUrl(src, maxDim = 220, quality = 0.78) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}

// ==========================================
// HOOK CALLED BY SCANNER.JS ON EVERY CONFIDENT SCAN
// ==========================================
async function onScanComplete(data, origSrc) {
  activeScanRecord = { data, origSrc };

  // 1. Populate Infected Area % & Economic Action Threshold (Feature 3)
  const infPct = Number(data.infected_area_pct ?? 0);
  const valEl = document.getElementById('infected-area-val');
  const fillEl = document.getElementById('infected-area-fill');
  const stageEl = document.getElementById('infected-stage-text');
  const threshEl = document.getElementById('infected-threshold-text');

  if (valEl) {
    valEl.textContent = `${infPct.toFixed(1)}%`;
    valEl.style.color = infPct === 0 ? 'var(--lime)' : (infPct < 15 ? 'var(--accent-amber)' : '#ff9c86');
  }
  if (fillEl) fillEl.style.width = `${Math.min(100, infPct)}%`;
  if (stageEl) stageEl.textContent = data.severity_stage || (infPct === 0 ? 'Healthy Canopy (0%)' : `${infPct}% Affected`);
  if (threshEl) threshEl.textContent = data.action_threshold || '';

  // 2. Populate Explainability Lab Telemetry (Feature 8)
  const rawEl = document.getElementById('xai-raw-cal');
  const marginEl = document.getElementById('xai-margin');
  const entEl = document.getElementById('xai-entropy');
  const ttaEl = document.getElementById('xai-tta');

  const rawTop = data.raw_probabilities ? data.raw_probabilities[data.predicted_class] : null;
  if (rawEl) {
    rawEl.textContent = rawTop != null
      ? `${Number(rawTop).toFixed(1)}% → ${Number(data.confidence).toFixed(1)}% (T=${data.temperature ?? 0.39})`
      : `${Number(data.confidence).toFixed(1)}%`;
  }
  if (marginEl) {
    marginEl.textContent = data.uncertainty ? `+${Number(data.uncertainty.gap_pct).toFixed(1)} pts` : '—';
  }
  if (entEl) {
    entEl.textContent = data.uncertainty ? `${Number(data.uncertainty.normalized_entropy).toFixed(3)}` : '—';
  }
  if (ttaEl) {
    if (data.tta_agreement) {
      ttaEl.textContent = data.tta_agreement.agree
        ? `Match (Δ${data.tta_agreement.max_delta_pct}%)`
        : `Split (Δ${data.tta_agreement.max_delta_pct}%)`;
    } else {
      ttaEl.textContent = '2-Pass Avg';
    }
  }

  // Reset Explainability visual mode back to Before/After slider on fresh scan
  applyXaiVisualMode('slider');

  // 3. Persist lightweight entry to Local Field Logbook (Feature 4)
  try {
    const thumbOrig = await makeCompactDataUrl(origSrc, 220, 0.76);
    const thumbGrad = await makeCompactDataUrl(`data:image/png;base64,${data.gradcam_base64}`, 220, 0.76);
    const entry = {
      id: `scan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      predicted_class: data.predicted_class,
      name: data.details?.name || data.predicted_class,
      confidence: Number(data.confidence),
      infected_area_pct: infPct,
      severity_stage: data.severity_stage || '',
      probabilities: data.probabilities || {},
      note: '',
      thumbOrig,
      thumbGrad
    };
    const items = readLogbook();
    items.unshift(entry);
    saveLogbook(items.slice(0, MAX_LOGBOOK_ITEMS));
    renderLogbook();
  } catch (e) {
    console.warn('Logbook save skipped:', e);
  }
}

// ==========================================
// FEATURE 1: LIVE FIELD CAMERA CAPTURE
// ==========================================
function setupScannerModes() {
  const modeBtns = document.querySelectorAll('.scan-mode-btn[data-scan-mode]');
  const singlePane = document.getElementById('single-scan-pane');
  const batchPane = document.getElementById('batch-scan-pane');

  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-scan-mode');
      if (mode === 'camera') {
        openCameraModal();
        return;
      }
      modeBtns.forEach(b => {
        if (b.getAttribute('data-scan-mode') !== 'camera') b.classList.remove('active');
      });
      btn.classList.add('active');
      if (singlePane) singlePane.style.display = mode === 'single' ? '' : 'none';
      if (batchPane) batchPane.style.display = mode === 'batch' ? '' : 'none';
    });
  });

  document.getElementById('btn-open-compare-quick')?.addEventListener('click', openCompareModal);
}

function setupCameraCapture() {
  const modal = document.getElementById('camera-modal');
  const closeBtn = document.getElementById('camera-close-btn');
  const cancelBtn = document.getElementById('btn-camera-cancel');
  const snapBtn = document.getElementById('btn-camera-snap');

  closeBtn?.addEventListener('click', closeCameraModal);
  cancelBtn?.addEventListener('click', closeCameraModal);
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeCameraModal();
  });

  snapBtn?.addEventListener('click', () => {
    const video = document.getElementById('camera-video');
    const canvas = document.getElementById('camera-canvas');
    if (!video || !canvas || !cameraStream || video.readyState < 2) {
      window.showToast?.('Camera feed is not active.', 'info');
      return;
    }
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `camera_leaf_${Date.now()}.jpg`, { type: 'image/jpeg' });
      closeCameraModal();
      // Switch to single mode and trigger scan via scanner hook
      document.querySelector('.scan-mode-btn[data-scan-mode="single"]')?.click();
      window.verdantScanner?.scanFile(file);
    }, 'image/jpeg', 0.92);
  });
}

async function openCameraModal() {
  const modal = document.getElementById('camera-modal');
  const video = document.getElementById('camera-video');
  const errBox = document.getElementById('camera-error-box');
  if (!modal) return;

  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('drawer-open');
  window.setLenisPaused?.(true);

  if (errBox) {
    errBox.style.display = 'none';
    errBox.textContent = '';
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (errBox) {
      errBox.style.display = 'flex';
      errBox.textContent = 'Camera API unavailable in this browser context. Please upload a leaf photo directly from disk.';
    }
    return;
  }

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false
    });
    if (video) {
      video.srcObject = cameraStream;
      await video.play();
    }
  } catch (err) {
    if (errBox) {
      errBox.style.display = 'flex';
      errBox.textContent = `Camera access unavailable (${err.name || 'No device'}). Allow browser camera permission or upload an image file instead.`;
    }
  }
}

function closeCameraModal() {
  const modal = document.getElementById('camera-modal');
  const video = document.getElementById('camera-video');
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  if (video) video.srcObject = null;
  if (modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }
  document.body.classList.remove('drawer-open');
  window.setLenisPaused?.(false);
}

// ==========================================
// FEATURE 2: BATCH FIELD AUDIT MODE
// ==========================================
function setupBatchAudit() {
  const batchInput = document.getElementById('batch-file-input');
  const browseBtn = document.getElementById('btn-batch-browse');
  const demoBtn = document.getElementById('btn-batch-demo');
  const dropzone = document.getElementById('batch-dropzone');

  browseBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    batchInput?.click();
  });

  dropzone?.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    batchInput?.click();
  });

  batchInput?.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []).slice(0, 15);
    if (files.length > 0) runBatchAudit(files);
  });

  // 1-Click Demo Field Audit using the 6 validated test samples
  demoBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const statusText = document.getElementById('batch-status-text');
    if (statusText) statusText.textContent = 'Loading 6 validated field specimens...';
    try {
      const sampleRes = await fetch('/api/samples');
      const { samples } = await sampleRes.json();
      if (!samples || samples.length === 0) throw new Error('No sample images found.');
      const files = [];
      const srcMap = {};
      for (const s of samples.slice(0, 6)) {
        const resp = await fetch(s.url);
        const blob = await resp.blob();
        const file = new File([blob], s.filename, { type: blob.type || 'image/jpeg' });
        files.push(file);
        srcMap[s.filename] = s.url;
      }
      await runBatchAudit(files, srcMap);
    } catch (err) {
      window.showToast?.(`Batch demo failed: ${err.message}`, 'error');
    }
  });
}

async function runBatchAudit(files, preloadedSrcMap = {}) {
  const statusText = document.getElementById('batch-status-text');
  const demoBtn = document.getElementById('btn-batch-demo');
  const browseBtn = document.getElementById('btn-batch-browse');

  if (statusText) statusText.textContent = `Scanning ${files.length} leaves sequentially through calibrated MobileNetV2 worker...`;
  if (demoBtn) demoBtn.disabled = true;
  if (browseBtn) browseBtn.disabled = true;
  window.leafScan3D?.setScanning(true);

  // Build preview data URLs for local files
  const localSrcMap = { ...preloadedSrcMap };
  for (const f of files) {
    if (!localSrcMap[f.name]) {
      localSrcMap[f.name] = URL.createObjectURL(f);
    }
  }

  const formData = new FormData();
  files.forEach(f => formData.append('images', f));

  try {
    const res = await fetch('/api/predict-batch', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') {
      throw new Error(data.error || 'Batch prediction failed');
    }
    renderBatchResults(data, localSrcMap);
    window.showToast?.(`Batch audit complete: ${data.summary.total} leaves scanned in ${(data.summary.total_time_ms / 1000).toFixed(1)}s`, 'success');
  } catch (err) {
    window.showToast?.(`Batch error: ${err.message}`, 'error');
  } finally {
    window.leafScan3D?.setScanning(false);
    if (statusText) statusText.textContent = '';
    if (demoBtn) demoBtn.disabled = false;
    if (browseBtn) browseBtn.disabled = false;
  }
}

function renderBatchResults(batchData, srcMap) {
  const panel = document.getElementById('batch-results-panel');
  const grid = document.getElementById('batch-cards-grid');
  if (!panel || !grid) return;

  const s = batchData.summary;
  document.getElementById('batch-overall-status').textContent = s.overall_field_status;
  document.getElementById('batch-kpi-total').textContent = String(s.total);
  document.getElementById('batch-kpi-healthy').textContent = `${s.healthy_pct}%`;
  document.getElementById('batch-kpi-infected').textContent = `${s.avg_infected_area_pct}%`;

  grid.innerHTML = '';
  batchData.results.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'batch-leaf-card';
    const isOk = item.status === 'success';
    const isHealthy = isOk && item.predicted_class === 'healthy';
    const imgSrc = isOk && item.gradcam_base64
      ? `data:image/png;base64,${item.gradcam_base64}`
      : (srcMap[item.filename] || '');

    const pillClass = !isOk ? 'uncertain-badge' : (isHealthy ? 'severity-pill severity-healthy' : 'severity-pill severity-diseased');
    const pillText = !isOk ? item.status : `${Number(item.infected_area_pct || 0).toFixed(1)}% area`;

    card.innerHTML = `
      <img class="batch-leaf-img" src="${imgSrc}" alt="${item.filename}">
      <div class="batch-leaf-meta">
        <span class="batch-leaf-name">${isOk ? (item.details?.name || item.predicted_class) : 'Uncertain Specimen'}</span>
        <span class="${pillClass}">${pillText}</span>
      </div>
      <div class="batch-leaf-sub">
        <span>${item.filename.slice(0, 22)}</span>
        <strong>${isOk ? `${Number(item.confidence).toFixed(1)}%` : 'Review'}</strong>
      </div>
    `;

    if (isOk) {
      card.addEventListener('click', () => {
        const origSrc = srcMap[item.filename] || imgSrc;
        window.verdantScanner?.loadResultDirectly(item, origSrc);
      });
    }
    grid.appendChild(card);
  });

  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ==========================================
// FEATURE 8: EXPLAINABILITY LAB 4-MODE VISUAL SWITCHER
// ==========================================
function setupExplainabilityLab() {
  const buttons = document.querySelectorAll('.xai-mode-btn[data-xai-mode]');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-xai-mode');
      applyXaiVisualMode(mode);
    });
  });
}

function applyXaiVisualMode(mode) {
  currentXaiMode = mode;
  document.querySelectorAll('.xai-mode-btn[data-xai-mode]').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-xai-mode') === mode);
  });

  const gradImg = document.getElementById('comparison-gradcam');
  const handle = document.getElementById('slider-handle');
  const badgeL = document.getElementById('slider-badge-left');
  const badgeR = document.getElementById('slider-badge-right');
  const hint = document.getElementById('slider-hint-text');

  if (!gradImg || !activeScanRecord) return;
  const d = activeScanRecord.data;

  if (mode === 'slider') {
    gradImg.src = `data:image/png;base64,${d.gradcam_base64}`;
    gradImg.style.clipPath = 'inset(0 0 0 50%)';
    if (handle) { handle.style.display = ''; handle.style.left = '50%'; }
    if (badgeL) badgeL.style.display = '';
    if (badgeR) { badgeR.style.display = ''; badgeR.textContent = 'Grad-CAM'; }
    if (hint) hint.textContent = 'Drag center divider to compare original foliage against convolutional activation hotspots.';
  } else if (mode === 'gradcam') {
    gradImg.src = `data:image/png;base64,${d.gradcam_base64}`;
    gradImg.style.clipPath = 'inset(0 0 0 0%)';
    if (handle) handle.style.display = 'none';
    if (badgeL) badgeL.style.display = 'none';
    if (badgeR) { badgeR.style.display = ''; badgeR.textContent = 'Full Grad-CAM Overlay'; }
    if (hint) hint.textContent = 'Full blended Grad-CAM saliency map highlighting regions driving MobileNetV2 predictions.';
  } else if (mode === 'heatmap') {
    gradImg.src = `data:image/png;base64,${d.heatmap_base64 || d.gradcam_base64}`;
    gradImg.style.clipPath = 'inset(0 0 0 0%)';
    if (handle) handle.style.display = 'none';
    if (badgeL) badgeL.style.display = 'none';
    if (badgeR) { badgeR.style.display = ''; badgeR.textContent = 'Pure Thermal Map'; }
    if (hint) hint.textContent = 'Pure spatial gradient intensity from out_relu (8×8×1280) before photographic blending.';
  } else if (mode === 'contour') {
    gradImg.src = `data:image/png;base64,${d.contour_base64 || d.gradcam_base64}`;
    gradImg.style.clipPath = 'inset(0 0 0 0%)';
    if (handle) handle.style.display = 'none';
    if (badgeL) badgeL.style.display = 'none';
    if (badgeR) { badgeR.style.display = ''; badgeR.textContent = 'Lesion Contours'; }
    if (hint) hint.textContent = 'High-activation lesion contours used to quantify estimated infected leaf surface area.';
  }
}

// ==========================================
// FEATURE 4: LOCAL PERSISTENT FIELD LOGBOOK
// ==========================================
function readLogbook() {
  try {
    return JSON.parse(localStorage.getItem(LOGBOOK_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveLogbook(items) {
  try {
    localStorage.setItem(LOGBOOK_KEY, JSON.stringify(items));
  } catch (e) {
    // Trim oldest items if quota tight
    try {
      localStorage.setItem(LOGBOOK_KEY, JSON.stringify(items.slice(0, 6)));
    } catch {}
  }
}

function setupLogbook() {
  renderLogbook();
  document.getElementById('btn-clear-logbook')?.addEventListener('click', () => {
    saveLogbook([]);
    renderLogbook();
    window.showToast?.('Field logbook cleared.', 'info');
  });
  document.getElementById('btn-open-compare')?.addEventListener('click', openCompareModal);
}

function renderLogbook() {
  const list = document.getElementById('logbook-list');
  const countEl = document.getElementById('logbook-count');
  const items = readLogbook();
  if (countEl) countEl.textContent = String(items.length);
  if (!list) return;

  if (items.length === 0) {
    list.innerHTML = `<div class="logbook-empty">No scans logged yet. Run a leaf scan or sample slide above to start recording your field logbook.</div>`;
    return;
  }

  list.innerHTML = '';
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'logbook-item';
    const timeStr = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    row.innerHTML = `
      <img class="logbook-thumb" src="${item.thumbOrig}" alt="${item.name}">
      <div class="logbook-info">
        <div class="logbook-title">${item.name} · ${item.confidence.toFixed(1)}%</div>
        <div class="logbook-meta">${timeStr} · Infected: ${Number(item.infected_area_pct || 0).toFixed(1)}%</div>
        <input type="text" class="logbook-note-input" placeholder="Add field plot note (e.g. North Row 4)..." value="${(item.note || '').replace(/"/g, '&quot;')}">
      </div>
      <button type="button" class="logbook-del-btn" title="Remove entry">✕</button>
    `;

    const noteInput = row.querySelector('.logbook-note-input');
    noteInput.addEventListener('click', (e) => e.stopPropagation());
    noteInput.addEventListener('change', () => {
      const updated = readLogbook().map(x => x.id === item.id ? { ...x, note: noteInput.value } : x);
      saveLogbook(updated);
    });

    row.querySelector('.logbook-del-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const filtered = readLogbook().filter(x => x.id !== item.id);
      saveLogbook(filtered);
      renderLogbook();
    });

    row.addEventListener('click', () => {
      window.openDiseaseDossier?.(item.predicted_class, {
        origSrc: item.thumbOrig,
        gradcamSrc: item.thumbGrad,
        probability: item.confidence
      });
    });

    list.appendChild(row);
  });
}

// ==========================================
// FEATURE 7: SIDE-BY-SIDE SCAN COMPARISON MODAL
// ==========================================
function setupCompareModal() {
  const modal = document.getElementById('compare-modal');
  const closeBtn = document.getElementById('compare-close-btn');
  const demoBtn = document.getElementById('btn-compare-demo');
  const selA = document.getElementById('compare-select-a');
  const selB = document.getElementById('compare-select-b');

  closeBtn?.addEventListener('click', closeCompareModal);
  modal?.addEventListener('click', (e) => { if (e.target === modal) closeCompareModal(); });

  selA?.addEventListener('change', renderComparisonView);
  selB?.addEventListener('change', renderComparisonView);

  // 1-Click Live Demo: scans 1 Healthy + 1 Angular Leaf Spot sample and opens comparison immediately
  demoBtn?.addEventListener('click', async () => {
    demoBtn.disabled = true;
    demoBtn.textContent = 'Scanning 2 Samples...';
    try {
      const sampleRes = await fetch('/api/samples');
      const { samples } = await sampleRes.json();
      const healthySample = samples.find(s => s.filename.includes('healthy')) || samples[0];
      const spotSample = samples.find(s => s.filename.includes('spot')) || samples[1];

      const runOne = async (sample) => {
        const blob = await (await fetch(sample.url)).blob();
        const form = new FormData();
        form.append('image', new File([blob], sample.filename, { type: blob.type }));
        const pred = await (await fetch('/api/predict', { method: 'POST', body: form })).json();
        return { pred, origUrl: sample.url };
      };

      const a = await runOne(healthySample);
      const b = await runOne(spotSample);
      await onScanComplete(a.pred, a.origUrl);
      await onScanComplete(b.pred, b.origUrl);
      populateCompareDropdowns();
      renderComparisonView();
      window.showToast?.('Side-by-side comparison ready.', 'success');
    } catch (err) {
      window.showToast?.(`Demo comparison error: ${err.message}`, 'error');
    } finally {
      demoBtn.disabled = false;
      demoBtn.textContent = 'Load Healthy vs Diseased Demo';
    }
  });
}

function openCompareModal() {
  const modal = document.getElementById('compare-modal');
  if (!modal) return;
  populateCompareDropdowns();
  renderComparisonView();
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('drawer-open');
  window.setLenisPaused?.(true);
}

function closeCompareModal() {
  const modal = document.getElementById('compare-modal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('drawer-open');
  window.setLenisPaused?.(false);
}

function populateCompareDropdowns() {
  const items = readLogbook();
  const selA = document.getElementById('compare-select-a');
  const selB = document.getElementById('compare-select-b');
  if (!selA || !selB) return;

  selA.innerHTML = '';
  selB.innerHTML = '';
  items.forEach((it, idx) => {
    const label = `${it.name} (${it.confidence.toFixed(1)}% · ${Number(it.infected_area_pct || 0).toFixed(1)}% inf)${it.note ? ' — ' + it.note : ''}`;
    selA.add(new Option(label, it.id, idx === Math.min(1, items.length - 1), idx === Math.min(1, items.length - 1)));
    selB.add(new Option(label, it.id, idx === 0, idx === 0));
  });
}

function renderComparisonView() {
  const items = readLogbook();
  const selA = document.getElementById('compare-select-a');
  const selB = document.getElementById('compare-select-b');
  const cols = document.getElementById('compare-columns');
  const banner = document.getElementById('compare-delta-banner');
  if (!cols || !banner) return;

  const a = items.find(i => i.id === selA?.value);
  const b = items.find(i => i.id === selB?.value);

  if (!a || !b) {
    banner.style.display = 'none';
    cols.innerHTML = `<div class="logbook-empty" style="grid-column: 1 / -1;">Log at least 2 scans, or click <strong>"Load Healthy vs Diseased Demo"</strong> above for an instant side-by-side comparison.</div>`;
    return;
  }

  const infDelta = (Number(b.infected_area_pct || 0) - Number(a.infected_area_pct || 0)).toFixed(1);
  const sign = Number(infDelta) > 0 ? '+' : '';
  banner.style.display = 'block';
  banner.textContent = `DELTA SUMMARY · Specimen A (${a.name}, ${Number(a.infected_area_pct || 0).toFixed(1)}% area) → Specimen B (${b.name}, ${Number(b.infected_area_pct || 0).toFixed(1)}% area) | Infected Surface Shift: ${sign}${infDelta}%`;

  const renderCard = (label, item) => `
    <div class="compare-col-card">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span class="mono-kicker" style="margin:0;">${label}</span>
        <span class="severity-pill ${item.predicted_class === 'healthy' ? 'severity-healthy' : 'severity-diseased'}">${item.confidence.toFixed(1)}%</span>
      </div>
      <h4 style="font-size:1.3rem;">${item.name}</h4>
      <div class="compare-img-pair">
        <img src="${item.thumbOrig}" alt="Original">
        <img src="${item.thumbGrad}" alt="Grad-CAM">
      </div>
      <div class="xai-telemetry-grid">
        <div class="xai-tel-item"><span>Infected Surface</span><strong>${Number(item.infected_area_pct || 0).toFixed(1)}%</strong></div>
        <div class="xai-tel-item"><span>Stage</span><strong>${item.severity_stage || '—'}</strong></div>
      </div>
    </div>
  `;

  cols.innerHTML = renderCard('SPECIMEN A', a) + renderCard('SPECIMEN B', b);
}

// ==========================================
// FEATURE 6: WEATHER-DRIVEN OUTBREAK RISK CALCULATOR
// Based on Pseudocercospora griseola & Uromyces appendiculatus agronomic curves
// ==========================================
function setupWeatherRiskCalculator() {
  const sTemp = document.getElementById('slider-temp');
  const sHum = document.getElementById('slider-humidity');
  const sWet = document.getElementById('slider-wetness');
  if (!sTemp || !sHum || !sWet) return;

  const update = () => {
    const temp = Number(sTemp.value);
    const hum = Number(sHum.value);
    const wet = Number(sWet.value);

    document.getElementById('val-temp').textContent = `${temp}°C`;
    document.getElementById('val-humidity').textContent = `${hum}%`;
    document.getElementById('val-wetness').textContent = `${wet} hrs`;

    // Angular Leaf Spot: Optimal 24°C (18-28°C), High RH (>80%), Wetness > 8h
    const spotTempScore = Math.max(0, 1 - Math.abs(temp - 24) / 11);
    const spotHumScore = Math.max(0, (hum - 55) / 40);
    const spotWetScore = Math.min(1, wet / 14);
    const spotRisk = Math.round(Math.min(100, (spotTempScore * 0.4 + spotHumScore * 0.35 + spotWetScore * 0.25) * 100));

    // Bean Rust: Optimal 21°C (17-27°C), Prolonged continuous dew/wetness (10-18h)
    const rustTempScore = Math.max(0, 1 - Math.abs(temp - 21) / 10);
    const rustWetScore = Math.min(1, wet / 13);
    const rustHumScore = Math.max(0, (hum - 50) / 45);
    const rustRisk = Math.round(Math.min(100, (rustTempScore * 0.35 + rustWetScore * 0.45 + rustHumScore * 0.20) * 100));

    applyRiskUI('spot', spotRisk, 'Pseudocercospora thrives at 18–28°C with >85% RH.');
    applyRiskUI('rust', rustRisk, 'Uromyces spores germinate rapidly after 10+ hrs of cool dew.');
  };

  [sTemp, sHum, sWet].forEach(el => el.addEventListener('input', update));

  const presets = {
    dry: { temp: 31, hum: 44, wet: 2 },
    humid: { temp: 25, hum: 91, wet: 14 },
    dew: { temp: 20, hum: 88, wet: 16 }
  };
  document.querySelectorAll('[data-weather-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = presets[btn.getAttribute('data-weather-preset')];
      if (!p) return;
      sTemp.value = p.temp;
      sHum.value = p.hum;
      sWet.value = p.wet;
      update();
    });
  });

  update();
}

function applyRiskUI(key, score, baseNote) {
  const badge = document.getElementById(`risk-${key}-badge`);
  const bar = document.getElementById(`risk-${key}-bar`);
  const note = document.getElementById(`risk-${key}-note`);
  if (!badge || !bar || !note) return;

  let level = 'Low';
  let cls = 'risk-low';
  let color = 'var(--lime)';
  let advice = 'Low spore pressure. Maintain routine scouting.';

  if (score >= 70) {
    level = `Critical (${score}%)`;
    cls = 'risk-critical';
    color = '#e86f54';
    advice = `High outbreak window — ${baseNote}`;
  } else if (score >= 42) {
    level = `Elevated (${score}%)`;
    cls = 'risk-elevated';
    color = 'var(--accent-amber)';
    advice = `Favorable conditions — scout lower leaf undersides.`;
  } else {
    level = `Low (${score}%)`;
  }

  badge.textContent = level;
  badge.className = `risk-level-badge ${cls}`;
  bar.style.width = `${Math.max(8, score)}%`;
  bar.style.background = color;
  note.textContent = advice;
}

// ==========================================
// FEATURE 5: CLINICAL PDF / PRINT FIELD REPORT EXPORT
// ==========================================
function setupPdfExport() {
  document.getElementById('btn-export-pdf-results')?.addEventListener('click', () => exportClinicalPdf());
  document.getElementById('dossier-pdf-btn')?.addEventListener('click', () => exportClinicalPdf());
}

async function exportClinicalPdf() {
  const record = activeScanRecord;
  if (!record || !record.data) {
    window.showToast?.('Run a leaf scan first to generate a clinical PDF report.', 'info');
    return;
  }

  const d = record.data;
  const info = d.details || {};
  const timestamp = new Date().toLocaleString();
  const embeddedOrig = await makeCompactDataUrl(record.origSrc, 640, 0.9);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Verdant AI Clinical Field Report — ${info.name || d.predicted_class}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif; color: #193940; margin: 32px; line-height: 1.55; }
  .header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #193940; padding-bottom: 14px; margin-bottom: 22px; }
  .brand { font-size: 22px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: #193940; }
  .meta { font-size: 12px; color: #4b676e; text-align: right; }
  .kpi-bar { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 22px; }
  .kpi { padding: 12px; border: 1px solid #BAC8D9; border-radius: 6px; background: #f6f9fb; }
  .kpi small { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #4b676e; }
  .kpi strong { font-size: 18px; color: #193940; }
  .imgs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 24px; }
  .img-box { border: 1px solid #BAC8D9; border-radius: 6px; padding: 8px; text-align: center; }
  .img-box img { width: 100%; aspect-ratio: 1/1; object-fit: cover; border-radius: 4px; }
  .img-box span { display: block; margin-top: 6px; font-size: 11px; font-weight: 600; color: #193940; }
  h3 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; color: #193940; border-left: 4px solid #7ABF5A; padding-left: 10px; margin: 18px 0 8px 0; }
  p, li { font-size: 13px; color: #244047; }
  ul { padding-left: 20px; margin: 6px 0; }
  .footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid #BAC8D9; font-size: 11px; color: #5c757d; display: flex; justify-content: space-between; }
  @media print { .no-print { display: none; } body { margin: 16px; } }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand">VERDANT AI // CLINICAL PATHOLOGY REPORT</div>
      <div style="font-size:13px; color:#4b676e; margin-top:4px;">Phaseolus vulgaris · MobileNetV2 256² · Temperature-Calibrated TTA Pipeline</div>
    </div>
    <div class="meta">
      <div><strong>Date:</strong> ${timestamp}</div>
      <div><strong>Specimen Code:</strong> ${info.code || d.predicted_class.toUpperCase()}</div>
    </div>
  </div>

  <div class="kpi-bar">
    <div class="kpi"><small>Diagnosis</small><strong>${info.name || d.predicted_class}</strong></div>
    <div class="kpi"><small>Calibrated Confidence</small><strong>${Number(d.confidence).toFixed(1)}%</strong></div>
    <div class="kpi"><small>Est. Infected Area</small><strong>${Number(d.infected_area_pct || 0).toFixed(1)}%</strong></div>
    <div class="kpi"><small>Severity Stage</small><strong>${d.severity_stage || info.severity || '—'}</strong></div>
  </div>

  <div class="imgs">
    <div class="img-box"><img src="${embeddedOrig}" alt="Original"><span>1. Original Leaf Specimen</span></div>
    <div class="img-box"><img src="data:image/png;base64,${d.gradcam_base64}" alt="Grad-CAM"><span>2. Grad-CAM Saliency Overlay</span></div>
    <div class="img-box"><img src="data:image/png;base64,${d.contour_base64 || d.gradcam_base64}" alt="Contours"><span>3. Lesion Contour Mask</span></div>
  </div>

  <h3>01 · Clinical Issue &amp; Action Threshold</h3>
  <p><strong>Pathogen:</strong> ${info.pathogen || '—'} &nbsp;|&nbsp; <strong>Threshold:</strong> ${d.action_threshold || '—'}</p>
  <p>${info.what_is_it?.overview || info.summary || ''}</p>

  <h3>02 · Causes &amp; Spread Vectors</h3>
  <p>${info.causes?.primary_cause || ''}</p>
  <ul>${(info.causes?.spread_vectors || []).map(v => `<li>${v}</li>`).join('')}</ul>

  <h3>03 · Immediate Treatment Protocol</h3>
  <ul>${[...(info.treatment?.immediate_actions || []), ...(info.treatment?.chemical_biological || [])].map(v => `<li>${v}</li>`).join('')}</ul>

  <h3>04 · Long-Term Prevention Playbook</h3>
  <ul>${(info.prevention || []).map(v => `<li>${v}</li>`).join('')}</ul>

  <div class="footer">
    <span>Verdant AI · 94.53% Held-Out Test Accuracy (iBeans)</span>
    <span>Calibrated T=${d.temperature ?? 0.3924} · Inference ${d.inference_time_ms}ms</span>
  </div>
  <script>window.onload = function(){ setTimeout(function(){ window.print(); }, 250); };</script>
</body>
</html>`;

  const w = window.open('', '_blank', 'width=920,height=780');
  if (w) {
    w.document.open();
    w.document.write(html);
    w.document.close();
    window.showToast?.('Clinical PDF report opened — select "Save as PDF".', 'success');
  } else {
    // Clean fallback download if popup blocker is active
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `verdant_report_${d.predicted_class}_${Date.now()}.html`;
    a.click();
    window.showToast?.('Clinical report downloaded (open and print to PDF).', 'success');
  }
}
