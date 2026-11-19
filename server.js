const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const readline = require('readline');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_DIR = __dirname;
const MODEL_FILE = path.join(BASE_DIR, 'model', 'model.keras');
const METRICS_FILE = path.join(BASE_DIR, 'results', 'metrics.json');
const UPLOADS_DIR = path.join(BASE_DIR, 'uploads');
const SAMPLES_DIR = path.join(BASE_DIR, 'samples');
const RESULTS_DIR = path.join(BASE_DIR, 'results');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Serve static directories
app.use(express.static(path.join(BASE_DIR, 'public')));
app.use('/results', express.static(RESULTS_DIR));
app.use('/samples', express.static(SAMPLES_DIR));
app.use('/vendor', express.static(path.join(BASE_DIR, 'node_modules')));

// Configure Multer for image upload (max 5MB, image only)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `upload_${Date.now()}_${Math.random().toString(36).substring(2, 9)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/i;
    const isMime = allowed.test(file.mimetype);
    const isExt = allowed.test(path.extname(file.originalname).toLowerCase());
    if (isMime || isExt) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and WebP images are allowed.'));
    }
  }
});

// Helper to determine python executable
function getPythonCommand() {
  const isWindows = process.platform === 'win32';
  const venvPython = isWindows
    ? path.join(BASE_DIR, '.venv', 'Scripts', 'python.exe')
    : path.join(BASE_DIR, '.venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return isWindows ? 'python' : 'python3';
}

// Persistent Python Predict Worker
let workerProcess = null;
let workerReady = false;
let workerRl = null;
const requestQueue = [];

function startPredictWorker() {
  if (!fs.existsSync(MODEL_FILE)) {
    console.log('[Worker] Model file not yet available. Waiting for training...');
    return;
  }

  const pythonCmd = getPythonCommand();
  const scriptPath = path.join(BASE_DIR, 'python', 'predict_worker.py');

  console.log(`[Worker] Spawning Python worker: ${pythonCmd} ${scriptPath}`);
  workerReady = false;

  try {
    workerProcess = spawn(pythonCmd, ['-u', scriptPath], {
      cwd: BASE_DIR,
      stdio: ['pipe', 'pipe', 'inherit']
    });

    workerRl = readline.createInterface({
      input: workerProcess.stdout,
      crlfDelay: Infinity
    });

    workerRl.on('line', (line) => {
      line = line.trim();
      if (!line) return;
      try {
        const msg = JSON.parse(line);
        if (msg.status === 'ready') {
          console.log('[Worker] Python predict worker is ready and model loaded.');
          workerReady = true;
          processNextInQueue();
        } else {
          // Resolve current in-flight request
          if (currentRequest) {
            const { resolve } = currentRequest;
            currentRequest = null;
            resolve(msg);
            processNextInQueue();
          }
        }
      } catch (e) {
        console.error('[Worker] JSON parse error from worker output:', e, line);
        if (currentRequest) {
          const { reject } = currentRequest;
          currentRequest = null;
          reject(e);
          processNextInQueue();
        }
      }
    });

    workerProcess.on('error', (err) => {
      console.error('[Worker] Process error:', err);
      workerReady = false;
      rejectAllQueue(new Error('Worker process failed to start'));
    });

    workerProcess.on('exit', (code, signal) => {
      console.warn(`[Worker] Python worker exited with code ${code}, signal ${signal}. Restarting in 2s...`);
      workerReady = false;
      workerProcess = null;
      workerRl = null;
      if (currentRequest) {
        currentRequest.reject(new Error('Worker crashed during inference'));
        currentRequest = null;
      }
      setTimeout(() => {
        if (fs.existsSync(MODEL_FILE)) {
          startPredictWorker();
        }
      }, 2000);
    });

  } catch (err) {
    console.error('[Worker] Failed to spawn worker:', err);
  }
}

let currentRequest = null;

function processNextInQueue() {
  if (currentRequest || requestQueue.length === 0) return;
  if (!workerReady || !workerProcess || !workerProcess.stdin.writable) return;

  currentRequest = requestQueue.shift();
  try {
    const payload = JSON.stringify({ image_path: currentRequest.imagePath }) + '\n';
    workerProcess.stdin.write(payload);
  } catch (err) {
    const req = currentRequest;
    currentRequest = null;
    req.reject(err);
    processNextInQueue();
  }
}

function rejectAllQueue(err) {
  while (requestQueue.length > 0) {
    const item = requestQueue.shift();
    item.reject(err);
  }
}

function predictImage(imagePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(MODEL_FILE)) {
      return reject(new Error('Model is still training or missing. Please wait for training to finish.'));
    }
    if (!workerProcess && !workerReady) {
      startPredictWorker();
    }
    requestQueue.push({ imagePath, resolve, reject });
    processNextInQueue();
  });
}

// Initial worker startup if model exists
if (fs.existsSync(MODEL_FILE)) {
  startPredictWorker();
}

// API Routes
app.get('/api/health', (req, res) => {
  const modelReady = fs.existsSync(MODEL_FILE);
  if (modelReady && !workerProcess && !workerReady) {
    startPredictWorker();
  }
  res.json({
    status: 'ok',
    modelReady,
    workerReady,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/metrics', (req, res) => {
  if (!fs.existsSync(METRICS_FILE)) {
    return res.status(404).json({
      error: 'Metrics not generated yet. Model is training or results missing.',
      modelReady: fs.existsSync(MODEL_FILE)
    });
  }

  try {
    const metricsData = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf-8'));
    let classificationReport = '';
    const reportPath = path.join(RESULTS_DIR, 'classification_report.txt');
    if (fs.existsSync(reportPath)) {
      classificationReport = fs.readFileSync(reportPath, 'utf-8');
    }

    const gradcamSamples = [];
    for (let i = 1; i <= 4; i++) {
      const gPath = path.join(RESULTS_DIR, `gradcam_sample_${i}.png`);
      if (fs.existsSync(gPath)) {
        gradcamSamples.push(`/results/gradcam_sample_${i}.png`);
      }
    }

    res.json({
      metrics: metricsData,
      report: classificationReport,
      images: {
        confusion_matrix: '/results/confusion_matrix.png',
        accuracy_loss_curves: '/results/accuracy_loss_curves.png',
        gradcam_samples: gradcamSamples
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read metrics: ' + err.message });
  }
});

// Comprehensive Agronomic Pathology Catalog
const DISEASE_CATALOG = {
  angular_leaf_spot: {
    id: 'angular_leaf_spot',
    code: 'PATH-01',
    name: 'Angular Leaf Spot',
    scientific_name: 'Pseudocercospora griseola',
    pathogen: 'Pseudocercospora griseola (Fungal Pathogen)',
    severity: 'Moderate to High',
    yield_impact: 'Up to 50–80% yield loss in warm, wet seasons if untreated',
    summary: 'A destructive foliar fungal disease of common bean (Phaseolus vulgaris) characterized by sharp-edged, vein-delimited necrotic lesions that cause premature leaf yellowing and severe defoliation.',
    what_is_it: {
      overview: 'Angular Leaf Spot attacks leaf parenchyma tissue while being physically restricted by the plant’s minor vascular veins—producing unmistakable geometric, angular grey-to-dark-brown patches. As lesions coalesce, surrounding chlorophyll breaks down into chlorotic halos and leaves drop prematurely, starving developing pods.',
      symptoms: [
        'Sharp, angular grey-brown spots strictly bounded by fine leaf veins.',
        'Thin yellow (chlorotic) margins expanding around dark necrotic blocks.',
        'Dark grey-to-black velvety fungal spore columns (synnemata) visible on the underside of humid leaves.',
        'Severe cases extend to stems, petioles, and circular dark sunken spots on bean pods.',
        'Rapid lower-canopy yellowing followed by premature defoliation.'
      ]
    },
    causes: {
      primary_cause: 'Infection by the imperfect fungus Pseudocercospora griseola (formerly Phaeoisariopsis griseola), entering leaf stomata via germinating conidia.',
      environmental_triggers: [
        { label: 'Temperature Window', value: '18°C – 28°C (Optimal: ~24°C)' },
        { label: 'Humidity & Wetness', value: '>85% RH with alternating wet/dry cycles' },
        { label: 'Incubation Period', value: '7 – 12 days from spore deposition to visible spots' }
      ],
      spread_vectors: [
        'Overwintered crop debris left on the soil surface from previous bean harvests (can survive 18+ months).',
        'Contaminated seed coats carrying dormant fungal mycelium into fresh fields.',
        'Rain-splash, overhead sprinkler irrigation, and wind-driven droplets dispersing conidia across adjacent rows.',
        'Field workers, tools, or machinery brushing through wet foliage.'
      ]
    },
    treatment: {
      immediate_actions: [
        'Isolate and carefully bag heavily blighted lower leaves without shaking dry spores onto neighboring healthy rows.',
        'Halt overhead watering immediately; switch to morning drip or furrow irrigation to keep foliage dry overnight.',
        'Avoid entering or cultivating the field while leaves are wet with dew or rain.'
      ],
      chemical_biological: [
        'Protectant / Fungicide options: Copper hydroxide, azoxystrobin (QoI), or chlorothalonil applied at first lesion detection on a 7–14 day interval.',
        'Rotate FRAC fungicide groups (e.g., FRAC 11 with FRAC M1/M5) to prevent fungal resistance.',
        'Biological support: Bacillus subtilis or Trichoderma foliar sprays can suppress secondary spore germination in organic systems.'
      ]
    },
    prevention: [
      'Practice strict 2-to-3-year crop rotation with non-legumes (maize, sorghum, brassicas, or small grains).',
      'Sow certified pathogen-free seed; avoid saving seed from pods harvested in infected plots.',
      'Incorporate or destroy infected bean straw and haulms immediately after harvest to accelerate residue breakdown.',
      'Space rows generously (45–60 cm) and orient along prevailing winds to accelerate morning dew evaporation.',
      'Select regionally adapted bean cultivars carrying Phg resistance genes.'
    ],
    recommendations: [
      'Apply copper hydroxide or azoxystrobin fungicide at first angular lesion sighting.',
      'Switch from overhead to root-zone drip irrigation and stay out of wet foliage.',
      'Rotate out of beans for 2–3 years and remove all infected post-harvest debris.'
    ]
  },
  bean_rust: {
    id: 'bean_rust',
    code: 'PATH-02',
    name: 'Bean Rust',
    scientific_name: 'Uromyces appendiculatus',
    pathogen: 'Uromyces appendiculatus (Obligate Basidiomycete Fungus)',
    severity: 'High Severity',
    yield_impact: '25–100% crop loss during rapid flowering-stage epidemics',
    summary: 'An aggressive airborne fungal rust that ruptures the leaf epidermis into hundreds of powdery, cinnamon-brown spore pustules (uredinia), rapidly dehydrating foliage and halting pod fill.',
    what_is_it: {
      overview: 'Bean Rust begins as tiny, pale-yellow pinhead flecks that swell and burst through both upper and lower leaf cuticles within days, releasing rusty-brown powdery urediniospores that rub off on fingers. Heavy pustule density destroys stomatal regulation, causing leaves to curl, scorch, and drop off within two weeks.',
      symptoms: [
        'Minute pale-yellow raised specks appearing first on lower leaf surfaces.',
        'Ruptured circular rust-red / cinnamon-brown powdery pustules (1–2 mm), often ringed by a bright yellow chlorotic halo.',
        'Powdery orange-brown dust transfers onto fingers or white paper when rubbed.',
        'Late-season pustules darken to black teliospores that overwinter on dry plant stakes and debris.',
        'Leaf curling, bronzing, desiccation, and explosive canopy collapse.'
      ]
    },
    causes: {
      primary_cause: 'Obligate biotrophic rust fungus Uromyces appendiculatus, which penetrates directly through open stomata using appressoria.',
      environmental_triggers: [
        { label: 'Temperature Window', value: '17°C – 27°C (Cool nights + mild humid days)' },
        { label: 'Leaf Wetness', value: '10 – 18 continuous hours of dew or mist' },
        { label: 'Epidemic Cycle', value: 'New windborne spore generation every 10–14 days' }
      ],
      spread_vectors: [
        'Long-distance wind currents carrying lightweight urediniospores across kilometers from neighboring bean fields.',
        'Overwintering teliospores surviving on old bean trellises, wooden stakes, and unburied plant stems.',
        'Dense, over-fertilized canopies that trap stagnant humidity and prolong morning dew duration.'
      ]
    },
    treatment: {
      immediate_actions: [
        'Inspect leaf undersides across multiple rows immediately—early intervention before flowering is decisive.',
        'Remove and seal/burn initial hotspot leaves in small plots before pustules mature and release clouds of spores.',
        'Reduce excessive nitrogen top-dressing, which encourages lush, thin-walled foliage susceptible to rust penetration.'
      ],
      chemical_biological: [
        'Targeted Fungicides: Trifloxystrobin, azoxystrobin, tebuconazole, or sulfur/chlorothalonil protectants applied at initial fleck stage.',
        'Ensure fine nozzle coverage reaching the underside of leaves where primary stomatal infection occurs.',
        'Organic option: Wettable sulfur or neem-oil / potassium bicarbonate sprays applied in cool evening hours (avoid spraying sulfur above 30°C to prevent leaf burn).'
      ]
    },
    prevention: [
      'Plant certified rust-resistant bean varieties carrying Ur-gene stacks suited to local pathogen races.',
      'Rotate fields for at least 2 years and sanitize or replace wooden trellis poles/strings between seasons.',
      'Time planting early to avoid peak cool-dew seasonal rust pressure during flowering and pod set.',
      'Maintain wider plant spacing and control weeds inside rows to maximize cross-canopy airflow.',
      'Deep-plow or compost crop residue away from production beds immediately after final harvest.'
    ],
    recommendations: [
      'Apply trifloxystrobin, tebuconazole, or wettable sulfur targeting leaf undersides at first pustules.',
      'Increase row airflow, avoid late-day watering, and curb excess nitrogen.',
      'Plant Ur-resistant bean cultivars and sanitize trellis stakes between seasons.'
    ]
  },
  healthy: {
    id: 'healthy',
    code: 'NORM-00',
    name: 'Healthy Foliage',
    scientific_name: 'Phaseolus vulgaris (Optimal Baseline)',
    pathogen: 'No active foliar pathogen detected',
    severity: 'Optimal (Healthy)',
    yield_impact: 'Full photosynthetic capacity — 0% disease-induced yield loss',
    summary: 'Uniform chlorophyll density, intact epidermal cuticle, and clean vascular margins with no necrotic lesions, chlorotic halos, or fungal sporulation detected.',
    what_is_it: {
      overview: 'The examined specimen exhibits strong structural integrity across the epidermis, minor vein grid, and palisade mesophyll. Photosynthetic light absorption is unobstructed, indicating healthy root nutrient uptake and effective field sanitation.',
      symptoms: [
        'Even, vibrant medium-to-deep green chlorophyll coloration across the entire lamina.',
        'Clean leaf margins and well-defined minor veins free of angular necrotic blocks.',
        'Smooth abaxial (underside) surface devoid of powdery pustules or dark synnemata.',
        'Turgid tissue structure with no abnormal curling, wilting, or scorch halos.'
      ]
    },
    causes: {
      primary_cause: 'Balanced agronomy: clean seed stock, favorable canopy microclimate, and well-managed soil moisture and nutrition.',
      environmental_triggers: [
        { label: 'Optimal Daytime Temp', value: '20°C – 26°C for Phaseolus vulgaris' },
        { label: 'Soil pH Target', value: '6.0 – 6.8 (well-drained loamy soil)' },
        { label: 'Canopy Drying', value: 'Foliage dries within 2–3 hrs after sunrise' }
      ],
      spread_vectors: [
        'Preventive vigilance: pathogens can still arrive via windborne rust spores or rain splash after storms.',
        'Scout lower canopy undersides weekly, especially during flowering and pod elongation.'
      ]
    },
    treatment: {
      immediate_actions: [
        'No curative fungicide or tissue removal is required at this stage.',
        'Continue weekly scouting of lower-canopy undersides—early disease always appears on older shaded leaves first.',
        'Log baseline leaf health so sudden microclimate shifts after heavy rain can be compared accurately.'
      ],
      chemical_biological: [
        'Avoid unnecessary preventive synthetic fungicides to protect beneficial soil microbes and pollinators.',
        'Maintain rhizosphere vigor with Rhizobium leguminosarum inoculants and balanced P/K nutrition.'
      ]
    },
    prevention: [
      'Maintain consistent morning drip irrigation to prevent water stress without wetting the canopy.',
      'Keep rows weed-free to preserve airflow and eliminate alternate insect vectors (aphids, leafhoppers, whiteflies).',
      'Use certified disease-free seeds and preserve a 2–3 year legume rotation schedule.',
      'Sanitize pruners, stakes, and harvesting baskets between growing blocks.',
      'Apply balanced potassium and calcium to reinforce cell-wall thickness against future fungal entry.'
    ],
    recommendations: [
      'No treatment required — maintain morning drip irrigation keeping foliage dry.',
      'Scout lower-canopy leaf undersides weekly after humid or rainy spells.',
      'Preserve balanced P/K nutrition and 2-year crop rotation to keep fields disease-free.'
    ]
  }
};

app.get('/api/diseases', (req, res) => {
  res.json({ diseases: DISEASE_CATALOG });
});

app.get('/api/samples', (req, res) => {
  if (!fs.existsSync(SAMPLES_DIR)) {
    return res.json({ samples: [] });
  }
  const files = fs.readdirSync(SAMPLES_DIR)
    .filter(f => /\.(jpg|jpeg|png)$/i.test(f))
    .sort((a, b) => {
      // Prioritize _1 samples first so top 3 cover all 3 distinct classes
      const aOne = a.includes('_1.') ? 0 : 1;
      const bOne = b.includes('_1.') ? 0 : 1;
      if (aOne !== bOne) return aOne - bOne;
      return a.localeCompare(b);
    })
    .map(f => {
      let label = 'Unknown';
      if (f.includes('healthy')) label = 'Healthy Leaf';
      else if (f.includes('rust')) label = 'Bean Rust';
      else if (f.includes('spot')) label = 'Angular Leaf Spot';
      return {
        filename: f,
        label,
        url: `/samples/${f}`
      };
    });
  res.json({ samples: files });
});

app.post('/api/predict', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded. Please provide an image file under key "image".' });
  }

  const uploadedPath = req.file.path;

  try {
    const startTime = Date.now();
    const result = await predictImage(uploadedPath);
    const durationMs = Date.now() - startTime;

    // Clean up temporary upload file
    try {
      fs.unlinkSync(uploadedPath);
    } catch (e) {
      // ignore
    }

    if (result.status === 'error') {
      return res.status(500).json({ error: result.error });
    }

    if (result.status === 'not_a_leaf' || result.status === 'uncertain') {
      return res.json({
        status: result.status,
        message: result.message,
        reason: result.reason || null,
        uncertainty: result.uncertainty || null,
        probabilities: result.probabilities || null,
        top_candidate: result.top_candidate || null,
        leaf_check: result.leaf_check || null,
        inference_time_ms: durationMs
      });
    }

    const details = DISEASE_CATALOG[result.predicted_class] || {
      id: result.predicted_class,
      name: result.predicted_class,
      severity: 'Unknown',
      pathogen: 'Unknown',
      recommendations: ['Monitor plant closely and isolate if symptoms worsen.']
    };

    res.json({
      status: 'success',
      predicted_class: result.predicted_class,
      confidence: result.confidence,
      probabilities: result.probabilities,
      raw_probabilities: result.raw_probabilities || null,
      temperature: result.temperature || null,
      tta_agreement: result.tta_agreement || null,
      infected_area_pct: result.infected_area_pct ?? 0,
      severity_stage: result.severity_stage || null,
      action_threshold: result.action_threshold || null,
      gradcam_base64: result.gradcam_base64,
      heatmap_base64: result.heatmap_base64,
      contour_base64: result.contour_base64 || null,
      uncertainty: result.uncertainty || null,
      leaf_check: result.leaf_check || null,
      details,
      inference_time_ms: durationMs
    });

  } catch (err) {
    try {
      if (fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
    } catch (e) {}

    console.error('[API Predict Error]:', err.message);
    res.status(503).json({
      error: err.message || 'Inference error. Model may be loading.'
    });
  }
});

// Batch Field Scan Audit Endpoint (up to 15 leaf photos at once)
app.post('/api/predict-batch', upload.array('images', 15), async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ error: 'No images uploaded. Provide files under key "images".' });
  }

  const batchStart = Date.now();
  const results = [];
  const counts = { healthy: 0, angular_leaf_spot: 0, bean_rust: 0 };
  let uncertainCount = 0;
  let notLeafCount = 0;
  let infectedSum = 0;
  let confidentCount = 0;

  try {
    for (const file of files) {
      const t0 = Date.now();
      try {
        const pred = await predictImage(file.path);
        const ms = Date.now() - t0;

        if (pred.status === 'success') {
          confidentCount++;
          const cls = pred.predicted_class;
          if (cls in counts) counts[cls]++;
          const infPct = Number(pred.infected_area_pct ?? 0);
          infectedSum += infPct;
          results.push({
            filename: file.originalname,
            status: 'success',
            predicted_class: cls,
            confidence: pred.confidence,
            probabilities: pred.probabilities,
            raw_probabilities: pred.raw_probabilities || null,
            temperature: pred.temperature || null,
            tta_agreement: pred.tta_agreement || null,
            infected_area_pct: infPct,
            severity_stage: pred.severity_stage || null,
            action_threshold: pred.action_threshold || null,
            gradcam_base64: pred.gradcam_base64,
            heatmap_base64: pred.heatmap_base64,
            contour_base64: pred.contour_base64 || null,
            uncertainty: pred.uncertainty || null,
            leaf_check: pred.leaf_check || null,
            details: DISEASE_CATALOG[cls] || null,
            inference_time_ms: ms
          });
        } else {
          if (pred.status === 'not_a_leaf') notLeafCount++;
          else uncertainCount++;
          results.push({
            filename: file.originalname,
            status: pred.status,
            message: pred.message || 'Unable to classify specimen.',
            inference_time_ms: ms
          });
        }
      } finally {
        try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch {}
      }
    }

    // Rank worst-affected leaves first for agronomic triage
    results.sort((a, b) => {
      const aInf = a.status === 'success' ? (a.infected_area_pct || 0) : -1;
      const bInf = b.status === 'success' ? (b.infected_area_pct || 0) : -1;
      return bInf - aInf;
    });

    const healthyPct = confidentCount > 0 ? Number(((counts.healthy / confidentCount) * 100).toFixed(1)) : 0;
    const avgInfected = confidentCount > 0 ? Number((infectedSum / confidentCount).toFixed(1)) : 0;
    let overallStatus = 'Optimal Canopy';
    if (confidentCount === 0) overallStatus = 'Inconclusive Sample';
    else if (healthyPct < 50 || avgInfected >= 20) overallStatus = 'Action Required — Active Outbreak';
    else if (healthyPct < 85 || avgInfected >= 8) overallStatus = 'Watchlist — Localized Infection';

    res.json({
      status: 'success',
      summary: {
        total: files.length,
        confident: confidentCount,
        uncertain: uncertainCount,
        not_a_leaf: notLeafCount,
        counts,
        healthy_pct: healthyPct,
        avg_infected_area_pct: avgInfected,
        overall_field_status: overallStatus,
        total_time_ms: Date.now() - batchStart
      },
      results
    });
  } catch (err) {
    for (const f of files) {
      try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {}
    }
    res.status(503).json({ error: err.message || 'Batch inference failed.' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  } else if (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
  next();
});

function startServer() {
  app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(` Verdant AI Server is running at http://localhost:${PORT}`);
    console.log(`==================================================\n`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer, startPredictWorker };
