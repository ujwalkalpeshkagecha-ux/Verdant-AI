const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE_URL = 'http://localhost:3000';
const TEST_DIR = path.join(__dirname, 'data', 'test');
const METRICS_PATH = path.join(__dirname, 'results', 'metrics.json');
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

async function predictFile(filePath, mimeType = 'image/jpeg') {
  const buffer = fs.readFileSync(filePath);
  const blob = new Blob([buffer], { type: mimeType });
  const form = new FormData();
  form.append('image', blob, path.basename(filePath));

  const res = await fetch(`${BASE_URL}/api/predict`, {
    method: 'POST',
    body: form
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function computeMetrics(yTrue, yPred, classes) {
  const n = classes.length;
  const cm = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < yTrue.length; i++) {
    if (yPred[i] >= 0) {
      cm[yTrue[i]][yPred[i]]++;
    }
  }

  let totalCorrect = 0;
  for (let i = 0; i < n; i++) totalCorrect += cm[i][i];
  const accuracy = (totalCorrect / yTrue.length) * 100.0;

  const perClass = {};
  for (let i = 0; i < n; i++) {
    const tp = cm[i][i];
    const fn = yTrue.filter((t, idx) => t === i && yPred[idx] !== i).length;
    const fp = yPred.filter((p, idx) => p === i && yTrue[idx] !== i).length;
    const prec = (tp + fp) > 0 ? (tp / (tp + fp)) * 100.0 : 0.0;
    const rec = (tp + fn) > 0 ? (tp / (tp + fn)) * 100.0 : 0.0;
    const f1 = (prec + rec) > 0 ? (2 * prec * rec) / (prec + rec) : 0.0;
    perClass[classes[i]] = {
      precision: Number(prec.toFixed(2)),
      recall: Number(rec.toFixed(2)),
      f1: Number(f1.toFixed(2)),
      support: tp + fn
    };
  }
  return { accuracy: Number(accuracy.toFixed(2)), cm, perClass };
}

async function runAllChecks() {
  const health = await (await fetch(`${BASE_URL}/api/health`)).json();
  console.log('[HEALTH]', health);
  if (!health.modelReady || !health.workerReady) {
    throw new Error('Server model or worker is not ready!');
  }

  const offlineMetrics = JSON.parse(fs.readFileSync(METRICS_PATH, 'utf-8'));
  const classes = offlineMetrics.confusion_matrix.labels;
  console.log('\n=== OFFLINE METRICS.JSON ===');
  console.log(`Offline Test Accuracy: ${offlineMetrics.accuracy}% (raw single-pass: ${offlineMetrics.raw_test_accuracy}%)`);
  console.log('Offline Per-Class Metrics:', offlineMetrics.classes);

  // Gather all test images
  const testItems = [];
  for (let cIdx = 0; cIdx < classes.length; cIdx++) {
    const cls = classes[cIdx];
    const cDir = path.join(TEST_DIR, cls);
    const files = fs.readdirSync(cDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).sort();
    for (const f of files) {
      testItems.push({ filePath: path.join(cDir, f), filename: f, trueClass: cls, trueIdx: cIdx });
    }
  }

  // CHECK 1 & CHECK 2: Run full test set through /api/predict
  console.log(`\n=== CHECK 1 & 2: Running ALL ${testItems.length} test images through /api/predict ===`);
  const yTrue = [];
  const yPredTop = [];     // top predicted class (including uncertain top_candidate to verify exact pipeline parity)
  const yPredStrict = [];  // strict: uncertain/not_a_leaf counted as -1 (miss)
  const statusCounts = { success: 0, uncertain: 0, not_a_leaf: 0, other: 0 };
  const sampleResultsByClass = {};
  for (const c of classes) sampleResultsByClass[c] = [];

  for (const item of testItems) {
    const resp = await predictFile(item.filePath);
    statusCounts[resp.status] = (statusCounts[resp.status] || 0) + 1;

    let topCls = null;
    let conf = null;
    if (resp.status === 'success') {
      topCls = resp.predicted_class;
      conf = resp.confidence;
    } else if (resp.status === 'uncertain') {
      topCls = resp.top_candidate;
      conf = resp.uncertainty ? resp.uncertainty.top1_pct : null;
    }

    const topIdx = topCls ? classes.indexOf(topCls) : -1;
    const strictIdx = (resp.status === 'success') ? topIdx : -1;

    yTrue.push(item.trueIdx);
    yPredTop.push(topIdx);
    yPredStrict.push(strictIdx);

    if (sampleResultsByClass[item.trueClass].length < 5) {
      sampleResultsByClass[item.trueClass].push({
        filename: item.filename,
        trueClass: item.trueClass,
        status: resp.status,
        predicted: resp.status === 'success' ? resp.predicted_class : `[${resp.status}]`,
        confidence: resp.status === 'success' ? `${resp.confidence.toFixed(2)}%` : 'N/A',
        ms: resp.inference_time_ms
      });
    }
  }

  const liveAll = computeMetrics(yTrue, yPredTop, classes);
  const liveStrict = computeMetrics(yTrue, yPredStrict, classes);
  const diff = Math.abs(liveAll.accuracy - offlineMetrics.accuracy);

  console.log('Status counts across 128 test images:', statusCounts);
  console.log(`Live API Accuracy (pipeline parity): ${liveAll.accuracy}% vs Offline: ${offlineMetrics.accuracy}% (diff: ${diff.toFixed(2)}%)`);
  console.log(`Live API Accuracy (strict, counting uncertain as miss): ${liveStrict.accuracy}%`);

  console.log('\nLive Confusion Matrix (rows=true, cols=pred):');
  console.log('Classes:', classes);
  liveAll.cm.forEach((row, i) => console.log(`  ${classes[i].padEnd(20)}:`, row));

  console.log('\nLive Per-Class Precision / Recall / F1:');
  console.table(liveAll.perClass);

  // CHECK 3: 5 images per class table
  console.log('\n=== CHECK 3: 5 Images Per Class (15 total) through /api/predict ===');
  const tableRows = [];
  for (const cls of classes) {
    for (const r of sampleResultsByClass[cls]) {
      tableRows.push(r);
    }
  }
  console.table(tableRows);

  // CHECK 4: Non-leaf images
  console.log('\n=== CHECK 4: Non-Leaf & Solid-Color Image Rejection ===');
  const tmpDir = path.join(__dirname, 'uploads');
  fs.mkdirSync(tmpDir, { recursive: true });

  // Generate 3 synthetic non-leaf PNGs via Python/PIL using spawnSync (no cmd newline splitting)
  const { spawnSync } = require('child_process');
  const pyGen = [
    'import numpy as np',
    'from PIL import Image',
    "Image.fromarray(np.full((300, 300, 3), [30, 80, 220], dtype=np.uint8)).save('uploads/test_solid_blue.png')",
    "Image.fromarray(np.full((300, 300, 3), [40, 180, 60], dtype=np.uint8)).save('uploads/test_solid_green.png')",
    'rng = np.random.default_rng(7)',
    'arr = np.zeros((300, 300, 3), dtype=np.uint8)',
    'arr[:, :, 0] = rng.integers(120, 240, (300, 300))',
    'arr[:, :, 1] = rng.integers(20, 80, (300, 300))',
    'arr[:, :, 2] = rng.integers(140, 240, (300, 300))',
    "Image.fromarray(arr).save('uploads/test_nonleaf_noise.png')"
  ].join('\n');
  const genRes = spawnSync(path.join(__dirname, '.venv', 'Scripts', 'python.exe'), ['-c', pyGen], {
    cwd: __dirname,
    stdio: 'inherit'
  });
  if (genRes.status !== 0) throw new Error('Failed to generate non-leaf test PNGs');

  const nonLeafFiles = ['uploads/test_solid_blue.png', 'uploads/test_solid_green.png', 'uploads/test_nonleaf_noise.png'];
  let check4Pass = true;
  for (const nf of nonLeafFiles) {
    const resp = await predictFile(nf, 'image/png');
    console.log(`  ${path.basename(nf)} -> status="${resp.status}", message="${resp.message}"`, resp.leaf_check || '');
    if (resp.status !== 'not_a_leaf' && resp.status !== 'uncertain') {
      check4Pass = false;
    }
    try { fs.unlinkSync(nf); } catch {}
  }

  // CHECK 5: Verify Website Model Performance & Uncertain UI in Browser
  console.log('\n=== CHECK 5: Live Browser Verification (Metrics + Uncertain Card + Zero Errors) ===');
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push(err.toString()));

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForSelector('#loading-screen.loaded', { timeout: 10000 });
  // Wait briefly for metrics fetch + count-up to settle
  await new Promise(r => setTimeout(r, 1500));

  const uiMetrics = await page.evaluate(() => ({
    heroAcc: document.getElementById('hero-stat-accuracy')?.textContent?.trim(),
    bentoAcc: document.getElementById('bento-acc')?.textContent?.trim(),
    bentoPrec: document.getElementById('bento-prec')?.textContent?.trim(),
    bentoRec: document.getElementById('bento-rec')?.textContent?.trim(),
    bentoF1: document.getElementById('bento-f1')?.textContent?.trim(),
    scopeNote: document.querySelector('.scan-scope-note')?.textContent?.trim()
  }));
  console.log('UI Displayed Metrics & Scope Note:', uiMetrics);

  // Test uploading non-leaf image in the browser UI to verify calm amber warning card
  spawnSync(path.join(__dirname, '.venv', 'Scripts', 'python.exe'), [
    '-c',
    "import numpy as np; from PIL import Image; Image.fromarray(np.full((300,300,3),[40,70,210],dtype=np.uint8)).save('uploads/ui_nonleaf.png')"
  ], { cwd: __dirname, stdio: 'inherit' });
  const fileInput = await page.$('#file-input');
  await fileInput.uploadFile(path.join(__dirname, 'uploads', 'ui_nonleaf.png'));
  await new Promise(r => setTimeout(r, 400));
  await page.click('#btn-scan');
  await page.waitForSelector('#results-section.active', { timeout: 10000 });
  await new Promise(r => setTimeout(r, 400));

  const uncertainUI = await page.evaluate(() => ({
    uncertainVisible: getComputedStyle(document.getElementById('uncertain-card')).display !== 'none',
    resultsGridHidden: getComputedStyle(document.getElementById('results-grid')).display === 'none',
    badge: document.getElementById('uncertain-badge')?.textContent?.trim(),
    message: document.getElementById('uncertain-message')?.textContent?.trim()
  }));
  console.log('UI Non-Leaf / Uncertain Card State:', uncertainUI);
  await page.screenshot({ path: path.join(__dirname, 'results', 'screenshot_uncertain_ui.png') });
  try { fs.unlinkSync(path.join(__dirname, 'uploads', 'ui_nonleaf.png')); } catch {}

  // Click sample leaf to verify normal Diagnosis panel restores properly
  await page.click('.sample-chip');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('results-grid')).display !== 'none', { timeout: 10000 });
  await new Promise(r => setTimeout(r, 500));
  const normalUI = await page.evaluate(() => ({
    uncertainHidden: getComputedStyle(document.getElementById('uncertain-card')).display === 'none',
    diseaseName: document.getElementById('disease-name')?.textContent?.trim(),
    confidence: document.getElementById('confidence-val')?.textContent?.trim(),
    hasGradcam: document.getElementById('comparison-gradcam')?.src?.startsWith('data:image/png;base64,')
  }));
  console.log('UI Normal Leaf Diagnosis State:', normalUI);
  console.log('Browser Console Errors:', consoleErrors.length);

  await browser.close();

  // Assertions summary
  const minF1 = Math.min(...Object.values(liveAll.perClass).map(v => v.f1));
  const expectedAccStr = `${Number(offlineMetrics.accuracy).toFixed(1)}%`;
  const checks = {
    'CHECK 1 (API vs Offline within 1%)': diff <= 1.0,
    'CHECK 2a (Test accuracy >= 90%)': liveAll.accuracy >= 90.0 && offlineMetrics.accuracy >= 90.0,
    'CHECK 2b (Every class F1 > 85%)': minF1 > 85.0,
    'CHECK 3 (15 sample predictions run)': tableRows.length === 15,
    'CHECK 4 (Non-leaf rejected)': check4Pass,
    'CHECK 5a (UI shows real metrics.json)': uiMetrics.bentoAcc === expectedAccStr && uiMetrics.heroAcc === expectedAccStr,
    'CHECK 5b (UI uncertain card works)': uncertainUI.uncertainVisible && uncertainUI.resultsGridHidden,
    'CHECK 5c (UI scope note present)': uiMetrics.scopeNote === 'Trained on bean leaves only.',
    'CHECK 5d (Zero browser console errors)': consoleErrors.length === 0
  };

  console.log('\n=== FINAL VERIFICATION SUMMARY ===');
  let allPassed = true;
  for (const [name, passed] of Object.entries(checks)) {
    console.log(`  ${passed ? 'PASS' : 'FAIL'} : ${name}`);
    if (!passed) allPassed = false;
  }

  if (!allPassed) {
    process.exitCode = 1;
  }
}

runAllChecks().catch(err => {
  console.error('Verification error:', err);
  process.exit(1);
});
