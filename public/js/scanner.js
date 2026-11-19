// Scanner, Prediction & Interactive Pathology Dossier Module

let currentFile = null;
let currentImageSrc = null;
let lastPredictionData = null;
let isPredicting = false;
let diseaseCatalog = {};

// Scanner Elements
const dropzone = document.getElementById('scan-dropzone');
const fileInput = document.getElementById('file-input');
const idleContent = document.getElementById('dropzone-idle');
const previewContainer = document.getElementById('preview-container');
const previewImg = document.getElementById('preview-img');
const btnScan = document.getElementById('btn-scan');
const btnClear = document.getElementById('btn-clear');
const samplesRow = document.getElementById('samples-container');

// Results Elements
const resultsSection = document.getElementById('results-section');
const resultsGrid = document.getElementById('results-grid');
const uncertainCard = document.getElementById('uncertain-card');
const uncertainBadge = document.getElementById('uncertain-badge');
const uncertainTitle = document.getElementById('uncertain-title');
const uncertainMessage = document.getElementById('uncertain-message');
const btnUncertainRetry = document.getElementById('btn-uncertain-retry');

const diagnosisCard = document.getElementById('diagnosis-clickable-card');
const btnOpenFullDossier = document.getElementById('btn-open-full-dossier');
const diseaseNameEl = document.getElementById('disease-name');
const diseasePathogenEl = document.getElementById('disease-pathogen');
const diseaseSummaryPreviewEl = document.getElementById('disease-summary-preview');
const severityBadgeEl = document.getElementById('severity-badge');
const confidenceValEl = document.getElementById('confidence-val');
const gaugeProgressCircle = document.getElementById('gauge-progress-circle');
const probabilitiesContainer = document.getElementById('probabilities-container');
const treatmentListEl = document.getElementById('treatment-list');
const inferenceTimeEl = document.getElementById('inference-time');

// Comparison Slider Elements
const comparisonOriginal = document.getElementById('comparison-original');
const comparisonGradcam = document.getElementById('comparison-gradcam');
const sliderHandle = document.getElementById('slider-handle');
const sliderWrapper = document.getElementById('slider-wrapper');

// Dossier Modal Elements
const dossierBackdrop = document.getElementById('disease-dossier-modal');
const dossierCloseBtn = document.getElementById('dossier-close-btn');
const dossierCopyBtn = document.getElementById('dossier-copy-btn');
const dossierScrollBody = document.getElementById('dossier-scroll-body');
let activeDossierId = null;

export function initScanner() {
  loadDiseaseCatalog();
  setupDropzone();
  setupSampleButtons();
  setupComparisonSlider();
  setupDossierInteractions();

  window.verdantScanner = {
    scanFile: (file) => {
      handleFileSelected(file);
      setTimeout(() => performPrediction(file), 220);
    },
    loadResultDirectly: (data, origSrc) => {
      currentImageSrc = origSrc;
      lastPredictionData = data;
      displayResults(data);
    }
  };
}

async function loadDiseaseCatalog() {
  try {
    const res = await fetch('/api/diseases');
    if (!res.ok) return;
    const data = await res.json();
    if (data.diseases) {
      diseaseCatalog = data.diseases;
    }
  } catch (e) {
    console.warn('Could not fetch disease catalog:', e);
  }
}

function setupDossierInteractions() {
  const openCurrentDiagnosis = () => {
    if (!lastPredictionData || lastPredictionData.status !== 'success') return;
    openDiseaseDossier(lastPredictionData.predicted_class, {
      origSrc: currentImageSrc,
      gradcamSrc: `data:image/png;base64,${lastPredictionData.gradcam_base64}`,
      probability: lastPredictionData.confidence
    });
  };

  if (diagnosisCard) {
    diagnosisCard.addEventListener('click', openCurrentDiagnosis);
    diagnosisCard.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openCurrentDiagnosis();
      }
    });
  }

  if (btnOpenFullDossier) {
    btnOpenFullDossier.addEventListener('click', openCurrentDiagnosis);
  }

  // Clickable Pathology Field Guide Cards
  document.querySelectorAll('[data-disease-id]').forEach(card => {
    const openGuide = () => {
      const id = card.getAttribute('data-disease-id');
      if (id) openDiseaseDossier(id, null);
    };
    card.addEventListener('click', openGuide);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openGuide();
      }
    });
  });

  // Instant Class Switcher Tabs inside Drawer
  document.querySelectorAll('.dossier-class-tab[data-dossier-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      const clsKey = tab.getAttribute('data-dossier-tab');
      if (!clsKey) return;
      let ctx = null;
      if (lastPredictionData && lastPredictionData.status === 'success' && currentImageSrc) {
        const prob = lastPredictionData.probabilities?.[clsKey];
        if (prob != null) {
          ctx = {
            origSrc: currentImageSrc,
            gradcamSrc: `data:image/png;base64,${lastPredictionData.gradcam_base64}`,
            probability: prob
          };
        }
      }
      openDiseaseDossier(clsKey, ctx);
    });
  });

  // Copy Field Report Button
  if (dossierCopyBtn) {
    dossierCopyBtn.addEventListener('click', async () => {
      const info = diseaseCatalog[activeDossierId];
      if (!info) return;
      const lines = [
        `VERDANT AI — PATHOLOGY REPORT (${info.code || activeDossierId})`,
        `Diagnosis: ${info.name} (${info.pathogen || ''})`,
        `Severity: ${info.severity} | Yield Impact: ${info.yield_impact || ''}`,
        '',
        'WHAT IS THE ISSUE:',
        info.what_is_it?.overview || info.summary || '',
        ...(info.what_is_it?.symptoms || []).map(s => `  - ${s}`),
        '',
        'HOW IT IS CAUSED:',
        info.causes?.primary_cause || '',
        ...(info.causes?.spread_vectors || []).map(s => `  - ${s}`),
        '',
        'IMMEDIATE TREATMENT:',
        ...(info.treatment?.immediate_actions || []).map(s => `  - ${s}`),
        ...(info.treatment?.chemical_biological || []).map(s => `  - ${s}`),
        '',
        'PREVENTION PLAYBOOK:',
        ...(info.prevention || []).map(s => `  - ${s}`)
      ].join('\n');
      try {
        await navigator.clipboard.writeText(lines);
        dossierCopyBtn.textContent = 'Copied ✓';
        setTimeout(() => { dossierCopyBtn.textContent = 'Copy Report'; }, 1800);
        window.showToast?.('Full pathology report copied to clipboard.', 'success');
      } catch {
        window.showToast?.('Copy unavailable in this browser context.', 'info');
      }
    });
  }

  // Close controls
  if (dossierCloseBtn) {
    dossierCloseBtn.addEventListener('click', closeDiseaseDossier);
  }
  if (dossierBackdrop) {
    dossierBackdrop.addEventListener('click', (e) => {
      if (e.target === dossierBackdrop) {
        closeDiseaseDossier();
      }
    });
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dossierBackdrop?.classList.contains('open')) {
      closeDiseaseDossier();
    }
  });

  window.openDiseaseDossier = openDiseaseDossier;
  window.closeDiseaseDossier = closeDiseaseDossier;
}

export async function openDiseaseDossier(diseaseId, scanContext = null) {
  if (!dossierBackdrop) return;

  // Ensure catalog is loaded
  if (!diseaseCatalog[diseaseId]) {
    await loadDiseaseCatalog();
  }

  const info =
    diseaseCatalog[diseaseId] ||
    (lastPredictionData?.predicted_class === diseaseId ? lastPredictionData.details : null);

  if (!info) return;

  activeDossierId = diseaseId;
  document.querySelectorAll('.dossier-class-tab[data-dossier-tab]').forEach(tab => {
    tab.classList.toggle('active', tab.getAttribute('data-dossier-tab') === diseaseId);
  });

  const isHealthy = diseaseId === 'healthy';

  // Populate top bar & header
  const metaEl = document.getElementById('dossier-topbar-meta');
  const titleEl = document.getElementById('dossier-title');
  const sciEl = document.getElementById('dossier-sci-name');
  const sevEl = document.getElementById('dossier-severity-pill');
  const yieldEl = document.getElementById('dossier-yield-pill');
  const summaryEl = document.getElementById('dossier-summary');

  if (metaEl) metaEl.textContent = `PATHOLOGY DOSSIER // ${info.code || diseaseId.toUpperCase()}`;
  if (titleEl) titleEl.textContent = info.name;
  if (sciEl) sciEl.textContent = info.pathogen || info.scientific_name || '';
  if (sevEl) {
    sevEl.textContent = info.severity || '';
    sevEl.className = `severity-pill ${isHealthy ? 'severity-healthy' : 'severity-diseased'}`;
  }
  if (yieldEl) yieldEl.textContent = info.yield_impact || '';
  if (summaryEl) summaryEl.textContent = info.summary || '';

  // Optional live scan strip
  const scanStrip = document.getElementById('dossier-scan-strip');
  if (scanStrip) {
    if (scanContext && scanContext.origSrc && scanContext.gradcamSrc) {
      document.getElementById('dossier-orig-thumb').src = scanContext.origSrc;
      document.getElementById('dossier-gradcam-thumb').src = scanContext.gradcamSrc;
      document.getElementById('dossier-scan-conf').textContent = `${Number(scanContext.probability).toFixed(1)}% Calibrated Match`;
      scanStrip.classList.add('active');
    } else {
      scanStrip.classList.remove('active');
    }
  }

  // Helper to fill ul lists cleanly
  const fillList = (id, items) => {
    const ul = document.getElementById(id);
    if (!ul) return;
    ul.innerHTML = '';
    (items || []).forEach(text => {
      const li = document.createElement('li');
      li.textContent = text;
      ul.appendChild(li);
    });
  };

  // 01: What Is The Issue
  const whatOverview = document.getElementById('dossier-what-overview');
  if (whatOverview) whatOverview.textContent = info.what_is_it?.overview || info.summary || '';
  fillList('dossier-symptoms-list', info.what_is_it?.symptoms || []);

  // 02: How It Is Caused
  const causePrimary = document.getElementById('dossier-cause-primary');
  if (causePrimary) causePrimary.textContent = info.causes?.primary_cause || '';

  const triggersGrid = document.getElementById('dossier-triggers-grid');
  if (triggersGrid) {
    triggersGrid.innerHTML = '';
    (info.causes?.environmental_triggers || []).forEach(tr => {
      const box = document.createElement('div');
      box.className = 'trigger-box';
      box.innerHTML = `<div class="trigger-label">${tr.label}</div><div class="trigger-val">${tr.value}</div>`;
      triggersGrid.appendChild(box);
    });
  }
  fillList('dossier-vectors-list', info.causes?.spread_vectors || []);

  // 03: Immediate Treatment
  fillList('dossier-immediate-list', info.treatment?.immediate_actions || info.recommendations || []);
  fillList('dossier-chemical-list', info.treatment?.chemical_biological || []);

  // 04: How To Prevent It
  fillList('dossier-prevention-list', info.prevention || []);

  // Open drawer smoothly
  if (dossierScrollBody) dossierScrollBody.scrollTop = 0;
  dossierBackdrop.classList.add('open');
  dossierBackdrop.setAttribute('aria-hidden', 'false');
  document.body.classList.add('drawer-open');
  window.setLenisPaused?.(true);
}

export function closeDiseaseDossier() {
  if (!dossierBackdrop) return;
  dossierBackdrop.classList.remove('open');
  dossierBackdrop.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('drawer-open');
  window.setLenisPaused?.(false);
}

function setupDropzone() {
  if (!dropzone || !fileInput) return;

  dropzone.addEventListener('click', (e) => {
    if (e.target.closest('#preview-container') || e.target.closest('.preview-actions')) return;
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      handleFileSelected(e.target.files[0]);
    }
  });

  ['dragenter', 'dragover'].forEach(name => {
    dropzone.addEventListener(name, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(name => {
    dropzone.addEventListener(name, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files && files[0]) {
      handleFileSelected(files[0]);
    }
  });

  if (btnScan) {
    btnScan.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentFile) {
        performPrediction(currentFile);
      }
    });
  }

  if (btnClear) {
    btnClear.addEventListener('click', (e) => {
      e.stopPropagation();
      resetScanner();
    });
  }

  if (btnUncertainRetry) {
    btnUncertainRetry.addEventListener('click', () => {
      resetScanner();
      document.getElementById('scan')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

function handleFileSelected(file) {
  if (!file.type.match(/image\/(jpeg|jpg|png|webp)/i)) {
    window.showToast?.('Please upload a valid image (JPEG, PNG, or WebP).', 'error');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    window.showToast?.('Image exceeds 5MB size limit.', 'error');
    return;
  }

  currentFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    currentImageSrc = e.target.result;
    previewImg.src = currentImageSrc;
    idleContent.style.display = 'none';
    previewContainer.classList.add('active');
    btnScan.disabled = false;
  };
  reader.readAsDataURL(file);
}

export function resetScanner() {
  currentFile = null;
  currentImageSrc = null;
  lastPredictionData = null;
  if (fileInput) fileInput.value = '';
  idleContent.style.display = 'flex';
  previewContainer.classList.remove('active');
  dropzone.classList.remove('scanning');
  if (window.leafScan3D) {
    window.leafScan3D.reset();
  }
}

async function setupSampleButtons() {
  try {
    const res = await fetch('/api/samples');
    const data = await res.json();
    if (!data.samples || data.samples.length === 0) return;

    if (samplesRow) {
      samplesRow.innerHTML = '';
      const featured = data.samples.slice(0, 3);
      featured.forEach((sample, idx) => {
        const chip = document.createElement('div');
        chip.className = 'sample-chip';
        chip.innerHTML = `
          <img src="${sample.url}" alt="${sample.label}">
          <div class="sample-chip-meta">
            <span class="sample-chip-name">${sample.label}</span>
            <span class="sample-chip-sub">Slide 0${idx + 1} · Click to scan</span>
          </div>
          <span style="font-family: var(--font-mono); color: var(--bone-dim); font-size: 0.8rem;">→</span>
        `;
        chip.addEventListener('click', async () => {
          try {
            const resp = await fetch(sample.url);
            const blob = await resp.blob();
            const file = new File([blob], sample.filename, { type: blob.type });
            handleFileSelected(file);
            setTimeout(() => performPrediction(file), 250);
          } catch (err) {
            console.error('Failed to load sample:', err);
          }
        });
        samplesRow.appendChild(chip);
      });
    }
  } catch (e) {
    console.warn('Could not load samples:', e);
  }
}

async function performPrediction(file) {
  if (isPredicting) return;
  isPredicting = true;

  dropzone.classList.add('scanning');
  btnScan.disabled = true;
  btnScan.innerHTML = `<span>Analyzing Specimen...</span>`;

  if (window.leafScan3D) {
    window.leafScan3D.setScanning(true);
  }

  const formData = new FormData();
  formData.append('image', file);

  try {
    const response = await fetch('/api/predict', {
      method: 'POST',
      body: formData
    });

    const data = await response.json();
    if (!response.ok || data.status === 'error') {
      throw new Error(data.error || 'Prediction failed');
    }

    lastPredictionData = data;

    if (data.status === 'uncertain' || data.status === 'not_a_leaf') {
      displayUncertainState(data);
      window.showToast?.(
        data.status === 'not_a_leaf' ? 'No bean leaf detected.' : 'Prediction uncertain — upload a clearer close-up leaf photo.',
        'info'
      );
    } else {
      displayResults(data);
      window.showToast?.('Diagnosis complete — click the disease card for full dossier.', 'success');
    }

  } catch (err) {
    console.error('Prediction error:', err);
    window.showToast?.(`Error: ${err.message}`, 'error');
  } finally {
    isPredicting = false;
    dropzone.classList.remove('scanning');
    btnScan.disabled = false;
    btnScan.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
        <polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
      <span>Scan Leaf</span>
    `;
  }
}

function displayUncertainState(data) {
  if (window.leafScan3D) {
    window.leafScan3D.reset();
  }

  if (resultsGrid) resultsGrid.style.display = 'none';
  if (uncertainCard) {
    uncertainCard.style.display = 'flex';
    const isNotLeaf = data.status === 'not_a_leaf';
    if (uncertainBadge) uncertainBadge.textContent = isNotLeaf ? 'Not a Bean Leaf' : 'Uncertain Result';
    if (uncertainTitle) uncertainTitle.textContent = isNotLeaf ? 'No Bean Leaf Detected' : 'Low Confidence Diagnosis';
    if (uncertainMessage) {
      uncertainMessage.textContent = data.message || 'Not confident. Please upload a clear, close-up photo of a single bean leaf.';
    }
  }

  resultsSection.classList.add('active');
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function displayResults(data) {
  if (uncertainCard) uncertainCard.style.display = 'none';
  if (resultsGrid) resultsGrid.style.display = '';

  const isHealthy = data.predicted_class === 'healthy';

  if (window.leafScan3D) {
    window.leafScan3D.setResult(isHealthy, data.predicted_class);
  }

  // Merge detailed catalog data if present
  if (data.details && data.predicted_class) {
    diseaseCatalog[data.predicted_class] = data.details;
  }

  diseaseNameEl.textContent = data.details.name;
  diseasePathogenEl.textContent = data.details.pathogen ? `Pathogen: ${data.details.pathogen}` : '';
  if (diseaseSummaryPreviewEl && data.details.summary) {
    diseaseSummaryPreviewEl.textContent = data.details.summary;
  }

  severityBadgeEl.textContent = data.details.severity;
  severityBadgeEl.className = `severity-pill ${isHealthy ? 'severity-healthy' : 'severity-diseased'}`;

  const conf = data.confidence;
  confidenceValEl.textContent = `${conf.toFixed(1)}%`;
  const offset = 251.32 - (251.32 * (conf / 100));
  gaugeProgressCircle.style.strokeDashoffset = offset;
  gaugeProgressCircle.style.stroke = isHealthy ? '#9BF272' : '#e86f54';

  if (inferenceTimeEl) {
    inferenceTimeEl.textContent = `${data.inference_time_ms}ms · TTA calibrated`;
  }

  // Clickable probability breakdown rows (click any row to inspect that disease dossier)
  probabilitiesContainer.innerHTML = '';
  const entries = Object.entries(data.probabilities || {}).sort((a, b) => b[1] - a[1]);
  entries.forEach(([clsKey, pct]) => {
    const formattedName = clsKey.replace(/_/g, ' ');
    const item = document.createElement('div');
    item.className = 'prob-item';
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.innerHTML = `
      <div class="prob-header">
        <span class="prob-name">${formattedName} <span class="prob-inspect-hint">Inspect →</span></span>
        <span class="prob-val">${pct.toFixed(1)}%</span>
      </div>
      <div class="prob-bar-track">
        <div class="prob-bar-fill" style="width: 0%"></div>
      </div>
    `;
    const openRowDossier = () => {
      openDiseaseDossier(clsKey, {
        origSrc: currentImageSrc,
        gradcamSrc: `data:image/png;base64,${data.gradcam_base64}`,
        probability: pct
      });
    };
    item.addEventListener('click', openRowDossier);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openRowDossier();
      }
    });
    probabilitiesContainer.appendChild(item);

    setTimeout(() => {
      const fill = item.querySelector('.prob-bar-fill');
      if (fill) fill.style.width = `${pct}%`;
    }, 50);
  });

  treatmentListEl.innerHTML = '';
  (data.details.recommendations || []).forEach(rec => {
    const li = document.createElement('li');
    li.textContent = rec;
    treatmentListEl.appendChild(li);
  });

  comparisonOriginal.src = currentImageSrc;
  comparisonGradcam.src = `data:image/png;base64,${data.gradcam_base64}`;
  updateSlider(50);

  // Notify additive features (Lesion %, Explainability Lab, Field Logbook)
  window.verdantFeatures?.onScanComplete(data, currentImageSrc);

  resultsSection.classList.add('active');
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setupComparisonSlider() {
  if (!sliderWrapper || !sliderHandle) return;

  let isDraggingSlider = false;

  const onMove = (clientX) => {
    const rect = sliderWrapper.getBoundingClientRect();
    let posX = clientX - rect.left;
    let percentage = (posX / rect.width) * 100;
    percentage = Math.max(0, Math.min(100, percentage));
    updateSlider(percentage);
  };

  sliderHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDraggingSlider = true;
  });

  sliderWrapper.addEventListener('mousedown', (e) => {
    isDraggingSlider = true;
    onMove(e.clientX);
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDraggingSlider) return;
    onMove(e.clientX);
  });

  window.addEventListener('mouseup', () => {
    isDraggingSlider = false;
  });

  sliderWrapper.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      isDraggingSlider = true;
      onMove(e.touches[0].clientX);
    }
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!isDraggingSlider || e.touches.length !== 1) return;
    onMove(e.touches[0].clientX);
  }, { passive: true });

  window.addEventListener('touchend', () => {
    isDraggingSlider = false;
  });
}

function updateSlider(percentage) {
  if (!comparisonGradcam || !sliderHandle) return;
  comparisonGradcam.style.clipPath = `inset(0 0 0 ${percentage}%)`;
  sliderHandle.style.left = `${percentage}%`;
}
