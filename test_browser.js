const puppeteer = require('puppeteer-core');
const path = require('path');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE_URL = 'http://localhost:3000';
const RESULTS_DIR = path.join(__dirname, 'results');

async function verifyCinemaUpgrade() {
  const health = await (await fetch(`${BASE_URL}/api/health`)).json();
  console.log('[Health]', health);
  if (!health.modelReady || !health.workerReady) {
    throw new Error('Server model or worker not ready');
  }

  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.toString()));

  // 1. Desktop 1440px Full-Bleed Cinema Hero
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForSelector('#loading-screen.loaded', { timeout: 10000 });
  await new Promise(r => setTimeout(r, 1200));
  await page.screenshot({ path: path.join(RESULTS_DIR, 'cinema_hero_1440.png') });
  console.log('1. Full-Bleed Cinema Hero 1440px saved.');

  // 2. Scroll-Scrubbed 3D Leaf Dissection + Live 3D Bean Rust Pathology Switch
  const hudSnapshots = [];
  for (const scrollY of [1100, 1750, 2350, 2850]) {
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await new Promise(r => setTimeout(r, 450));
    const hud = await page.evaluate(() => document.getElementById('hud-layer-readout')?.textContent?.trim());
    hudSnapshots.push({ scrollY, hud });
  }
  console.log('2. Scroll-driven 3D leaf opening HUD snapshots:', hudSnapshots);

  // Capture real photographed leaf dissected open!
  await page.evaluate(() => window.scrollTo(0, 1750));
  await new Promise(r => setTimeout(r, 550));
  await page.screenshot({ path: path.join(RESULTS_DIR, 'cinema_dissection_rust.png') });
  console.log('2b. Dissected Real Leaf screenshot saved.');

  // Test switching to Chlorophyll #7ABF5A/#9BF272 mode and back to Original Leaf
  await page.click('.pathology-3d-btn[data-path-3d="chlorophyll"]');
  await new Promise(r => setTimeout(r, 300));
  await page.click('.pathology-3d-btn[data-path-3d="original"]');
  await new Promise(r => setTimeout(r, 250));

  // 3. Click sample slide -> Results panel
  await page.waitForSelector('.sample-chip', { timeout: 5000 });
  await page.click('.sample-chip');
  await page.waitForSelector('#results-section.active', { timeout: 10000 });
  await new Promise(r => setTimeout(r, 800));
  const resSummary = await page.evaluate(() => ({
    disease: document.getElementById('disease-name')?.textContent?.trim(),
    confidence: document.getElementById('confidence-val')?.textContent?.trim(),
    hasGradcam: document.getElementById('comparison-gradcam')?.src?.startsWith('data:image/png;base64,')
  }));
  console.log('3. Live scan result:', resSummary);

  // 4. Click predicted disease card -> Full Pathology Dossier Drawer + Tab Switch
  await page.click('#diagnosis-clickable-card');
  await new Promise(r => setTimeout(r, 600));
  await page.screenshot({ path: path.join(RESULTS_DIR, 'cinema_dossier.png') });

  // Switch to Bean Rust tab right inside drawer
  await page.click('.dossier-class-tab[data-dossier-tab="bean_rust"]');
  await new Promise(r => setTimeout(r, 300));
  const switchedTitle = await page.evaluate(() => document.getElementById('dossier-title')?.textContent?.trim());
  console.log('4. Dossier tab switch verified -> title:', switchedTitle);
  await page.click('#dossier-close-btn');
  await new Promise(r => setTimeout(r, 400));

  // 5. Scroll to Dark-Mode Data Studio Benchmarks
  await page.evaluate(() => document.getElementById('performance')?.scrollIntoView({ behavior: 'instant' }));
  await new Promise(r => setTimeout(r, 700));
  const benchState = await page.evaluate(() => ({
    cmCells: document.querySelectorAll('#cm-studio-grid .cm-cell').length,
    classRows: document.querySelectorAll('#class-perf-list .class-perf-row').length,
    bentoAcc: document.getElementById('bento-acc')?.textContent?.trim(),
    bentoF1: document.getElementById('bento-f1')?.textContent?.trim(),
    scopeNote: document.querySelector('.scan-scope-note')?.textContent?.trim()
  }));
  console.log('5. Dark-Mode Data Studio Benchmarks:', benchState);
  await page.screenshot({ path: path.join(RESULTS_DIR, 'cinema_benchmarks.png') });

  // 6. Mobile 390px layout check
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise(r => setTimeout(r, 500));
  const mobileWidth = await page.evaluate(() => document.body.scrollWidth);
  await page.screenshot({ path: path.join(RESULTS_DIR, 'cinema_mobile_390.png') });
  console.log('6. Mobile 390px body.scrollWidth:', mobileWidth);
  console.log('7. Browser Console Errors:', errors.length, errors);

  await browser.close();

  if (errors.length > 0 || mobileWidth > 390 || switchedTitle !== 'Bean Rust' || benchState.cmCells !== 9) {
    process.exit(1);
  }
  console.log('\nALL CINEMA UPGRADE TESTS PASSED 100%!');
}

verifyCinemaUpgrade().catch(e => {
  console.error(e);
  process.exit(1);
});
