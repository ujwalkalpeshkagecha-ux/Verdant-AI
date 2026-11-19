// UI Choreography, Lenis, GSAP ScrollTrigger Cinema Dissection, Spotlight Sheen & Dark-Mode Data Studio

let lenisInstance = null;

export function initUI() {
  setupCustomCursor();
  setupSpotlightPanels();
  setupSmoothScroll();
  setupLoadingScreen();
  setupMagneticButtons();
  setupLayerAndPathologyControls();
  setupGSAPAnimations();
  setupScrollProgressRail();
  loadMetricsData();
  setupToast();
}

// Custom Editorial Cursor (hidden until first move)
function setupCustomCursor() {
  const cursor = document.getElementById('custom-cursor');
  const follower = document.getElementById('custom-cursor-follower');
  if (!cursor || !follower) return;

  let mouseX = -100, mouseY = -100;
  let followerX = -100, followerY = -100;
  let shown = false;

  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    if (!shown) {
      shown = true;
      followerX = mouseX;
      followerY = mouseY;
      cursor.classList.add('visible');
      follower.classList.add('visible');
    }
    cursor.style.transform = `translate(${mouseX}px, ${mouseY}px)`;
  });

  function renderFollower() {
    followerX += (mouseX - followerX) * 0.16;
    followerY += (mouseY - followerY) * 0.16;
    follower.style.transform = `translate(${followerX}px, ${followerY}px)`;
    requestAnimationFrame(renderFollower);
  }
  requestAnimationFrame(renderFollower);

  const hoverSelector = 'a, button, .btn, .sample-chip, .scan-dropzone, .slider-handle, .diagnosis-clickable-card, .pathology-card, .prob-item, .cm-cell';
  document.addEventListener('mouseover', (e) => {
    if (e.target.closest(hoverSelector)) follower.classList.add('hovering');
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest(hoverSelector)) follower.classList.remove('hovering');
  });
}

// Pointer-Tracked Radial Spotlight on Every Studio Panel
function setupSpotlightPanels() {
  document.addEventListener('mousemove', (e) => {
    const panel = e.target.closest('.studio-panel');
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    panel.style.setProperty('--mx', `${e.clientX - rect.left}px`);
    panel.style.setProperty('--my', `${e.clientY - rect.top}px`);
  }, { passive: true });
}

// Lenis Smooth Inertial Scrolling + Drawer Pause Hook
function setupSmoothScroll() {
  if (typeof window.Lenis !== 'undefined') {
    lenisInstance = new window.Lenis({
      duration: 1.15,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      wheelMultiplier: 1.0
    });

    function raf(time) {
      lenisInstance.raf(time);
      requestAnimationFrame(raf);
    }
    requestAnimationFrame(raf);

    if (typeof gsap !== 'undefined' && typeof ScrollTrigger !== 'undefined') {
      lenisInstance.on('scroll', ScrollTrigger.update);
      gsap.ticker.add((time) => {
        lenisInstance.raf(time * 1000);
      });
      gsap.ticker.lagSmoothing(0);
    }

    document.querySelectorAll('a[href^="#"]').forEach(link => {
      link.addEventListener('click', (e) => {
        const href = link.getAttribute('href');
        if (!href || href === '#') return;
        const target = document.querySelector(href);
        if (target && lenisInstance) {
          e.preventDefault();
          lenisInstance.scrollTo(target, { offset: -72 });
        }
      });
    });
  }

  window.setLenisPaused = (paused) => {
    if (!lenisInstance) return;
    if (paused) lenisInstance.stop();
    else lenisInstance.start();
  };
}

// Fast Editorial Preloader
function setupLoadingScreen() {
  const loader = document.getElementById('loading-screen');
  const bar = document.getElementById('loader-bar');
  const count = document.getElementById('loader-count');
  if (!loader) return;

  let progress = 0;
  const interval = setInterval(() => {
    progress += Math.floor(Math.random() * 18) + 16;
    if (progress >= 100) {
      progress = 100;
      clearInterval(interval);
      setTimeout(() => {
        loader.classList.add('loaded');
        animateHeroEntry();
      }, 200);
    }
    if (bar) bar.style.width = `${progress}%`;
    if (count) count.textContent = `${String(progress).padStart(2, '0')}%`;
  }, 38);
}

// Magnetic Hover on Primary CTAs
function setupMagneticButtons() {
  document.querySelectorAll('.magnetic-btn').forEach(btn => {
    btn.addEventListener('mousemove', (e) => {
      const rect = btn.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 2;
      const y = e.clientY - rect.top - rect.height / 2;
      btn.style.transform = `translate(${x * 0.16}px, ${y * 0.16}px)`;
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = `translate(0px, 0px)`;
    });
  });
}

// Interactive 3D Layer Preset & Live 3D Pathology Surface Buttons
function setupLayerAndPathologyControls() {
  const layerButtons = document.querySelectorAll('.layer-btn[data-layer-preset]');
  const hudReadout = document.getElementById('hud-layer-readout');
  const presetLabels = {
    scroll: 'SCROLL SYNC',
    assembled: 'ASSEMBLED · 0%',
    cuticle: 'LAYER 01 · CUTICLE',
    veins: 'LAYER 02 · VEINS',
    mesophyll: 'LAYER 03 · MESOPHYLL',
    gradcam: 'LAYER 04 · GRAD-CAM'
  };

  layerButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.getAttribute('data-layer-preset');
      layerButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      window.leafScan3D?.setLayerPreset(preset);
      if (hudReadout && presetLabels[preset]) {
        hudReadout.textContent = presetLabels[preset];
      }
    });
  });

  const pathButtons = document.querySelectorAll('.pathology-3d-btn[data-path-3d]');
  pathButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-path-3d');
      pathButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      window.leafScan3D?.setPathologyPreview(mode);
    });
  });
}

// Scroll Progress Rail
function setupScrollProgressRail() {
  const bar = document.getElementById('scroll-progress-bar');
  if (!bar) return;
  const update = () => {
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const pct = docHeight > 0 ? Math.min(100, Math.max(0, (window.scrollY / docHeight) * 100)) : 0;
    bar.style.width = `${pct}%`;
  };
  window.addEventListener('scroll', update, { passive: true });
  update();
}

// GSAP ScrollTrigger Choreography
function setupGSAPAnimations() {
  if (typeof gsap === 'undefined') return;
  if (typeof ScrollTrigger !== 'undefined') {
    gsap.registerPlugin(ScrollTrigger);
  }

  // 1. Scroll-Driven Botanical Leaf Opening Choreography
  const chaptersWrap = document.getElementById('dissection-chapters');
  const chapterEls = Array.from(document.querySelectorAll('.chapter-step'));
  const hudReadout = document.getElementById('hud-layer-readout');

  const stageLabelFor = (p) => {
    const pct = Math.round(p * 100);
    if (p < 0.10) return `ASSEMBLED · ${pct}%`;
    if (p < 0.36) return `LAYER 01 · CUTICLE (${pct}%)`;
    if (p < 0.64) return `LAYER 02 · VEINS (${pct}%)`;
    if (p < 0.88) return `LAYER 03 · MESOPHYLL (${pct}%)`;
    return `LAYER 04 · GRAD-CAM (${pct}%)`;
  };

  if (chaptersWrap && typeof ScrollTrigger !== 'undefined') {
    ScrollTrigger.create({
      trigger: chaptersWrap,
      start: 'top 78%',
      end: 'bottom 62%',
      scrub: true,
      onUpdate: (self) => {
        const p = self.progress;
        window.leafScan3D?.setDissectionProgress(p);
        const scrollBtn = document.querySelector('.layer-btn[data-layer-preset="scroll"]');
        if (hudReadout && (!scrollBtn || scrollBtn.classList.contains('active'))) {
          hudReadout.textContent = stageLabelFor(p);
        }
        if (chapterEls.length > 0) {
          const activeIdx = Math.min(chapterEls.length - 1, Math.floor(p * chapterEls.length));
          chapterEls.forEach((el, idx) => el.classList.toggle('is-active', idx === activeIdx));
        }
      }
    });
  }

  // 2. Gracefully Recede 3D Specimen as User Enters Lower Darkroom Workspace
  const workspace = document.getElementById('workspace-backdrop');
  if (workspace && typeof ScrollTrigger !== 'undefined') {
    ScrollTrigger.create({
      trigger: workspace,
      start: 'top 95%',
      end: 'top 20%',
      scrub: true,
      onUpdate: (self) => {
        window.leafScan3D?.setPageExitProgress(self.progress);
      }
    });
  }

  // 3. Editorial Section Reveals
  gsap.utils.toArray('.reveal-up').forEach(el => {
    gsap.from(el, {
      scrollTrigger: {
        trigger: el,
        start: 'top 86%',
        toggleActions: 'play none none none'
      },
      y: 30,
      opacity: 0,
      duration: 0.75,
      ease: 'power3.out'
    });
  });

  gsap.from('.pathology-card', {
    scrollTrigger: { trigger: '#pathology-guide-grid', start: 'top 84%' },
    y: 26,
    opacity: 0,
    duration: 0.65,
    stagger: 0.12,
    ease: 'power3.out'
  });

  gsap.from('.bento-grid > div', {
    scrollTrigger: { trigger: '.bento-grid', start: 'top 82%' },
    y: 26,
    opacity: 0,
    duration: 0.65,
    stagger: 0.08,
    ease: 'power3.out'
  });
}

// Kinetic Split-Line Hero Reveal
function animateHeroEntry() {
  if (typeof gsap === 'undefined') return;
  gsap.timeline()
    .from('.hero-editorial-col .mono-kicker', { opacity: 0, y: 12, duration: 0.45 })
    .from('.headline-line > span', {
      y: '110%',
      duration: 0.85,
      stagger: 0.1,
      ease: 'power4.out'
    }, '-=0.2')
    .from('.hero-subline', { opacity: 0, y: 14, duration: 0.5 }, '-=0.45')
    .from('.hero-cta-group', { opacity: 0, y: 14, duration: 0.5 }, '-=0.35')
    .from('.hero-telemetry-strip', { opacity: 0, y: 16, duration: 0.55 }, '-=0.35');

  countUpNumbers();
}

function countUpElement(el) {
  if (!el || el.dataset.metricsLoaded === '1') return;
  if (el._countTimer) clearInterval(el._countTimer);
  const target = parseFloat(el.getAttribute('data-count-target'));
  if (isNaN(target)) return;
  const isPercent = el.getAttribute('data-is-percent') === 'true';
  let current = 0;
  const duration = 600;
  const steps = 24;
  const increment = target / steps;
  el._countTimer = setInterval(() => {
    current += increment;
    if (current >= target) {
      current = target;
      clearInterval(el._countTimer);
      el._countTimer = null;
    }
    el.textContent = isPercent ? `${current.toFixed(1)}%` : (Number.isInteger(target) ? Math.round(current) : current.toFixed(1));
  }, duration / steps);
}

function countUpNumbers() {
  document.querySelectorAll('[data-count-target]').forEach(el => countUpElement(el));
}

// Render Interactive Dark-Mode Confusion Matrix & Per-Class F1 Studio Bars from metrics.json
function renderDarkModeBenchmarks(m) {
  const cmGrid = document.getElementById('cm-studio-grid');
  if (cmGrid && m.confusion_matrix && m.confusion_matrix.matrix) {
    const labels = m.confusion_matrix.labels || ['angular_leaf_spot', 'bean_rust', 'healthy'];
    const matrix = m.confusion_matrix.matrix;
    const shortName = (c) => {
      if (c === 'angular_leaf_spot') return 'Leaf Spot';
      if (c === 'bean_rust') return 'Bean Rust';
      return 'Healthy';
    };

    cmGrid.innerHTML = '';
    // Top-left empty corner + Predicted column headers
    const corner = document.createElement('div');
    corner.className = 'cm-axis-head';
    corner.textContent = 'True ↓ / Pred →';
    cmGrid.appendChild(corner);

    labels.forEach(lbl => {
      const th = document.createElement('div');
      th.className = 'cm-axis-head';
      th.textContent = shortName(lbl);
      cmGrid.appendChild(th);
    });

    matrix.forEach((row, rIdx) => {
      const rowTotal = row.reduce((a, b) => a + b, 0) || 1;
      const rl = document.createElement('div');
      rl.className = 'cm-row-label';
      rl.textContent = shortName(labels[rIdx]);
      cmGrid.appendChild(rl);

      row.forEach((val, cIdx) => {
        const pct = (val / rowTotal) * 100;
        const isDiag = rIdx === cIdx;
        const intensity = Math.min(1, val / rowTotal);
        const bg = isDiag
          ? `rgba(155, 242, 114, ${0.12 + intensity * 0.24})`
          : (val > 0 ? `rgba(232, 111, 84, ${0.10 + intensity * 0.35})` : 'rgba(186, 200, 217, 0.04)');
        const border = isDiag
          ? `rgba(155, 242, 114, ${0.26 + intensity * 0.38})`
          : (val > 0 ? 'rgba(232, 111, 84, 0.40)' : 'var(--hairline)');

        const cell = document.createElement('div');
        cell.className = 'cm-cell';
        cell.style.background = bg;
        cell.style.borderColor = border;
        cell.title = `True: ${labels[rIdx]} | Predicted: ${labels[cIdx]} (${val}/${rowTotal} = ${pct.toFixed(1)}%)`;
        cell.innerHTML = `
          <span class="cm-cell-count">${val}</span>
          <span class="cm-cell-pct">${pct.toFixed(0)}%</span>
        `;
        cmGrid.appendChild(cell);
      });
    });
  }

  const classList = document.getElementById('class-perf-list');
  if (classList && m.classes) {
    classList.innerHTML = '';
    Object.entries(m.classes).forEach(([cls, st]) => {
      const row = document.createElement('div');
      row.className = 'class-perf-row';
      row.innerHTML = `
        <div class="class-perf-head">
          <span class="class-perf-name">${cls.replace(/_/g, ' ')}</span>
          <span class="class-perf-stats">
            <span>P: ${Number(st.precision).toFixed(1)}%</span>
            <span>R: ${Number(st.recall).toFixed(1)}%</span>
            <strong>F1: ${Number(st.f1_score).toFixed(1)}%</strong>
          </span>
        </div>
        <div class="class-perf-track">
          <div class="class-perf-fill" style="width: ${Math.min(100, st.f1_score)}%"></div>
        </div>
      `;
      classList.appendChild(row);
    });
  }
}

// Live Metrics from results/metrics.json
async function loadMetricsData() {
  try {
    const res = await fetch('/api/metrics', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.metrics) return;

    const m = data.metrics;
    const setMetric = (el, val) => {
      if (!el || val == null) return;
      if (el._countTimer) {
        clearInterval(el._countTimer);
        el._countTimer = null;
      }
      el.dataset.metricsLoaded = '1';
      el.setAttribute('data-count-target', String(val));
      el.textContent = `${Number(val).toFixed(1)}%`;
    };

    setMetric(document.getElementById('bento-acc'), m.accuracy);
    if (m.macro_avg) {
      setMetric(document.getElementById('bento-prec'), m.macro_avg.precision);
      setMetric(document.getElementById('bento-rec'), m.macro_avg.recall);
      setMetric(document.getElementById('bento-f1'), m.macro_avg.f1_score);
    }

    const heroAccEl = document.getElementById('hero-stat-accuracy');
    if (heroAccEl && m.accuracy != null) {
      heroAccEl.textContent = `${Number(m.accuracy).toFixed(1)}%`;
    }

    renderDarkModeBenchmarks(m);

    if (data.images) {
      const ts = Date.now();
      const cmImg = document.getElementById('bento-cm-img');
      const curvesImg = document.getElementById('bento-curves-img');
      if (cmImg && data.images.confusion_matrix) cmImg.src = `${data.images.confusion_matrix}?t=${ts}`;
      if (curvesImg && data.images.accuracy_loss_curves) curvesImg.src = `${data.images.accuracy_loss_curves}?t=${ts}`;
    }
  } catch (err) {
    console.warn('Could not load metrics:', err);
  }
}

function setupToast() {
  let toastContainer = document.getElementById('toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }

  window.showToast = (msg, type = 'info') => {
    const toast = document.createElement('div');
    toast.className = 'toast';
    const color = type === 'error' ? 'var(--accent-rust)' : (type === 'info' ? 'var(--accent-amber)' : 'var(--accent-leaf)');
    const icon = type === 'success' ? '✓' : (type === 'error' ? '✕' : '!');
    toast.innerHTML = `<span style="color: ${color}; font-weight: 700;">${icon}</span> <span>${msg}</span>`;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(12px)';
      toast.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
      setTimeout(() => toast.remove(), 260);
    }, 3600);
  };
}
