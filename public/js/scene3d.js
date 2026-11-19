import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ==========================================
// GENTLE ORGANIC 3D LEAF CURVATURE MESH
// Gives the real photographed leaf authentic 3D sculptural depth & light catch
// ==========================================
function buildCurvedSpecimenPlane(width, height, segX = 48, segY = 36) {
  const geom = new THREE.PlaneGeometry(width, height, segX, segY);
  const pos = geom.attributes.position;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const nx = x / (width * 0.5);  // -1 .. 1
    const ny = y / (height * 0.5); // -1 .. 1

    // Natural photographic cupping: subtle arch in center, gentle organic tip curl & lobe camber
    const longitudinalArch = Math.cos(ny * Math.PI * 0.45) * 0.24 - ny * 0.08;
    const lobeCup = -Math.pow(Math.abs(nx), 1.9) * 0.22;
    const organicWave = Math.sin(nx * 2.6 + ny * 1.4) * 0.035;
    const z = longitudinalArch + lobeCup + organicWave;

    pos.setZ(i, Number.isFinite(z) ? z : 0);
  }

  geom.computeVertexNormals();
  return geom;
}

function createMistMoteTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(186, 200, 217, 0.92)'); // #BAC8D9 mist mote
  g.addColorStop(0.35, 'rgba(155, 242, 114, 0.28)'); // #9BF272 soft halo
  g.addColorStop(1, 'rgba(25, 57, 64, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// ==========================================
// REAL PHOTOGRAPHIC 3D BOTANICAL CINEMA ENGINE
// Palette: #BAC8D9 (mist), #193940 (petrol teal), #9BF272 (lime), #7ABF5A (leaf green)
// ==========================================
class VerdantRealLeafCinema {
  constructor(canvas) {
    this.canvas = canvas;
    this.dissectionTarget = 0;
    this.dissectionCurrent = 0;
    this.manualPreset = null;
    this.pageExitTarget = 0;
    this.pageExitCurrent = 0;
    this.scanState = 'idle';
    this.tissueMode = 'original'; // 'original' | 'chlorophyll'

    this.mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    this.isDragging = false;
    this.prevDrag = { x: 0, y: 0 };
    this.dragRot = { x: 0, y: 0 };

    this.init();
  }

  init() {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x193940, 0.022);

    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(34, w / h, 0.1, 80);
    this.camera.position.set(0, 0, 11.2);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;

    // Studio HDR reflections for realistic waxy photographic highlights
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.28;
    pmrem.dispose();

    // Subtle photographic bloom (creamy highlights, never neon)
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.26, 0.52, 0.82);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    // Cinema Studio Lighting matching the user's photograph (cool #BAC8D9 sky + warm leaf backlight)
    const hemi = new THREE.HemisphereLight(0xbac8d9, 0x193940, 1.35);
    this.scene.add(hemi);

    this.keyLight = new THREE.DirectionalLight(0xfff6e8, 1.9);
    this.keyLight.position.set(5, 7, 9);
    this.scene.add(this.keyLight);

    this.rimLight = new THREE.DirectionalLight(0x9bf272, 1.45);
    this.rimLight.position.set(-7, 3, -5);
    this.scene.add(this.rimLight);

    this.mistBackLight = new THREE.PointLight(0xbac8d9, 1.8, 26);
    this.mistBackLight.position.set(2, 4, -4);
    this.scene.add(this.mistBackLight);

    // Floating Atmospheric Dust Motes (cinematic film depth)
    const moteCount = 320;
    const moteGeom = new THREE.BufferGeometry();
    const motePos = new Float32Array(moteCount * 3);
    for (let i = 0; i < moteCount; i++) {
      motePos[i * 3] = (Math.random() - 0.5) * 32;
      motePos[i * 3 + 1] = (Math.random() - 0.5) * 24;
      motePos[i * 3 + 2] = (Math.random() - 0.5) * 20 - 3;
    }
    moteGeom.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
    this.motes = new THREE.Points(moteGeom, new THREE.PointsMaterial({
      size: 0.24,
      map: createMistMoteTexture(),
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    }));
    this.scene.add(this.motes);

    // Load User's Real Leaf Assets (aspect ratio 663 / 444 = 1.4932)
    const loader = new THREE.TextureLoader();
    const loadSRGB = (url) => {
      const t = loader.load(url);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      return t;
    };

    this.texOriginal = loadSRGB('/assets/leaf-cutout.png');
    this.texChlorophyll = loadSRGB('/assets/leaf-cutout-green.png');
    this.texVeins = loadSRGB('/assets/leaf-veins.png');
    this.texMesophyll = loadSRGB('/assets/leaf-mesophyll.png');
    this.texGradCam = loadSRGB('/assets/leaf-gradcam.png');
    this.texBump = loader.load('/assets/leaf-bump.png');

    // Aspect-matched curved 3D geometry (preserves exact proportions of user's photo!)
    const aspect = 663 / 444;
    const leafHeight = 5.4;
    const leafWidth = leafHeight * aspect;
    const sharedGeom = buildCurvedSpecimenPlane(leafWidth, leafHeight, 48, 36);

    this.leafRoot = new THREE.Group();
    this.scene.add(this.leafRoot);

    // LAYER 1: User's Real Photographed Leaf Surface (Cuticle & Epidermis)
    this.cuticleMat = new THREE.MeshPhysicalMaterial({
      map: this.texOriginal,
      bumpMap: this.texBump,
      bumpScale: 0.04,
      roughness: 0.44,
      metalness: 0.02,
      clearcoat: 0.35,
      clearcoatRoughness: 0.35,
      transparent: true,
      alphaTest: 0.03,
      opacity: 1.0,
      side: THREE.DoubleSide
    });
    this.cuticleLayer = new THREE.Mesh(sharedGeom, this.cuticleMat);
    this.cuticleLayer.renderOrder = 3;
    this.leafRoot.add(this.cuticleLayer);

    // LAYER 2: Real Extracted Vascular Vein Skeleton (#9BF272 glowing veins from user's photo!)
    this.veinMat = new THREE.MeshBasicMaterial({
      map: this.texVeins,
      transparent: true,
      opacity: 0.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    this.veinLayer = new THREE.Mesh(sharedGeom, this.veinMat);
    this.veinLayer.visible = false;
    this.veinLayer.renderOrder = 2;
    this.leafRoot.add(this.veinLayer);

    // LAYER 3: Real-Silhouette Palisade Mesophyll Cellular Layer (#7ABF5A / #9BF272)
    this.mesoMat = new THREE.MeshBasicMaterial({
      map: this.texMesophyll,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    this.mesophyllLayer = new THREE.Mesh(sharedGeom, this.mesoMat);
    this.mesophyllLayer.visible = false;
    this.mesophyllLayer.renderOrder = 1;
    this.leafRoot.add(this.mesophyllLayer);

    // LAYER 4: Spectral Grad-CAM Attention Field (clipped strictly to user's leaf)
    this.gradcamMat = new THREE.MeshBasicMaterial({
      map: this.texGradCam,
      transparent: true,
      opacity: 0.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    this.gradcamLayer = new THREE.Mesh(sharedGeom, this.gradcamMat);
    this.gradcamLayer.visible = false;
    this.gradcamLayer.renderOrder = 4;
    this.leafRoot.add(this.gradcamLayer);

    // Pointer & Drag Orbit
    window.addEventListener('mousemove', (e) => {
      if (this.isDragging) {
        this.dragRot.y += (e.clientX - this.prevDrag.x) * 0.0065;
        this.dragRot.x = clamp(this.dragRot.x + (e.clientY - this.prevDrag.y) * 0.005, -0.65, 0.65);
        this.prevDrag = { x: e.clientX, y: e.clientY };
      }
      this.mouse.tx = (e.clientX / window.innerWidth - 0.5) * 2;
      this.mouse.ty = -(e.clientY / window.innerHeight - 0.5) * 2;
    });
    window.addEventListener('mouseup', () => { this.isDragging = false; });

    const dragZone = document.getElementById('cinema-drag-zone');
    if (dragZone) {
      dragZone.addEventListener('mousedown', (e) => {
        if (e.target.closest('button, a')) return;
        this.isDragging = true;
        this.prevDrag = { x: e.clientX, y: e.clientY };
      });
    }

    window.addEventListener('resize', () => this.onResize());

    this.clock = new THREE.Clock();
    this.animate();
  }

  onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  setDissectionProgress(p) {
    if (this.manualPreset !== null) return;
    this.dissectionTarget = clamp(p, 0, 1);
  }

  setPageExitProgress(p) {
    this.pageExitTarget = clamp(p, 0, 1);
  }

  setLayerPreset(preset) {
    const map = {
      scroll: null,
      assembled: 0.0,
      cuticle: 0.28,
      veins: 0.56,
      mesophyll: 0.80,
      gradcam: 1.0
    };
    if (preset in map) {
      this.manualPreset = map[preset];
      if (this.manualPreset !== null) this.dissectionTarget = this.manualPreset;
    }
  }

  setPathologyPreview(mode) {
    this.tissueMode = mode;
    if (mode === 'chlorophyll' || mode === 'healthy') {
      this.cuticleMat.map = this.texChlorophyll;
      this.cuticleMat.color.setHex(0xffffff);
      this.rimLight.color.setHex(0x9bf272);
    } else if (mode === 'angular_leaf_spot') {
      this.cuticleMat.map = this.texOriginal;
      this.cuticleMat.color.setHex(0xf2d4a7);
      this.rimLight.color.setHex(0xe5a03c);
    } else if (mode === 'bean_rust') {
      this.cuticleMat.map = this.texOriginal;
      this.cuticleMat.color.setHex(0xf5b89a);
      this.rimLight.color.setHex(0xe85d4a);
    } else {
      // 'original' — User's exact natural backlit photograph
      this.cuticleMat.map = this.texOriginal;
      this.cuticleMat.color.setHex(0xffffff);
      this.rimLight.color.setHex(0x9bf272);
    }
    this.cuticleMat.needsUpdate = true;
  }

  setScanning(active) {
    this.scanState = active ? 'scanning' : 'idle';
  }

  setResult(isHealthy, predictedClass = null) {
    this.scanState = isHealthy ? 'healthy' : 'diseased';
    if (isHealthy) {
      this.setPathologyPreview('chlorophyll');
    } else if (predictedClass) {
      this.setPathologyPreview(predictedClass);
    }
  }

  reset() {
    this.scanState = 'idle';
    this.setPathologyPreview('original');
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    const t = this.clock.getElapsedTime();

    this.mouse.x += (this.mouse.tx - this.mouse.x) * 0.045;
    this.mouse.y += (this.mouse.ty - this.mouse.y) * 0.045;
    this.dissectionCurrent += (this.dissectionTarget - this.dissectionCurrent) * 0.08;
    this.pageExitCurrent += (this.pageExitTarget - this.pageExitCurrent) * 0.07;

    const p = this.dissectionCurrent;
    const exit = this.pageExitCurrent;
    const isDesktop = window.innerWidth >= 1024;

    // --------------------------------------------------------
    // REAL-LEAF 4-LAYER SCROLL OPENING CHOREOGRAPHY
    // --------------------------------------------------------
    const sCuticle = smoothstep(0.05, 0.34, p);
    const sVeins = smoothstep(0.26, 0.58, p);
    const sMeso = smoothstep(0.50, 0.82, p);
    const sCam = smoothstep(0.74, 1.00, p);

    // Layer 1: Real Photographed Leaf glides forward (+Z) and opens cleanly
    this.cuticleLayer.position.z = sCuticle * 1.42;
    this.cuticleLayer.position.y = sCuticle * 0.12;
    this.cuticleLayer.rotation.y = -sCuticle * 0.13;
    this.cuticleMat.opacity = (1.0 - sCuticle * 0.16) * (1 - exit * 0.78);

    // Layer 2: Real Extracted Vascular Veins (#9BF272) detach cleanly in mid-plane
    this.veinLayer.visible = sVeins > 0.02 && exit < 0.85;
    this.veinLayer.position.z = 0.05 + sVeins * 0.14;
    this.veinMat.opacity = sVeins * (0.90 + Math.sin(t * 2.4) * 0.10) * (1 - exit);

    // Layer 3: Real-Silhouette Mesophyll Cellular Parenchyma unfolds rearward (-Z)
    this.mesophyllLayer.visible = sMeso > 0.02 && exit < 0.85;
    this.mesophyllLayer.position.z = -0.08 - sMeso * 1.52;
    this.mesophyllLayer.position.y = -sMeso * 0.12;
    this.mesophyllLayer.rotation.y = sMeso * 0.13;
    this.mesoMat.opacity = sMeso * 0.92 * (1 - exit);

    // Layer 4: Spectral Grad-CAM Attention Field floats cleanly in front of Cuticle
    this.gradcamLayer.visible = (sCam > 0.02 || this.scanState === 'scanning') && exit < 0.8;
    this.gradcamLayer.position.z = this.cuticleLayer.position.z + 0.42 + sCam * 0.46;
    this.gradcamMat.opacity = (this.scanState === 'scanning'
      ? 0.55 + Math.sin(t * 6.0) * 0.2
      : sCam * (0.86 + Math.sin(t * 2.8) * 0.1)) * (1 - exit);

    // Full-Bleed Cinema Staging:
    const baseX = isDesktop ? (2.15 - smoothstep(0, 0.42, p) * 0.55 + exit * 1.2) : 0;
    const baseY = isDesktop ? (-0.06 + Math.sin(t * 0.95) * 0.09 + smoothstep(0.1, 0.75, p) * 0.12 - exit * 0.5) : (0.95 - exit * 1.3);
    const baseZ = -exit * 4.8;
    this.leafRoot.position.set(baseX, baseY, baseZ);

    const openOrbitY = smoothstep(0.04, 0.48, p) * 0.78 - smoothstep(0.76, 1.0, p) * 0.18;
    const openTiltX = smoothstep(0.04, 0.52, p) * 0.19;

    if (this.scanState === 'scanning') {
      this.leafRoot.rotation.y += 0.032;
      this.leafRoot.rotation.x = 0.08 + Math.sin(t * 5.0) * 0.06;
    } else {
      const targetRotY = -0.14 + openOrbitY + Math.sin(t * 0.42) * 0.08 + this.mouse.x * 0.24 + this.dragRot.y;
      const targetRotX = 0.04 + openTiltX + Math.cos(t * 0.36) * 0.04 - this.mouse.y * 0.16 + this.dragRot.x;
      this.leafRoot.rotation.y += (targetRotY - this.leafRoot.rotation.y) * 0.07;
      this.leafRoot.rotation.x += (targetRotX - this.leafRoot.rotation.x) * 0.07;
    }

    const scaleBase = isDesktop ? 1.08 : 0.68;
    const targetScale = scaleBase * (1.0 + smoothstep(0.08, 0.65, p) * 0.08 - smoothstep(0.75, 1.0, p) * 0.06);
    this.leafRoot.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), 0.08);

    // Enhanced Cinematic Scroll-In Camera Dolly & Sweeping Arc
    // Smoothly dollies from establishing Z=12.0 into dramatic macro close-up Z=8.1 as layers open,
    // then pulls back gracefully when scrolling into the Scanner workspace
    const dollyIn = smoothstep(0.04, 0.72, p) * (1 - exit);
    const targetCamZ = 12.0 - dollyIn * 3.85 + exit * 2.0;
    const targetCamX = this.mouse.x * 0.52 + (isDesktop ? dollyIn * 0.65 : 0);
    const targetCamY = this.mouse.y * 0.34 + dollyIn * 0.22;

    this.camera.position.x += (targetCamX - this.camera.position.x) * 0.055;
    this.camera.position.y += (targetCamY - this.camera.position.y) * 0.055;
    this.camera.position.z += (targetCamZ - this.camera.position.z) * 0.055;
    // Look smoothly toward the center of the opening leaf during macro push-in
    const lookX = isDesktop ? dollyIn * 0.55 : 0;
    this.camera.lookAt(lookX, 0, 0);

    // Gentle floating mist motes
    const mpos = this.motes.geometry.attributes.position;
    for (let i = 0; i < mpos.count; i++) {
      let y = mpos.getY(i) + 0.005;
      if (y > 12) y = -12;
      mpos.setY(i, y);
    }
    mpos.needsUpdate = true;
    this.motes.rotation.y = t * 0.005;

    this.composer.render();
  }
}

let cinemaEngine = null;

export function init3DScenes() {
  const canvas = document.getElementById('cinema-canvas');
  if (canvas) {
    cinemaEngine = new VerdantRealLeafCinema(canvas);
  }

  window.leafScan3D = {
    setDissectionProgress: (p) => cinemaEngine?.setDissectionProgress(p),
    setPageExitProgress: (p) => cinemaEngine?.setPageExitProgress(p),
    setLayerPreset: (mode) => cinemaEngine?.setLayerPreset(mode),
    setPathologyPreview: (cls) => cinemaEngine?.setPathologyPreview(cls),
    setScanning: (active) => cinemaEngine?.setScanning(active),
    setResult: (isHealthy, cls) => cinemaEngine?.setResult(isHealthy, cls),
    reset: () => cinemaEngine?.reset()
  };
}
