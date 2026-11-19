// Verdant AI - Main Entry Point

import { init3DScenes } from './scene3d.js';
import { initScanner } from './scanner.js';
import { initUI } from './ui.js';
import { initFeatures } from './features.js';

document.addEventListener('DOMContentLoaded', () => {
  console.log('[Verdant AI] Initializing botanical vision cinema...');
  init3DScenes();
  initScanner();
  initUI();
  initFeatures();
  console.log('[Verdant AI] All systems ready.');
});
