const { spawn, spawnSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const BASE_DIR = __dirname;
const IS_WIN = process.platform === 'win32';
const VENV_DIR = path.join(BASE_DIR, '.venv');
const VENV_PYTHON = IS_WIN
  ? path.join(VENV_DIR, 'Scripts', 'python.exe')
  : path.join(VENV_DIR, 'bin', 'python');
const MODEL_FILE = path.join(BASE_DIR, 'model', 'model.keras');
const REQ_FILE = path.join(BASE_DIR, 'requirements.txt');

console.log('====================================================');
console.log('   VERDANT AI (LeafScan 3D) - Intelligent Launch    ');
console.log('====================================================\n');

function checkPythonVersion(cmd, args = ['--version']) {
  try {
    const res = spawnSync(cmd, args, { encoding: 'utf-8', shell: false });
    if (res.status === 0) {
      const output = (res.stdout || '') + (res.stderr || '');
      const match = output.match(/Python\s+([0-9]+)\.([0-9]+)\.([0-9]+)/i);
      if (match) {
        const major = parseInt(match[1], 10);
        const minor = parseInt(match[2], 10);
        return { major, minor, raw: match[0], cmd, args };
      }
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function findSuitablePython() {
  console.log('[Setup] Detecting compatible Python (3.10 - 3.12)...');

  // Candidate commands
  const candidates = IS_WIN
    ? [
        { cmd: 'py', args: ['-3.12', '--version'], runArgs: ['-3.12'] },
        { cmd: 'py', args: ['-3.11', '--version'], runArgs: ['-3.11'] },
        { cmd: 'py', args: ['-3.10', '--version'], runArgs: ['-3.10'] },
        { cmd: 'python3.12', args: ['--version'], runArgs: [] },
        { cmd: 'python3.11', args: ['--version'], runArgs: [] },
        { cmd: 'python3.10', args: ['--version'], runArgs: [] },
        { cmd: 'python3', args: ['--version'], runArgs: [] },
        { cmd: 'python', args: ['--version'], runArgs: [] },
        { cmd: 'py', args: ['--version'], runArgs: [] }
      ]
    : [
        { cmd: 'python3.12', args: ['--version'], runArgs: [] },
        { cmd: 'python3.11', args: ['--version'], runArgs: [] },
        { cmd: 'python3.10', args: ['--version'], runArgs: [] },
        { cmd: 'python3', args: ['--version'], runArgs: [] },
        { cmd: 'python', args: ['--version'], runArgs: [] }
      ];

  for (const c of candidates) {
    const info = checkPythonVersion(c.cmd, c.args);
    if (info && info.major === 3 && info.minor >= 10 && info.minor <= 12) {
      console.log(`[Setup] Found compatible Python: ${info.raw} via '${c.cmd} ${c.runArgs.join(' ')}'`);
      return { cmd: c.cmd, runArgs: c.runArgs, version: info.raw };
    }
  }

  // If no 3.10-3.12 found, check fallback python
  const fallback = checkPythonVersion('python') || checkPythonVersion('python3') || checkPythonVersion('py');
  if (fallback) {
    console.warn(`[Setup] Note: Found ${fallback.raw}. TensorFlow works best on Python 3.10-3.12.`);
    if (fallback.major === 3 && fallback.minor >= 10 && fallback.minor <= 12) {
      return { cmd: fallback.cmd, runArgs: [], version: fallback.raw };
    }
  }

  console.error('\n[ERROR] Python 3.10 - 3.12 is required for TensorFlow.');
  console.error('Please install Python 3.10, 3.11, or 3.12 from https://www.python.org/downloads/');
  console.error('If on Windows, you can install Python 3.12 or run "winget install Python.Python.3.12".');
  process.exit(1);
}

function ensureVenv() {
  if (fs.existsSync(VENV_PYTHON)) {
    console.log('[Setup] Python virtual environment (.venv) already exists.');
    return;
  }

  const py = findSuitablePython();
  console.log(`[Setup] Creating virtual environment at .venv using ${py.version}...`);
  const venvArgs = [...py.runArgs, '-m', 'venv', '.venv'];
  const res = spawnSync(py.cmd, venvArgs, { cwd: BASE_DIR, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error('[Setup] Failed to create virtual environment.');
    process.exit(1);
  }
  console.log('[Setup] Virtual environment created successfully.');

  console.log('[Setup] Installing requirements from requirements.txt...');
  const pipRes = spawnSync(VENV_PYTHON, ['-m', 'pip', 'install', '-r', REQ_FILE], {
    cwd: BASE_DIR,
    stdio: 'inherit'
  });
  if (pipRes.status !== 0) {
    console.error('[Setup] Pip install encountered errors.');
    process.exit(1);
  }
  console.log('[Setup] Dependencies installed successfully.');
}

function ensureModel() {
  if (fs.existsSync(MODEL_FILE)) {
    console.log('[Model] Trained model found at model/model.keras. Ready.');
    return;
  }

  console.log('\n[Model] model/model.keras not found. Starting automatic dataset download and training...');
  const trainScript = path.join(BASE_DIR, 'python', 'train.py');
  const res = spawnSync(VENV_PYTHON, [trainScript], {
    cwd: BASE_DIR,
    stdio: 'inherit'
  });

  if (res.status !== 0 || !fs.existsSync(MODEL_FILE)) {
    console.error('[Model] Training failed or model.keras was not created.');
    process.exit(1);
  }
  console.log('[Model] Training complete and verified!');
}

function startApp() {
  ensureVenv();
  ensureModel();

  console.log('\n[Server] Starting Express Web Application...');
  const server = require('./server.js');
  server.startServer();
}

startApp();
