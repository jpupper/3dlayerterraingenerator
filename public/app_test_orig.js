import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

// ═══════════════════════════════════════════════════════
// TERRAIN LIBRARY
// ═══════════════════════════════════════════════════════
const TERRAIN_LIB = {
  'san-juan': { name:'San Juan', tags:'Relieve completo · fondo negro puro', thumb:'maqueta/heightmap_final.png', depthUrl:'maqueta/heightmap_final.png', layers:20, maxHeight:1.6, smoothing:3 },
  'san-juan-detailed': { name:'San Juan HD', tags:'Relieve detallado', thumb:'maqueta/heightmap_final.png', depthUrl:'maqueta/heightmap_final.png', layers:25, maxHeight:2.0, smoothing:2 },
  'san-juan-topo': { name:'San Juan Topo', tags:'Desde topográfico · fondo negro', thumb:'maqueta/heightmap_topo.png', depthUrl:'maqueta/heightmap_topo.png', layers:18, maxHeight:1.8, smoothing:2 },
  'san-juan-suave': { name:'San Juan Suave', tags:'Relieve suavizado', thumb:'maqueta/heightmap_final.png', depthUrl:'maqueta/heightmap_final.png', layers:15, maxHeight:1.2, smoothing:4 },
  'san-juan-color': { name:'San Juan Color', tags:'Mapa de colores · relieve real 0-6.8m', thumb:'maqueta/heightmapfinalfinal.png', depthUrl:'maqueta/heightmapfinalfinal.png', layers:30, maxHeight:2.8, smoothing:1, isColorMap:true },
  'san-juan-corregido': { name:'San Juan Corregido', tags:'Cuadrado · mapa de colores', thumb:'maqueta/heightmap_cuadrado.png', depthUrl:'maqueta/heightmap_cuadrado.png', layers:30, maxHeight:2.8, smoothing:1, isColorMap:true },
  'default-hill': { name:'Colina Default', tags:'Terreno genérico', thumb:null, depthUrl:null, layers:15, maxHeight:1.2, smoothing:2, isDefault:true },
};

// ═══════════════════════════════════════════════════════
// GLOBALS
// ═══════════════════════════════════════════════════════
const HEIGHT_SCALE = 4; // slider 3 → altura real 12cm
let RES = 128;
let heightData = new Float32Array(RES * RES);
let baseHeightData = new Float32Array(RES * RES);
let needsRegen = true;
let rebuildPending = false;
let smoothRefHeight = -1; // -1 = not set, captured on mousedown for smooth flatten tool


// Last known mouse position for frame-driven paint raycasting
let lastMouseX = 0, lastMouseY = 0;

const state = {
  layers:15, maxHeight:1.2, smoothing:2,
  brillo:0, contraste:1, resolution:128,
  sizeX:130, sizeZ:130,
  modelScaleX:1, modelScaleZ:1,
  tool:'add', brushSize:20, brushFlow:30, brushStrength:0.5,
  viewMode:'solid', activeTerrain:'default-hill', paint3d:false,
  baseColor:'#c4a265', paintColor:'#e55336', paintAlpha:0.5,
  showBase:true,
  activeLayer:1,
};

// Layer configuration: each entry = { name, color, visible }
// Indexed by layer number (1..N). Built dynamically in initLayerConfig().
let layerConfig = {};

// New multi-layer heightmap system
// layerHeights[l] = Float32Array(RES*RES) for layer index l (0 = bottom layer)
// totalHeightData = computed sum of all layerHeights for rendering
let layerHeights = null; // Array of Float32Array, one per layer
let activeLayer = 1;     // 1-indexed, matches layerConfig keys (default: layer 1)
// Temporary buffer for computed total height
let totalHeightData = null;

// Material-based painting system
// Each vertex can be painted with a material (Tierra=0, Agua=1, etc.)
const MATERIALS = [
  { id: 0, name: 'Tierra', color: '#c4a265' },
  { id: 1, name: 'Agua',   color: '#4a9eff' }
];
let materialMap = null; // Uint8Array(RES*RES), 0=Tierra(default), 1=Agua
let activeMaterialId = -1; // -1=none selected, 0=Tierra, 1=Agua

let vertexColors = null;
let colorData = null;

let threeReady = false;
let terrainMesh = null; // Single mesh for non-layers modes
let terrainGroup = null; // THREE.Group holding terrain (single mesh or per-layer)
let layerMeshes = []; // Array of per-layer meshes for layers mode
let rulerGroup = null;
let brushRing = null;
let scene, camera, renderer, controls;

// ═══════════════════════════════════════════════════════
// DOM
// ═══════════════════════════════════════════════════════
const $ = s => document.querySelector(s);
const viewport = $('#viewport');
const loadingOverlay = $('#loadingOverlay');
const toastEl = $('#toast');
let toastTimer;
function toast(m) { toastEl.textContent = m; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2500); }

// Loading overlay with dynamic text
function setLoading(text) {
  const el = document.getElementById('loadingText');
  if (el) el.textContent = text;
  loadingOverlay.classList.add('show');
}
function hideLoading() {
  loadingOverlay.classList.remove('show');
}

const heightCanvas = $('#heightPreviewCanvas');
const paintOverlay = $('#paintOverlay');
const hCtx = heightCanvas.getContext('2d');
const pCtx = paintOverlay.getContext('2d');
const SZ = 512;
heightCanvas.width = SZ; heightCanvas.height = SZ;
paintOverlay.width = SZ; paintOverlay.height = SZ;

// ═══════════════════════════════════════════════════════
// SCHEDULED REBUILD
// ═══════════════════════════════════════════════════════
function scheduleRebuild() {
  if (!rebuildPending && threeReady) {
    rebuildPending = true;
    setLoading('Generando terreno...');
    requestAnimationFrame(() => { rebuildPending = false; rebuildTerrain(); });
  }
}

// ═══════════════════════════════════════════════════════
// COLLAPSIBLE SECTIONS
// ═══════════════════════════════════════════════════════
document.querySelectorAll('.section-title.collapsible').forEach(header => {
  header.addEventListener('click', () => {
    const targetId = header.dataset.target;
    const body = document.getElementById(targetId);
    if (!body) return;
    const isCollapsed = body.classList.toggle('collapsed');
    header.classList.toggle('collapsed', isCollapsed);
  });
});

// ═══════════════════════════════════════════════════════
// RIGHT PANEL TERRAIN LIBRARY & PRESETS
// ═══════════════════════════════════════════════════════
const rightTerrainGrid = $('#rightTerrainGrid');
const rightPresetGrid = $('#rightPresetGrid');
const rightPresetName = $('#rightPresetName');
const rightSavePresetBtn = $('#rightSavePresetBtn');
const rightUpdatePresetBtn = $('#rightUpdatePresetBtn');

// buildTerrainLibrary: populate BOTH left-panel (#terrainGrid) and right-panel (#rightTerrainGrid)
// Note: on fullscreencode.com only rightTerrainGrid exists; on local both exist.
function _populateTerrainGrid(container) {
  if (!container) return;
  container.innerHTML = '';
  for (const [id, t] of Object.entries(TERRAIN_LIB)) {
    const card = document.createElement('div');
    card.className = 'terrain-card' + (id === state.activeTerrain ? ' active' : '');
    card.dataset.id = id;
    const thumb = document.createElement('img'); thumb.className = 'thumb';
    if (t.thumb) thumb.src = t.thumb;
    else thumb.style.background = 'linear-gradient(180deg,#444 0%,#222 40%,#000 100%)';
    const nameEl = document.createElement('div'); nameEl.className = 'name'; nameEl.textContent = t.name;
    const tagsEl = document.createElement('div'); tagsEl.className = 'tags'; tagsEl.textContent = t.tags;
    card.appendChild(thumb); card.appendChild(nameEl); card.appendChild(tagsEl);
    if (id === state.activeTerrain) { const b = document.createElement('div'); b.className = 'badge'; b.textContent = 'ACTIVO'; card.appendChild(b); }
    card.addEventListener('click', () => loadTerrain(id));
    container.appendChild(card);
  }
}
function buildTerrainLibrary() {
  _populateTerrainGrid(document.getElementById('terrainGrid'));
  _populateTerrainGrid(rightTerrainGrid);
}

// Note: loadPresets (defined below at ~line 2165) populates #rightPresetGrid
// via $presetGrid which points to the same element. No override needed.

const terrainGrid = document.getElementById('terrainGrid');

function loadTerrain(id) {
  const t = TERRAIN_LIB[id];
  if (!t) return;
  state.activeTerrain = id;
  state.layers = t.layers; state.maxHeight = t.maxHeight;
  state.smoothing = t.smoothing;
  state.brillo = 0; state.contraste = 1;

  // Update URL for sharing
  const url = new URL(window.location);
  url.searchParams.set('terrain', id);
  url.searchParams.delete('preset');
  history.replaceState(null, '', url);
  // Update model name hint
  const nameHint = document.getElementById('modelNameHint');
  if (nameHint) nameHint.textContent = t.name;
  window._activePresetId = null;
  window._activePresetName = t.name;
  updateActivePresetBtnState();

  $('#layers').value = t.layers; $('#layersVal').textContent = t.layers;
  $('#maxHeight').value = t.maxHeight; $('#heightVal').textContent = (t.maxHeight * HEIGHT_SCALE).toFixed(1);
  $('#smoothing').value = t.smoothing; $('#smoothVal').textContent = t.smoothing;
  $('#brillo').value = 0; $('#brilloVal').textContent = '0.00';
  $('#contraste').value = 1; $('#contrasteVal').textContent = '1.00';
  // Sync number inputs
  document.querySelectorAll('.num-input').forEach(inp => {
    const range = inp.previousElementSibling;
    if (range && range.type === 'range') {
      const span = range.closest('.control-group')?.querySelector('.value');
      inp.value = span ? span.textContent : range.value;
    }
  });

  buildTerrainLibrary();

  if (t.isDefault) { genDefaultTerrain(); return; }

  setLoading('Cargando ' + t.name + '...');
  if (t.depthUrl) {
    const img = new Image();
    img.onload = () => {
      if (t.isColorMap) {
        loadColorHeightmap(img, heightData);
      } else {
        loadImageToData(img, heightData);
      }
      hideLoading();
      needsRegen = true;
      initLayerHeights(state.layers);
      drawCanvas();
      if (threeReady) rebuildTerrain();
      toast('Terreno "' + t.name + '" cargado');
    };
    img.onerror = () => { hideLoading(); toast('Error cargando ' + t.name); };
    img.src = t.depthUrl;
  }
}

// ═══════════════════════════════════════════════════════
// IMAGE PROCESSING
// ═══════════════════════════════════════════════════════
function loadImageToData(img, arr) {
  const c = document.createElement('canvas');
  c.width = RES; c.height = RES;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, RES, RES);
  const pix = ctx.getImageData(0, 0, RES, RES).data;
  for (let i = 0; i < RES * RES; i++)
    arr[i] = Math.max(0, Math.min(1, (pix[i*4]*0.299 + pix[i*4+1]*0.587 + pix[i*4+2]*0.116) / 255));
}

// Color palette for San Juan heightmap (color-coded elevation map)
// Each entry maps an RGB color to a height in meters
const SAN_JUAN_COLORS = [
  { r:255,g:242,b:243, h:6.793 }, { r:255,g:214,b:217, h:6.216 },
  { r:255,g:168,b:176, h:5.659 }, { r:255,g:128,b:137, h:5.122 },
  { r:255,g:92,b:102,  h:4.607 }, { r:255,g:59,b:71,   h:4.113 },
  { r:230,g:34,b:46,   h:3.642 }, { r:214,g:28,b:35,   h:3.193 },
  { r:230,g:74,b:46,   h:2.768 }, { r:242,g:116,b:36,  h:2.367 },
  { r:250,g:159,b:42,  h:1.990 }, { r:247,g:199,b:49,  h:1.640 },
  { r:255,g:242,b:61,  h:1.317 }, { r:215,g:242,b:61,  h:1.022 },
  { r:161,g:230,b:53,  h:0.758 }, { r:102,g:217,b:43,  h:0.525 },
  { r:44,g:209,b:53,   h:0.327 }, { r:31,g:196,b:103,  h:0.168 },
  { r:43,g:230,b:176,  h:0.054 }, { r:54,g:212,b:255,  h:0 },
];
const SAN_JUAN_MAX_H = 6.793;

// Load a color-coded heightmap by matching pixels to the nearest palette color
// Process at full image resolution first, then bilinearly downsample to RES
// to avoid blended-color artifacts from canvas downscaling
function loadColorHeightmap(img, arr) {
  const iw = img.naturalWidth || img.width || 2026;
  const ih = img.naturalHeight || img.height || 1119;
  // Convert at full resolution
  const c = document.createElement('canvas');
  c.width = iw; c.height = ih;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const pix = ctx.getImageData(0, 0, iw, ih).data;
  const full = new Float32Array(iw * ih);
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const i = (y * iw + x) * 4;
      const r = pix[i], g = pix[i+1], b = pix[i+2], a = pix[i+3];
      // Transparent (alpha < 128) or very dark → background, height = 0
      if (a < 128 || (r < 10 && g < 10 && b < 10)) { full[y*iw+x] = 0; continue; }
      let bestDist = Infinity, bestH = 0;
      for (const c2 of SAN_JUAN_COLORS) {
        const dr = r - c2.r, dg = g - c2.g, db = b - c2.b;
        const dist = dr*dr + dg*dg + db*db;
        if (dist < bestDist) { bestDist = dist; bestH = c2.h; }
      }
      full[y*iw+x] = Math.max(0, Math.min(1, bestH / SAN_JUAN_MAX_H));
    }
  }
  // Bilinear downsample to RES
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      const gx = (x / (RES - 1)) * (iw - 1);
      const gy = (y / (RES - 1)) * (ih - 1);
      const ix = Math.min(Math.floor(gx), iw - 2);
      const iy = Math.min(Math.floor(gy), ih - 2);
      const fx = gx - ix, fy = gy - iy;
      const a = full[iy*iw+ix];
      const b = full[iy*iw+ix+1];
      const c = full[(iy+1)*iw+ix];
      const d = full[(iy+1)*iw+ix+1];
      arr[y*RES+x] = a*(1-fx)*(1-fy) + b*fx*(1-fy) + c*(1-fx)*fy + d*fx*fy;
    }
  }
}

function applyBrilloContraste() {
  const b = state.brillo, c = state.contraste;
  for (let i = 0; i < RES * RES; i++) {
    const v = baseHeightData[i];
    if (v > 0.001) baseHeightData[i] = Math.max(0, Math.min(1, (v - 0.5) * c + 0.5 + b));
  }
}

function genDefaultTerrain() {
  heightData.fill(0);
  const cx = RES/2, cy = RES/2;
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
    const d = Math.sqrt(((x-cx)/cx)**2 + ((y-cy)/cy)**2);
    if (d < 1) heightData[y*RES+x] = Math.max(0, 1-d) * 0.6 + Math.random() * 0.08;
  }
  for (const [bx,bz] of [[0.3,0.4],[-0.2,0.3],[0.1,-0.4]]) for (let y=0;y<RES;y++) for (let x=0;x<RES;x++) {
    const d = Math.sqrt(((x/RES-0.5-bx)*3)**2 + ((y/RES-0.5-bz)*3)**2);
    if (d < 0.8) heightData[y*RES+x] = Math.min(1, heightData[y*RES+x] + (1-d/0.8)*0.35);
  }
  baseHeightData.set(heightData);
  initLayerHeights(state.layers);
  needsRegen = true; drawCanvas();
  if (threeReady) rebuildTerrain();
  toast('Default terrain loaded');
}

function reallocateData(newRes) {
  if (newRes === RES) return;
  const oldRes = RES;
  const oldData = new Float32Array(heightData);
  // Save old layerHeights if they exist
  const oldLayerHeights = layerHeights ? layerHeights.map(lh => new Float32Array(lh)) : null;
  RES = newRes;
  state.resolution = RES;
  $('#resolution').value = RES;
  $('#resolutionVal').textContent = RES;
  heightData = new Float32Array(RES * RES);
  baseHeightData = new Float32Array(RES * RES);
  
  // Resample old total heightmap
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
    const ox = (x / (RES-1)) * (oldRes-1);
    const oy = (y / (RES-1)) * (oldRes-1);
    const ix = Math.min(Math.floor(ox), oldRes-2);
    const iy = Math.min(Math.floor(oy), oldRes-2);
    const fx = ox - ix, fy = oy - iy;
    const a = oldData[iy*oldRes+ix], b = oldData[iy*oldRes+(ix+1)];
    const c = oldData[(iy+1)*oldRes+ix], d = oldData[(iy+1)*oldRes+(ix+1)];
    heightData[y*RES+x] = a*(1-fx)*(1-fy) + b*fx*(1-fy) + c*(1-fx)*fy + d*fx*fy;
  }
  baseHeightData.set(heightData);
  
  // Resample each layer's heightmap
  if (oldLayerHeights) {
    layerHeights = [];
    for (let l = 0; l < oldLayerHeights.length; l++) {
      const oldLh = oldLayerHeights[l];
      const newLh = new Float32Array(RES * RES);
      for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
        const ox = (x / (RES-1)) * (oldRes-1);
        const oy = (y / (RES-1)) * (oldRes-1);
        const ix = Math.min(Math.floor(ox), oldRes-2);
        const iy = Math.min(Math.floor(oy), oldRes-2);
        const fx = ox - ix, fy = oy - iy;
        const a = oldLh[iy*oldRes+ix], b = oldLh[iy*oldRes+(ix+1)];
        const c = oldLh[(iy+1)*oldRes+ix], d = oldLh[(iy+1)*oldRes+(ix+1)];
        newLh[y*RES+x] = a*(1-fx)*(1-fy) + b*fx*(1-fy) + c*(1-fx)*fy + d*fx*fy;
      }
      layerHeights[l] = newLh;
    }
    computeTotalHeight();
  }
}

// ═══════════════════════════════════════════════════════
// CANVAS
// ═══════════════════════════════════════════════════════
function drawCanvas() {
  const w = SZ, h = SZ;
  const img = hCtx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.round(baseHeightData[Math.floor(y/h*RES)*RES + Math.floor(x/w*RES)] * 255);
    const i = (y*w+x)*4; d[i]=v; d[i+1]=v; d[i+2]=v; d[i+3]=255;
  }
  hCtx.putImageData(img, 0, 0);
  $('#heightPreview').style.display = 'block';
}

// ═══════════════════════════════════════════════════════
// SMOOTHING
// ═══════════════════════════════════════════════════════
function smoothHeightmap(passes) {
  if (passes <= 0) return;
  const tmp = new Float32Array(RES*RES);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
      const idx = y*RES+x;
      // Skip background (zero-height) pixels entirely
      if (heightData[idx] <= 0.001) { tmp[idx] = 0; continue; }
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x+dx, ny = y+dy;
        if (nx>=0 && nx<RES && ny>=0 && ny<RES) {
          const v = heightData[ny*RES+nx];
          // Only average over non-zero neighbors (preserves terrain edge)
          if (v > 0.001) { s += v; n++; }
        }
      }
      tmp[idx] = n > 0 ? s / n : heightData[idx];
    }
    heightData.set(tmp);
  }
}

// ═══════════════════════════════════════════════════════
// PAINTING
// ═══════════════════════════════════════════════════════
let isPainting = false;
function getCoords(e) {
  const r = paintOverlay.getBoundingClientRect();
  return { x: Math.max(0,Math.min(SZ-1,(e.clientX-r.left)/r.width*SZ)), y: Math.max(0,Math.min(SZ-1,(e.clientY-r.top)/r.height*SZ)) };
}

function paintAt(cx, cy) {
  const hx = Math.floor(cx/SZ*RES), hy = Math.floor(cy/SZ*RES);
  const size = state.brushSize, flow = state.brushFlow/100, radius = size/2;
  const ceilRad = Math.ceil(radius);
  for (let dy = -ceilRad; dy <= ceilRad; dy++) for (let dx = -ceilRad; dx <= ceilRad; dx++) {
    const px = hx+dx, py = hy+dy;
    if (px<0 || px>=RES || py<0 || py>=RES) continue;
    const dist = Math.sqrt(dx*dx+dy*dy);
    if (dist > radius) continue;
    const f = 1 - dist/radius;
    // In layers mode, modify the active layer's heightmap only
    if (state.viewMode === 'layers' && layerHeights && layerHeights.length > 0) {
      const li = Math.max(0, Math.min(layerHeights.length - 1, activeLayer - 1));
      const cur = layerHeights[li][py*RES+px];
      // Safety guard: floodfill is handled separately, never via brush
      if (state.tool === 'floodfill') continue;
      if (state.tool === 'add') {
        const newH = Math.min(1, cur + f*flow*(0.05 + Math.abs(state.brushStrength)*0.20));
        layerHeights[li][py*RES+px] = newH;
      }
      else if (state.tool === 'sub') {
        const newH = Math.max(0, cur - f*flow*(0.05 + Math.abs(state.brushStrength)*0.20));
        layerHeights[li][py*RES+px] = newH;
      }
      else if (state.tool === 'smooth') {
        // Flatten toward reference height (captured on mousedown)
        if (smoothRefHeight >= 0 && cur !== smoothRefHeight) {
          const amount = f * flow * (0.05 + Math.abs(state.brushStrength) * 0.20);
          if (cur < smoothRefHeight) {
            layerHeights[li][py*RES+px] = Math.min(smoothRefHeight, cur + amount);
          } else {
            layerHeights[li][py*RES+px] = Math.max(smoothRefHeight, cur - amount);
          }
        }
      }
    } else {
    const cur = heightData[py*RES+px];
    // Safety guard: floodfill is handled separately, never via brush
    if (state.tool === 'floodfill') continue;
    if (state.tool === 'add') {
      const newH = Math.min(1, cur + f*flow*(0.05 + Math.abs(state.brushStrength)*0.20));
      heightData[py*RES+px] = clampToVisibleLayers(py*RES+px, newH, cur);
    }
    else if (state.tool === 'sub') {
      const newH = Math.max(0, cur - f*flow*(0.05 + Math.abs(state.brushStrength)*0.20));
      heightData[py*RES+px] = clampToVisibleLayers(py*RES+px, newH, cur);
    }
    else if (state.tool === 'smooth') {
      // Flatten toward reference height (captured on mousedown)
      if (smoothRefHeight >= 0 && cur !== smoothRefHeight) {
        const amount = f * flow * (0.05 + Math.abs(state.brushStrength) * 0.20);
        if (cur < smoothRefHeight) {
          const newH = Math.min(smoothRefHeight, cur + amount);
          heightData[py*RES+px] = clampToVisibleLayers(py*RES+px, newH, cur);
        } else {
          const newH = Math.max(smoothRefHeight, cur - amount);
          heightData[py*RES+px] = clampToVisibleLayers(py*RES+px, newH, cur);
        }
      }
    }
    }
  }
  needsRegen = true;
  // Sync total height after painting
  if (state.viewMode === 'layers' && layerHeights) {
    computeTotalHeight();
    heightData.set(totalHeightData);
  }
}

paintOverlay.addEventListener('mousedown', e => {
  isPainting = true;
  const p=getCoords(e);
  // Capture reference height for smooth flatten tool
  if (state.tool === 'smooth') {
    const hx = Math.floor(p.x/SZ*RES), hy = Math.floor(p.y/SZ*RES);
    smoothRefHeight = heightData[Math.min(hy,RES-1)*RES+Math.min(hx,RES-1)];
  }
  paintAt(p.x,p.y); drawCanvas(); pCtx.clearRect(0,0,SZ,SZ);
});
window.addEventListener('mousemove', e => { if (!isPainting) return; const p=getCoords(e); paintAt(p.x,p.y); drawCanvas(); pCtx.clearRect(0,0,SZ,SZ); });
window.addEventListener('mouseup', () => { if (isPainting) { isPainting=false; if (threeReady) rebuildTerrain(); }});
paintOverlay.addEventListener('mouseleave', () => { if (isPainting) { isPainting=false; if (threeReady) rebuildTerrain(); }});

paintOverlay.addEventListener('touchstart', e => {
  e.preventDefault(); isPainting=true;
  const p=getCoords(e.touches[0]);
  if (state.tool === 'smooth') {
    const hx = Math.floor(p.x/SZ*RES), hy = Math.floor(p.y/SZ*RES);
    smoothRefHeight = heightData[Math.min(hy,RES-1)*RES+Math.min(hx,RES-1)];
  }
  paintAt(p.x,p.y); drawCanvas(); pCtx.clearRect(0,0,SZ,SZ);
}, {passive:false});
paintOverlay.addEventListener('touchmove', e => { e.preventDefault(); if (!isPainting) return; const p=getCoords(e.touches[0]); paintAt(p.x,p.y); drawCanvas(); pCtx.clearRect(0,0,SZ,SZ); }, {passive:false});
paintOverlay.addEventListener('touchend', e => { e.preventDefault(); isPainting=false; if (threeReady) rebuildTerrain(); }, {passive:false});

// ═══════════════════════════════════════════════════════
// FILE UPLOAD
// ═══════════════════════════════════════════════════════
const hz = $('#heightUpload');
hz.addEventListener('click', () => hz.querySelector('input').click());
hz.addEventListener('dragover', e => { e.preventDefault(); hz.classList.add('dragover'); });
hz.addEventListener('dragleave', () => hz.classList.remove('dragover'));
hz.addEventListener('drop', e => { e.preventDefault(); hz.classList.remove('dragover'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
hz.querySelector('input').addEventListener('change', () => { if (hz.querySelector('input').files[0]) loadFile(hz.querySelector('input').files[0]); });

function loadFile(file) {
  const validTypes = ['image/png','image/jpeg','image/gif','image/webp','image/bmp'];
  if (!validTypes.includes(file.type)) {
    toast('Formato no soportado. Usá PNG, JPEG, GIF, WebP o BMP.');
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    toast('La imagen es demasiado grande (>50MB).');
    return;
  }
  setLoading('Cargando imagen...');
  const reader = new FileReader();
  reader.onerror = () => { hideLoading(); toast('Error al leer el archivo'); };
  reader.onload = e => {
    const img = new Image();
    img.onerror = () => { hideLoading(); toast('Error al decodificar la imagen'); };
    img.onload = () => {
      loadImageToData(img, heightData);
      baseHeightData.set(heightData);
      initLayerHeights(state.layers);
      state.activeTerrain = 'custom';
      buildTerrainLibrary();
      drawCanvas();
      needsRegen = true;
      hz.classList.add('has-image');
      hz.querySelector('.icon').textContent = '✅';
      hz.querySelector('.label').textContent = file.name;
      if (threeReady) { requestAnimationFrame(() => { rebuildTerrain(); hideLoading(); }); } else { hideLoading(); }
      toast(`Heightmap "${file.name}" cargado`);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// ═══════════════════════════════════════════════════════
// THREE.JS
// ═══════════════════════════════════════════════════════
function initThree() {
  setLoading('Inicializando 3D...');
  scene = new THREE.Scene(); scene.background = new THREE.Color(0x0a0a12);
  camera = new THREE.PerspectiveCamera(40, viewport.clientWidth/viewport.clientHeight, 0.1, Math.max(state.sizeX, state.sizeZ) * 5);
  const camDist = Math.max(state.sizeX, state.sizeZ) * 1.8;
  camera.position.set(camDist * 0.7, camDist * 0.6, camDist);
  renderer = new THREE.WebGLRenderer({antialias:true});
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  viewport.appendChild(renderer.domElement);
  renderer.domElement.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:block;';

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minDistance = 1.5; controls.maxDistance = Math.max(state.sizeX, state.sizeZ) * 4;
  controls.target.set(0, 0, 0); controls.update();

  scene.add(new THREE.AmbientLight(0x404060, 0.6));
  scene.add(new THREE.HemisphereLight(0x87ceeb, 0x362d1e, 0.7));
  const dl = new THREE.DirectionalLight(0xffeedd, 2.5);
  dl.position.set(8,15,5); dl.castShadow = true;
  dl.shadow.mapSize.width = 1024; dl.shadow.mapSize.height = 1024;
  dl.shadow.camera.near = 0.1; dl.shadow.camera.far = 30;
  const shMax = Math.max(state.sizeX, state.sizeZ, state.maxHeight * HEIGHT_SCALE) * 1.5;
  dl.shadow.camera.left = -shMax; dl.shadow.camera.right = shMax;
  dl.shadow.camera.top = shMax; dl.shadow.camera.bottom = -shMax;
  dl.shadow.camera.far = shMax * 3;
  scene.add(dl);
  const fl = new THREE.DirectionalLight(0x8888ff, 0.5); fl.position.set(-5,3,-5); scene.add(fl);

  // Ruler group (measurement grid)
  buildRuler(state.sizeX, state.sizeZ);

  // Brush ring cursor
  const ringGeo = new THREE.RingGeometry(0.18, 0.2, 32);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x4a9eff, side: THREE.DoubleSide, transparent: true, opacity: 0.7 });
  brushRing = new THREE.Mesh(ringGeo, ringMat);
  brushRing.rotation.x = -Math.PI / 2;
  brushRing.position.y = 10;
  brushRing.visible = false;
  scene.add(brushRing);

  threeReady = true;
  animate();
  rebuildTerrain();
  setup3dPaintEvents();

  new ResizeObserver(() => { const w=viewport.clientWidth,h=viewport.clientHeight; if (w>0&&h>0) { camera.aspect=w/h; camera.updateProjectionMatrix(); renderer.setSize(w,h); }}).observe(viewport);
}

function makeTextSprite(text, color='#8caadf', size=0.3) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 80;
  const ctx = canvas.getContext('2d');
  ctx.font = 'Bold 36px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = color; ctx.fillText(text, 128, 42);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, opacity: 0.85, sizeAttenuation: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(size * 4, size * 1.2, 1);
  return sprite;
}

function buildRuler(sizeX, sizeZ) {
  if (rulerGroup) { scene.remove(rulerGroup); rulerGroup.traverse(c => { if (c.geometry) c.geometry.dispose(); }); }
  rulerGroup = new THREE.Group();

  const hx = sizeX / 2, hz = sizeZ / 2;
  const terrainSize = Math.max(sizeX, sizeZ);
  // Scale labels and ticks proportionally to terrain size so they're readable at camera distance
  const labelScale = Math.max(1.5, terrainSize * 0.1);
  const tickLen = Math.max(0.6, terrainSize * 0.075);

  // --- Grid lines ---
  const gridMat = new THREE.LineBasicMaterial({ color: 0x4a6fa5, transparent: true, opacity: 0.12 });
  const gridStep = Math.max(0.5, terrainSize / 10);
  const gridLines = [];
  // Lines along X
  for (let z = -hz; z <= hz + 0.001; z += gridStep) {
    gridLines.push(new THREE.Vector3(-hx, 0, z), new THREE.Vector3(hx, 0, z));
  }
  // Lines along Z
  for (let x = -hx; x <= hx + 0.001; x += gridStep) {
    gridLines.push(new THREE.Vector3(x, 0, -hz), new THREE.Vector3(x, 0, hz));
  }
  const gridGeo = new THREE.BufferGeometry().setFromPoints(gridLines);
  const gridLine = new THREE.LineSegments(gridGeo, gridMat);
  rulerGroup.add(gridLine);

  // --- Perimeter (thicker) ---
  const perimMat = new THREE.LineBasicMaterial({ color: 0x4a6fa5, transparent: true, opacity: 0.5 });
  const pts = [
    new THREE.Vector3(-hx,0,-hz), new THREE.Vector3(hx,0,-hz),
    new THREE.Vector3(hx,0,hz), new THREE.Vector3(-hx,0,hz), new THREE.Vector3(-hx,0,-hz)
  ];
  const perimeter = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), perimMat);
  rulerGroup.add(perimeter);

  // --- Tick marks on perimeter ---
  const tickMat = new THREE.LineBasicMaterial({ color: 0x4a6fa5, transparent: true, opacity: 0.4 });
  for (let t = -hz + gridStep; t < hz; t += gridStep) {
    const sz = (Math.abs(t) < 0.01) ? tickLen * 2 : tickLen;
    for (const pts2 of [[-hx,t,-hx+sz,t],[hx,t,hx-sz,t]]) {
      rulerGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(pts2[0],0,pts2[1]), new THREE.Vector3(pts2[2],0,pts2[3])]), tickMat));
    }
  }
  for (let t = -hx + gridStep; t < hx; t += gridStep) {
    const sz = (Math.abs(t) < 0.01) ? tickLen * 2 : tickLen;
    for (const pts2 of [[t,-hz,t,-hz+sz],[t,hz,t,hz-sz]]) {
      rulerGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(pts2[0],0,pts2[1]), new THREE.Vector3(pts2[2],0,pts2[3])]), tickMat));
    }
  }

  // --- Dimension labels ---
  // Helper: visible 3D bar with full opacity
  function makeBar(p1, p2, color, thickness) {
    const s = new THREE.Vector3(p1[0], p1[1], p1[2]);
    const e = new THREE.Vector3(p2[0], p2[1], p2[2]);
    const dir = new THREE.Vector3().copy(e).sub(s);
    const len = dir.length();
    if (len < 0.001) return null;
    const mid = new THREE.Vector3().copy(s).add(dir.clone().multiplyScalar(0.5));
    const geo = new THREE.BoxGeometry(thickness, thickness, len);
    const mat = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(mid);
    mesh.lookAt(e);
    return mesh;
  }
  function makeCone(pos, dir, color, size) {
    const geo = new THREE.ConeGeometry(size, size * 1.5, 6);
    const mat = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos[0], pos[1], pos[2]);
    const up = new THREE.Vector3(0, 1, 0);
    const dn = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
    mesh.quaternion.setFromUnitVectors(up, dn);
    return mesh;
  }
  const barThick = Math.max(0.04, terrainSize * 0.002);
  const coneSize = barThick * 3;

  // Width label (X axis)
  const lblW = makeTextSprite(sizeX.toFixed(1) + 'cm', '#8caadf', labelScale);
  lblW.position.set(0, 0.05, -hz - 0.6);
  rulerGroup.add(lblW);
  // Label arrow line — visible 3D bar
  const barW = makeBar([-hx, 0.02, -hz - 0.3], [hx, 0.02, -hz - 0.3], 0x6a8fcf, barThick);
  if (barW) rulerGroup.add(barW);
  // Arrowheads at each end
  rulerGroup.add(makeCone([-hx, 0.02, -hz - 0.3], [1,0,0], 0x6a8fcf, coneSize));
  rulerGroup.add(makeCone([hx, 0.02, -hz - 0.3], [-1,0,0], 0x6a8fcf, coneSize));

  // Depth label (Z axis)
  const lblD = makeTextSprite(sizeZ.toFixed(1) + 'cm', '#8caadf', labelScale);
  lblD.position.set(hx + 0.6, 0.05, 0);
  rulerGroup.add(lblD);
  const barD = makeBar([hx + 0.3, 0.02, -hz], [hx + 0.3, 0.02, hz], 0x6a8fcf, barThick);
  if (barD) rulerGroup.add(barD);
  rulerGroup.add(makeCone([hx + 0.3, 0.02, -hz], [0,0,1], 0x6a8fcf, coneSize));
  rulerGroup.add(makeCone([hx + 0.3, 0.02, hz], [0,0,-1], 0x6a8fcf, coneSize));

  // Height label (Y axis) — vertical bar near front-left corner
  const maxH = state.maxHeight;
  const visMaxH = maxH * HEIGHT_SCALE;
  const barH = makeBar([-hx - 0.3, 0, -hz], [-hx - 0.3, visMaxH, -hz], 0xcf8a6f, barThick);
  if (barH) rulerGroup.add(barH);
  // Arrowhead at top, no arrow at bottom (ground level)
  rulerGroup.add(makeCone([-hx - 0.3, visMaxH, -hz], [0,1,0], 0xcf8a6f, coneSize));
  // Top tick — visible bar
  const tickH = makeBar([-hx - 0.45, visMaxH, -hz], [-hx - 0.15, visMaxH, -hz], 0xcf8a6f, barThick);
  if (tickH) rulerGroup.add(tickH);
  const lblH = makeTextSprite(visMaxH.toFixed(1) + 'cm', '#cf8a6f', labelScale);
  lblH.position.set(-hx - 0.7, visMaxH * 0.5, -hz);
  rulerGroup.add(lblH);

  rulerGroup.position.y = 0.01;
  scene.add(rulerGroup);
}

function updateDimOverlay() {
  const w = state.sizeX.toFixed(1), d = state.sizeZ.toFixed(1);
  const actualH = (state.maxHeight * HEIGHT_SCALE).toFixed(1);
  const el = $('#dimOverlay');
  if (el) el.textContent = `📐 ${w}cm × ${d}cm · Altura máx ${actualH}cm · Capas ${state.layers}`;
}

function animate() {
  requestAnimationFrame(animate);
  // Frame-driven paint: every frame while mouse is held down
  if (is3dPainting && terrainMesh && renderer) {
    const rect = renderer.domElement.getBoundingClientRect();
    const px = ((lastMouseX - rect.left) / rect.width) * 2 - 1;
    const py = -((lastMouseY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(new THREE.Vector2(px, py), camera);
    const hits = raycaster.intersectObject(terrainMesh);
    if (hits.length > 0) {
      const pt = hits[0].point;
      const sX = state.sizeX, sZ = state.sizeZ;
      const mSX = state.modelScaleX || 1, mSZ = state.modelScaleZ || 1;
      const gx = Math.round(((pt.x / (sX * mSX)) + 0.5) * (RES-1));
      const gz = Math.round(((pt.z / (sZ * mSZ)) + 0.5) * (RES-1));
      if (gx >= 0 && gx < RES && gz >= 0 && gz < RES) {
        paint3dAt(gx, gz);
        if (state.tool === 'color') {
          updateMeshColors(); // live color feedback
        } else {
          updateMeshVertices(true, false); // smooth display copy, no normals (GPU sync)
        }
        drawCanvas();
      }
    }
  }
  controls.update();
  renderer.render(scene, camera);
}

// ═══════════════════════════════════════════════════════
// TERRAIN GEOMETRY
// ═══════════════════════════════════════════════════════

// Layer config management
function getLayerIndexForHeight(v, numLayers) {
  if (v <= 0.001) return 0; // background
  return Math.min(Math.ceil(v * numLayers), numLayers);
}

// Initialize per-layer heightmaps
function initLayerHeights(numLayers) {
  if (!layerHeights) {
    layerHeights = [];
    const totalH = new Float32Array(RES * RES);
    let totalEmpty = true;
    for (let i = 0; i < RES * RES; i++) {
      if (heightData[i] > 0.001) { totalEmpty = false; break; }
    }
    if (totalEmpty) {
      // Brand new terrain — all zeros, all layers empty
      for (let l = 0; l < numLayers; l++) {
        layerHeights[l] = new Float32Array(RES * RES);
      }
    } else {
      // Legacy preset: distribute heightData into layers by quantized bucket
      // Layer 0 gets the base contribution (up to 1/N), layer 1 gets (1/N to 2/N), etc.
      distributeHeightToLayers(numLayers);
    }
  } else if (layerHeights.length !== numLayers) {
    // Resize: preserve existing layers, add/remove as needed
    const oldLen = layerHeights.length;
    if (numLayers > oldLen) {
      for (let l = oldLen; l < numLayers; l++) {
        layerHeights[l] = new Float32Array(RES * RES);
      }
    } else if (numLayers < oldLen) {
      layerHeights.length = numLayers;
    }
  }
  // Ensure totalHeightData exists
  if (!totalHeightData || totalHeightData.length !== RES * RES) {
    totalHeightData = new Float32Array(RES * RES);
  }
  computeTotalHeight();
}

// Distribute a single heightmap across multiple layers
// For backward compatibility: ALL height goes into layer 0 (bottom layer)
// Higher layers start empty — user can build up with Subir on each layer
function distributeHeightToLayers(numLayers) {
  const N = numLayers;
  layerHeights = [];
  // Layer 0 gets the full heightmap
  layerHeights[0] = new Float32Array(RES * RES);
  let maxH = 0;
  for (let i = 0; i < RES * RES; i++) {
    const v = heightData[i];
    layerHeights[0][i] = v;
    if (v > maxH) maxH = v;
  }
  // Normalize layer 0 so max is 1.0 (our per-layer 0..1 scale)
  if (maxH > 0.001) {
    for (let i = 0; i < RES * RES; i++) {
      layerHeights[0][i] /= maxH;
    }
  }
  // Remaining layers start empty
  for (let l = 1; l < N; l++) {
    layerHeights[l] = new Float32Array(RES * RES);
  }
}

// Compute total height from all layer heights
function computeTotalHeight() {
  if (!layerHeights || layerHeights.length === 0) return;
  totalHeightData.fill(0);
  for (let l = 0; l < layerHeights.length; l++) {
    const lh = layerHeights[l];
    for (let i = 0; i < RES * RES; i++) {
      totalHeightData[i] += lh[i];
    }
  }
}
function initLayerConfig(numLayers) {
  // Also initialize layerHeights if needed
  initLayerHeights(numLayers);
  
  const defaultColors = [
    '#4a9eff', '#6db36d', '#c4a265', '#d4915a', '#b87333',
    '#8b7355', '#a0a060', '#7c9c7c', '#6b8e6b', '#b8860b',
    '#9acd32', '#cd853f', '#deb887', '#8fbc8f', '#66cdaa'
  ];
  const newConfig = {};
  for (let l = 1; l <= numLayers; l++) {
    // Preserve existing config if available
    if (layerConfig && layerConfig[l]) {
      newConfig[l] = { ...layerConfig[l] };
    } else {
      const ci = (l - 1) % defaultColors.length;
      newConfig[l] = {
        name: 'Capa ' + l,
        color: defaultColors[ci],
        visible: true
      };
    }
  }
  layerConfig = newConfig;
  buildLayerConfigUI();
}

function buildLayerConfigUI() {
  const container = document.getElementById('layerConfigList');
  if (!container) return;
  container.innerHTML = '';

  // Add "Apply layer colors" button at top
  const applyBtn = document.createElement('button');
  applyBtn.className = 'btn btn-primary';
  applyBtn.textContent = '🎨 Pintar capas en 3D';
  applyBtn.style.cssText = 'width:100%;margin-bottom:6px;padding:5px 8px;font-size:10px;';
  applyBtn.addEventListener('click', () => {
    applyLayerColorsToColorData();
    if (state.viewMode !== 'solid') setViewMode('solid');
    toast('Colores de capas aplicados permanentemente');
  });
  container.appendChild(applyBtn);

  // View mode hint
  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:9px;color:var(--text2);margin-bottom:6px;padding:2px 4px;text-align:center;';
  if (state.viewMode === 'layers') {
    hint.textContent = 'Vista Capas activa — colores en tiempo real';
    hint.style.color = 'var(--accent)';
  } else {
    hint.textContent = 'Usá el botón "Capas" arriba para colorear en 3D';
  }
  container.appendChild(hint);

  const numLayers = state.layers;
  for (let l = 1; l <= numLayers; l++) {
    const cfg = layerConfig[l] || { name: 'Capa '+l, color: '#888', visible: true };
    const row = document.createElement('div');
    row.className = 'layer-config-row';
    row.dataset.layer = l;

    // Visibility checkbox
    const visCb = document.createElement('input');
    visCb.type = 'checkbox';
    visCb.className = 'lc-vis';
    visCb.checked = cfg.visible !== false;
    visCb.addEventListener('change', () => {
      layerConfig[l].visible = visCb.checked;
      row.classList.toggle('lc-hidden', !visCb.checked);
      if (state.viewMode === 'layers' && threeReady) {
        requestAnimationFrame(() => rebuildTerrain());
      }
    });

    // Color swatch (clickable to open native color picker)
    const swatch = document.createElement('div');
    swatch.className = 'lc-swatch';
    swatch.style.background = cfg.color;
    const cp = document.createElement('input');
    cp.type = 'color';
    cp.className = 'lc-colorpicker';
    cp.value = cfg.color;
    cp.addEventListener('input', () => {
      swatch.style.background = cp.value;
      layerConfig[l].color = cp.value;
      if (state.viewMode === 'layers' && threeReady) {
        requestAnimationFrame(() => rebuildTerrain());
      }
    });
    swatch.appendChild(cp);

    // Name input
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'lc-name';
    nameInput.value = cfg.name;
    nameInput.maxLength = 32;
    nameInput.addEventListener('input', () => {
      layerConfig[l].name = nameInput.value || 'Capa ' + l;
    });

    // Layer number label
    const numLabel = document.createElement('span');
    numLabel.className = 'lc-num';
    numLabel.textContent = l;

    row.appendChild(visCb);
    row.appendChild(numLabel);
    row.appendChild(swatch);
    row.appendChild(nameInput);
    if (!cfg.visible) row.classList.add('lc-hidden');
    container.appendChild(row);
  }
}

function applyLayerColorsToColorData() {
  // Write layer colors into colorData permanently
  if (!colorData || colorData.length !== RES * RES * 3) {
    colorData = new Float32Array(RES * RES * 3);
  }
  const N = state.layers;
  const c = new THREE.Color();
  for (let i = 0; i < RES * RES; i++) {
    const z = Math.floor(i / RES);
    const x = i % RES;
    const v = baseHeightData[z * RES + x];
    const li = getLayerIndexForHeight(v, N);
    if (li === 0 || !layerConfig[li] || layerConfig[li].visible === false) {
      colorData[i*3] = 0; colorData[i*3+1] = 0; colorData[i*3+2] = 0;
    } else {
      c.set(layerConfig[li].color);
      colorData[i*3] = c.r; colorData[i*3+1] = c.g; colorData[i*3+2] = c.b;
    }
  }
  if (threeReady && terrainMesh && state.viewMode === 'solid') {
    const geo = terrainMesh.geometry;
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colorData, 3));
    geo.attributes.color.needsUpdate = true;
  }
}

function updateLayerColorsFromConfig(skipMeshUpdate) {
  if (!terrainMesh || state.viewMode !== 'layers') return;
  const N = state.layers;
  const geo = terrainMesh.geometry;
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const z = Math.floor(i / RES);
    const x = i % RES;
    const v = baseHeightData[z * RES + x];
    const li = getLayerIndexForHeight(v, N);
    if (li === 0 || !layerConfig[li] || layerConfig[li].visible === false) {
      colors[i*3] = 0; colors[i*3+1] = 0; colors[i*3+2] = 0; // hidden/invisible
    } else {
      c.set(layerConfig[li].color);
      colors[i*3] = c.r; colors[i*3+1] = c.g; colors[i*3+2] = c.b;
    }
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.attributes.color.needsUpdate = true;
  // Also update mesh vertices to flatten hidden layers (skip if called from within updateMeshVertices)
  if (!skipMeshUpdate) {
    updateMeshVertices(true, true);
  }
}

// ═══════════════════════════════════════════════════════
// MATERIAL-BASED PAINTING
// ═══════════════════════════════════════════════════════
function initMaterialMap() {
  if (!materialMap || materialMap.length !== RES * RES) {
    materialMap = new Uint8Array(RES * RES);
  } else {
    materialMap.fill(0);
  }
  syncColorDataFromMaterials();
}

function syncColorDataFromMaterials() {
  if (!materialMap || !colorData || colorData.length !== RES * RES * 3) {
    colorData = new Float32Array(RES * RES * 3);
  }
  const c = new THREE.Color();
  for (let i = 0; i < RES * RES; i++) {
    const matId = materialMap[i];
    const mat = MATERIALS[matId] || MATERIALS[0];
    c.set(mat.color);
    colorData[i*3] = c.r;
    colorData[i*3+1] = c.g;
    colorData[i*3+2] = c.b;
  }
  // Update mesh colors if in solid mode
  if (threeReady && terrainMesh && state.viewMode === 'solid') {
    const geo = terrainMesh.geometry;
    const curAttr = geo.getAttribute('color');
    if (curAttr) {
      for (let i = 0; i < curAttr.count; i++) {
        const z = Math.floor(i / RES);
        const x = i % RES;
        if (z < RES && x < RES) {
          const idx = (z * RES + x) * 3;
          curAttr.array[i*3] = colorData[idx];
          curAttr.array[i*3+1] = colorData[idx+1];
          curAttr.array[i*3+2] = colorData[idx+2];
        }
      }
      curAttr.needsUpdate = true;
    }
  }
}

function paintMaterialAt(gx, gz, matId) {
  const size = state.brushSize, flow = state.brushFlow / 100;
  const radius = size / 2;
  const ceilRad = Math.ceil(radius);
  let changed = false;
  for (let dz = -ceilRad; dz <= ceilRad; dz++) for (let dx = -ceilRad; dx <= ceilRad; dx++) {
    const px = gx+dx, pz = gz+dz;
    if (px<0 || px>=RES || pz<0 || pz>=RES) continue;
    const dist = Math.sqrt(dx*dx+dz*dz);
    if (dist > radius) continue;
    const f = 1 - dist/radius;
    if (Math.random() > f * flow) continue; // flow control
    materialMap[pz*RES+px] = matId;
    changed = true;
  }
  if (changed) syncColorDataFromMaterials();
}

// Flood-fill: paint the ENTIRE connected component at the clicked cell's height layer
// with the given material. Only affects cells at the same quantized height level
// that are 4-directionally connected.
function floodFillMaterial(gx, gz, matId) {
  if (!materialMap) return;
  const N = state.layers;
  const targetH = baseHeightData[gz * RES + gx];
  if (targetH <= 0.001) return; // background, nothing to flood
  
  const qh = Math.ceil(targetH * N) / N;
  const visited = new Uint8Array(RES * RES);
  const queue = [[gx, gz]];
  visited[gz * RES + gx] = 1;
  let head = 0;
  
  const dirs = [[-1,0],[1,0],[0,-1],[0,1]]; // 4-directional
  
  while (head < queue.length) {
    const [cx, cz] = queue[head++];
    const idx = cz * RES + cx;
    
    // Set material for this cell
    materialMap[idx] = matId;
    
    for (const [dx, dz] of dirs) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nx >= RES || nz < 0 || nz >= RES) continue;
      const nidx = nz * RES + nx;
      if (visited[nidx]) continue;
      
      // Check if neighbor is at the same quantized height
      const nh = baseHeightData[nidx];
      if (nh <= 0.001) continue;
      const nqh = Math.ceil(nh * N) / N;
      if (nqh !== qh) continue;
      
      visited[nidx] = 1;
      queue.push([nx, nz]);
    }
  }
  
  syncColorDataFromMaterials();
  toast('Componente pintado como ' + (MATERIALS[matId]?.name || 'material'));
}

// ═══════════════════════════════════════════════════════
// FILL TERRAIN HOLES — fill internal empty cells (height=0)
// that are surrounded by terrain, making each layer solid.
// ═══════════════════════════════════════════════════════
function fillTerrainHoles() {
  if (!materialMap) initMaterialMap();
  saveUndoSnapshot();
  const N = state.layers;

  // Step 1: Flood-fill from ALL grid borders through empty cells
  // Any empty cell NOT reached is an internal hole (surrounded by terrain)
  const visited = new Uint8Array(RES * RES);
  const queue = [];
  const dirs = [[-1,0],[1,0],[0,-1],[0,1]];

  // Seed: all empty cells on the 4 borders of the grid
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      const isBorder = (y === 0 || y === RES-1 || x === 0 || x === RES-1);
      if (isBorder && heightData[y * RES + x] <= 0.001 && !visited[y * RES + x]) {
        visited[y * RES + x] = 1;
        queue.push([x, y]);
      }
    }
  }

  // BFS through all empty cells reachable from the border
  let head = 0;
  while (head < queue.length) {
    const [cx, cy] = queue[head++];
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || nx >= RES || ny < 0 || ny >= RES) continue;
      const nidx = ny * RES + nx;
      if (visited[nidx]) continue;
      // Only flood through empty cells (height=0 or background)
      if (heightData[nidx] <= 0.001) {
        visited[nidx] = 1;
        queue.push([nx, ny]);
      }
    }
  }

  // Step 2: Count internal holes (empty cells NOT visited by border flood)
  let internalCount = 0;
  for (let i = 0; i < RES * RES; i++) {
    if (heightData[i] <= 0.001 && !visited[i]) internalCount++;
  }
  if (internalCount === 0) { toast('No se encontraron huecos internos'); return; }

  // Step 3: Find the minimum terrain height to use as fill value
  // Scan nearby terrain cells around each hole to determine fill height
  let minH = 1;
  for (let i = 0; i < RES * RES; i++) {
    if (heightData[i] > 0.001) minH = Math.min(minH, heightData[i]);
  }
  const layerHeight = Math.max(Math.ceil(minH * N) / N, 1 / N);

  // Step 4: Fill all internal holes
  let filled = 0;
  for (let i = 0; i < RES * RES; i++) {
    if (heightData[i] <= 0.001 && !visited[i]) {
      heightData[i] = layerHeight;
      filled++;
    }
  }

  needsRegen = true;
  drawCanvas();
  if (threeReady) rebuildTerrain();
  toast(filled + ' huecos internos rellenados a nivel capa base');
}

function rebuildTerrain() {
  if (!threeReady) return;

  // Compute total height from all layers
  if (layerHeights && layerHeights.length > 0) {
    computeTotalHeight();
    heightData.set(totalHeightData);
  }

  // 1. Smooth into baseHeightData
  if (state.smoothing > 0) {
    const saved = new Float32Array(heightData);
    smoothHeightmap(state.smoothing);
    baseHeightData.set(heightData);
    heightData.set(saved);
  } else {
    baseHeightData.set(heightData);
  }

  // 2. Apply brightness/contrast
  applyBrilloContraste();

  // 3. Update canvas
  drawCanvas();

  // Initialize colorData and materialMap if needed
  if (!materialMap || materialMap.length !== RES*RES) {
    initMaterialMap();
  } else if (!colorData || colorData.length !== RES*RES*3) {
    syncColorDataFromMaterials();
  }

  const scaleX = state.sizeX, scaleZ = state.sizeZ, hScale = state.maxHeight * HEIGHT_SCALE;
  const mScaleX = state.modelScaleX, mScaleZ = state.modelScaleZ;

  // Remove old terrain
  if (terrainGroup) {
    scene.remove(terrainGroup);
    terrainGroup.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
    terrainGroup = null;
  }
  terrainMesh = null;
  layerMeshes = [];

  if (state.viewMode === 'layers' && layerHeights && layerHeights.length > 0) {
    // ── LAYERS MODE: one mesh per visible layer ──
    const N = layerHeights.length;
    terrainGroup = new THREE.Group();
    
    for (let l = 0; l < N; l++) {
      const layerNum = l + 1; // 1-indexed for layerConfig
      if (!layerConfig[layerNum] || layerConfig[layerNum].visible === false) continue;
      
      const lh = layerHeights[l];
      const positions = [], indices = [];
      const color = new THREE.Color(layerConfig[layerNum].color);
      
      // Compute accumulated base Y from layers below (Option B: muted layers still count)
      const baseYArr = new Float32Array(RES * RES);
      for (let bl = 0; bl < l; bl++) {
        const blh = layerHeights[bl];
        for (let i = 0; i < RES * RES; i++) {
          baseYArr[i] += blh[i];
        }
      }
      
      // Build positions
      for (let z = 0; z < RES; z++) for (let x = 0; x < RES; x++) {
        const idx = z * RES + x;
        const layerH = lh[idx];
        const baseH = baseYArr[idx];
        const totalH = baseH + layerH;
        const px = (x / (RES-1) - 0.5) * scaleX * mScaleX;
        const pz = (z / (RES-1) - 0.5) * scaleZ * mScaleZ;
        if (layerH > 0.001) {
          positions.push(px, totalH * hScale, pz);
        } else {
          // Place vertex at base height (layer below's top) — flat
          positions.push(px, baseH * hScale, pz);
        }
      }
      
      // Build indices (skip quads where this layer has 0 height on all 4 corners)
      for (let z = 0; z < RES-1; z++) for (let x = 0; x < RES-1; x++) {
        const a = z*RES+x, b = z*RES+x+1, c = (z+1)*RES+x, d = (z+1)*RES+x+1;
        if (lh[a] <= 0.001 && lh[b] <= 0.001 && lh[c] <= 0.001 && lh[d] <= 0.001) continue;
        indices.push(a,c,b); indices.push(b,c,d);
      }
      
      if (indices.length === 0) continue;
      
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      
      // Vertex colors for this layer
      const colors = new Float32Array(RES * RES * 3);
      for (let i = 0; i < RES * RES; i++) {
        colors[i*3] = color.r;
        colors[i*3+1] = color.g;
        colors[i*3+2] = color.b;
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.6,
        metalness: 0.05,
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.layerIndex = l;
      terrainGroup.add(mesh);
      layerMeshes.push(mesh);
      terrainMesh = mesh; // For raycasting: use last visible layer
    }
    
    if (terrainGroup.children.length > 0) {
      scene.add(terrainGroup);
    }
    
  } else {
    // ── NON-LAYERS MODE: single mesh (solid, heat, wire) ──
    const positions = [], indices = [], colors = [];
    
    for (let z = 0; z < RES; z++) for (let x = 0; x < RES; x++) {
      const idx = z * RES + x;
      const h = baseHeightData[idx];
      const ph = h > 0.001 ? Math.ceil(h * state.layers) / state.layers : 0;
      positions.push(
        (x/(RES-1)-0.5)*scaleX * mScaleX,
        ph * hScale,
        (z/(RES-1)-0.5)*scaleZ * mScaleZ
      );
      if (state.viewMode === 'heat') {
        const c = new THREE.Color();
        const t = h;
        if (t<0.25) c.setHSL(0.65-t*1.0, 0.9, 0.3+t*0.5);
        else if (t<0.5) c.setHSL(0.50-(t-0.25)*0.8, 0.85, 0.45+(t-0.25)*0.3);
        else if (t<0.75) c.setHSL(0.25-(t-0.5)*0.6, 0.8, 0.55+(t-0.5)*0.25);
        else c.setHSL(0.08-(t-0.75)*0.2, 0.9, 0.6+(t-0.75)*0.3);
        colors.push(c.r, c.g, c.b);
      } else {
        const ci = idx * 3;
        colors.push(colorData[ci], colorData[ci+1], colorData[ci+2]);
      }
    }
    
    for (let z = 0; z < RES-1; z++) for (let x = 0; x < RES-1; x++) {
      const a=z*RES+x, b=z*RES+x+1, c=(z+1)*RES+x, d=(z+1)*RES+x+1;
      if (!state.showBase && baseHeightData[a] <= 0.001 && baseHeightData[b] <= 0.001 && baseHeightData[c] <= 0.001 && baseHeightData[d] <= 0.001) continue;
      indices.push(a,c,b); indices.push(b,c,d);
    }
    
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    
    let mat;
    if (state.viewMode === 'wire') {
      mat = new THREE.MeshStandardMaterial({color:0x8caa80, wireframe:true, roughness:0.7, metalness:0.1});
    } else {
      mat = new THREE.MeshStandardMaterial({vertexColors:true, roughness:0.6, metalness:0.05, side:THREE.DoubleSide});
    }
    
    terrainMesh = new THREE.Mesh(geo, mat);
    terrainMesh.castShadow = true;
    terrainMesh.receiveShadow = true;
    
    terrainGroup = new THREE.Group();
    terrainGroup.add(terrainMesh);
    scene.add(terrainGroup);
  }

  needsRegen = false;
  hideLoading();

  // Keep ruler with original grid distances (modelScale is visual-only)
  if (rulerGroup) { scene.remove(rulerGroup); rulerGroup.traverse(c => { if (c.geometry) c.geometry.dispose(); }); rulerGroup = null; }
  buildRuler(state.sizeX, state.sizeZ);
  updateDimOverlay();

  // Update shadow camera to fit terrain
  const dl = scene.children.find(c => c.isDirectionalLight && c.shadow);
  if (dl) {
    const shMax = Math.max(state.sizeX, state.sizeZ, state.maxHeight * HEIGHT_SCALE) * 1.5;
    dl.shadow.camera.left = -shMax; dl.shadow.camera.right = shMax;
    dl.shadow.camera.top = shMax; dl.shadow.camera.bottom = -shMax;
    dl.shadow.camera.far = shMax * 3;
    dl.shadow.camera.updateProjectionMatrix();
  }

  // Adjust orbit max distance
  controls.maxDistance = Math.max(state.sizeX, state.sizeZ) * 4;
  // Ensure camera far plane is large enough for current size
  const neededFar = Math.max(state.sizeX, state.sizeZ) * 5;
  if (camera.far < neededFar) {
    camera.far = neededFar;
    camera.updateProjectionMatrix();
  }
}

// ═══════════════════════════════════════════════════════
// VIEW MODE
// ═══════════════════════════════════════════════════════
function setViewMode(mode) {
  state.viewMode = mode;
  document.querySelectorAll('.viewport-overlay .btn').forEach(b => b.classList.remove('active3d'));
  if (mode === 'solid') $('#viewMode3d').classList.add('active3d');
  else if (mode === 'heat') $('#viewModeHeat').classList.add('active3d');
  else if (mode === 'wire') $('#viewModeWire').classList.add('active3d');
  else if (mode === 'layers') {
    $('#viewModeLayers').classList.add('active3d');
    initLayerConfig(state.layers);
  }
  setLoading('Cambiando vista...');
  requestAnimationFrame(() => rebuildTerrain());
}
$('#viewMode3d').addEventListener('click', () => setViewMode('solid'));
$('#viewModeHeat').addEventListener('click', () => setViewMode('heat'));
$('#viewModeWire').addEventListener('click', () => setViewMode('wire'));
$('#viewModeLayers').addEventListener('click', () => setViewMode('layers'));

// ═══════════════════════════════════════════════════════
// 3D RAYCAST PAINTING
// ═══════════════════════════════════════════════════════
let is3dPainting = false;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
// 3D Paint is always active now - clicking on terrain always paints
state.paint3d = true;

// Undo stack for 3D brush strokes
const undoStack = [];
const UNDO_MAX = 30;

function saveUndoSnapshot() {
  const snap = { heightData: new Float32Array(heightData) };
  if (colorData) snap.colorData = new Float32Array(colorData);
  if (materialMap) snap.materialMap = new Uint8Array(materialMap);
  // Save layerHeights if in layers mode
  if (layerHeights && layerHeights.length > 0) {
    snap.layerHeights = layerHeights.map(lh => new Float32Array(lh));
  }
  undoStack.push(snap);
  if (undoStack.length > UNDO_MAX) undoStack.shift();
}

function undoLastPaint() {
  if (undoStack.length === 0) { toast('No hay acciones para deshacer'); return; }
  const snap = undoStack.pop();
  heightData.set(snap.heightData);
  if (snap.colorData && colorData) colorData.set(snap.colorData);
  if (snap.materialMap && materialMap) {
    materialMap.set(snap.materialMap);
    syncColorDataFromMaterials();
  }
  // Restore layerHeights if present
  if (snap.layerHeights && layerHeights) {
    for (let l = 0; l < Math.min(snap.layerHeights.length, layerHeights.length); l++) {
      layerHeights[l].set(snap.layerHeights[l]);
    }
    computeTotalHeight();
    heightData.set(totalHeightData);
  }
  baseHeightData.set(heightData);
  needsRegen = true;
  drawCanvas();
  rebuildTerrain();
  toast('Deshecho (Ctrl+Z)');
}

function get3dGridPos(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  if (!terrainGroup || terrainGroup.children.length === 0) return null;
  // intersect recursively through the group to hit child meshes
  const intersects = raycaster.intersectObject(terrainGroup, true);
  if (intersects.length === 0) return null;
  const pt = intersects[0].point;
  const sX = state.sizeX, sZ = state.sizeZ;
  const mSX = state.modelScaleX || 1, mSZ = state.modelScaleZ || 1;
  const gx = Math.round(((pt.x / (sX * mSX)) + 0.5) * (RES-1));
  const gz = Math.round(((pt.z / (sZ * mSZ)) + 0.5) * (RES-1));
  if (gx < 0 || gx >= RES || gz < 0 || gz >= RES) return null;
  return {x: gx, z: gz};
}

// Clamp height to remain in visible layer range (Capas mode only)
// Allows cells to move INTO visible layers from hidden layers, but prevents
// cells from settling into hidden layers.
function clampToVisibleLayers(idx, newHeight, oldHeight) {
  if (state.viewMode !== 'layers' || newHeight <= 0.001) return newHeight;
  if (oldHeight === undefined) oldHeight = heightData[idx];
  const N = state.layers;
  const newLayer = Math.min(Math.ceil(newHeight * N), N);

  // If new height is in a visible layer, no clamping needed
  if (!layerConfig[newLayer] || layerConfig[newLayer].visible !== false) return newHeight;

  // New height is in a hidden layer - find nearest visible layer to clamp to
  const layerBottom = (newLayer - 1) / N;
  const layerTop = newLayer / N;

  // Check adjacent layers for visibility
  let clampTarget = null;
  // Layer below this hidden layer is visible → clamp just above its bottom (= just below this hidden layer)
  if (newLayer > 1 && layerConfig[newLayer - 1] && layerConfig[newLayer - 1].visible !== false) {
    clampTarget = layerBottom - 0.0001; // just inside the visible layer below
  }
  // Layer above this hidden layer is visible → clamp just below its top (= just above this hidden layer)
  if (newLayer < N && layerConfig[newLayer + 1] && layerConfig[newLayer + 1].visible !== false) {
    const aboveClamp = layerTop + 0.0001; // just inside the visible layer above
    if (clampTarget === null || Math.abs(newHeight - aboveClamp) < Math.abs(newHeight - clampTarget)) {
      clampTarget = aboveClamp;
    }
  }

  // If no visible layer adjacent, scan all layers
  if (clampTarget === null) {
    let bestDist = Infinity;
    for (let l = 1; l <= N; l++) {
      if (layerConfig[l] && layerConfig[l].visible !== false) {
        const lBottom = (l - 1) / N;
        const lTop = l / N;
        // Cell is above this visible layer → clamp to Top - epsilon (inside visible layer)
        if (newHeight >= lTop) {
          const d = newHeight - lTop;
          if (d < bestDist) { bestDist = d; clampTarget = lTop - 0.0001; }
        }
        // Cell is below this visible layer → clamp to Bottom + epsilon (inside visible layer)
        if (newHeight <= lBottom) {
          const d = lBottom - newHeight;
          if (d < bestDist) { bestDist = d; clampTarget = lBottom + 0.0001; }
        }
      }
    }
  }

  if (clampTarget !== null) {
    return Math.max(0, Math.min(1, clampTarget));
  }
  return newHeight;
}

function paint3dAt(gx, gz) {
  const size = state.brushSize, flow = state.brushFlow / 100;
  const radius = size / 2;
  const ceilRad = Math.ceil(radius);
  // Safety guard: floodfill is handled separately in mousedown, never via brush
  if (state.tool === 'floodfill') return;
  // Safety guard: color has its own handler, never via brush elevation
  // Determine which height data to modify based on view mode
  const useLayers = state.viewMode === 'layers' && layerHeights && layerHeights.length > 0;
  const li = useLayers ? Math.max(0, Math.min(layerHeights.length - 1, activeLayer - 1)) : -1;
  
  for (let dz = -ceilRad; dz <= ceilRad; dz++) for (let dx = -ceilRad; dx <= ceilRad; dx++) {
    const px = gx+dx, pz = gz+dz;
    if (px<0 || px>=RES || pz<0 || pz>=RES) continue;
    const dist = Math.sqrt(dx*dx+dz*dz);
    if (dist > radius) continue;
    const f = 1 - dist/radius;
    
    if (useLayers) {
      const cur = layerHeights[li][pz*RES+px];
      if (state.tool === 'smooth') {
        if (smoothRefHeight >= 0 && cur !== smoothRefHeight) {
          const rate = Math.abs(state.brushStrength);
          const amount = f * flow * (0.05 + rate * 0.20);
          if (cur < smoothRefHeight) {
            layerHeights[li][pz*RES+px] = Math.min(smoothRefHeight, cur + amount);
          } else {
            layerHeights[li][pz*RES+px] = Math.max(smoothRefHeight, cur - amount);
          }
        }
      } else if (state.tool === 'color') {
        // Color painting in layers mode: modify the layer's color? For now, skip
      } else {
        const dir = state.tool === 'add' ? 1 : -1;
        const rate = Math.abs(state.brushStrength);
        const amount = f * flow * (0.05 + rate * 0.20);
        const newH = Math.max(0, Math.min(1, cur + dir * amount));
        layerHeights[li][pz*RES+px] = newH;
      }
    } else {
    const cur = heightData[pz*RES+px];
    if (state.tool === 'smooth') {
      // Flatten toward reference height (captured on mousedown)
      if (smoothRefHeight >= 0 && cur !== smoothRefHeight) {
        const rate = Math.abs(state.brushStrength);
        const amount = f * flow * (0.05 + rate * 0.20);
        if (cur < smoothRefHeight) {
          const newH = Math.min(smoothRefHeight, cur + amount);
          heightData[pz*RES+px] = clampToVisibleLayers(pz*RES+px, newH, cur);
        } else {
          const newH = Math.max(smoothRefHeight, cur - amount);
          heightData[pz*RES+px] = clampToVisibleLayers(pz*RES+px, newH, cur);
        }
      }
    }
    else if (state.tool === 'color') {
      const col = new THREE.Color(state.paintColor || '#c4a265');
      const alpha = state.paintAlpha * f * flow;
      const idx = (pz*RES+px)*3;
      colorData[idx] = colorData[idx] * (1-alpha) + col.r * alpha;
      colorData[idx+1] = colorData[idx+1] * (1-alpha) + col.g * alpha;
      colorData[idx+2] = colorData[idx+2] * (1-alpha) + col.b * alpha;
    }
    else {
      // Elevation: direction from active button (add=subir, sub=bajar)
      const dir = state.tool === 'add' ? 1 : -1;
      const rate = Math.abs(state.brushStrength);
      const amount = f * flow * (0.05 + rate * 0.20);
      // Modify ALL cells. clampToVisibleLayers ensures result stays in visible layers.
      const newH = Math.max(0, Math.min(1, cur + dir * amount));
      heightData[pz*RES+px] = clampToVisibleLayers(pz*RES+px, newH, cur);
    }
    }
  }
  needsRegen = true;
  // Sync total height in layers mode
  if (useLayers) {
    computeTotalHeight();
    heightData.set(totalHeightData);
  }
}

function updateMeshVertices(smooth, updateNormals) {
  if (!terrainGroup) return;
  
  // In layers mode, update just the active layer's mesh for performance
  if (state.viewMode === 'layers' && layerHeights && layerHeights.length > 0) {
    const li = Math.max(0, Math.min(layerHeights.length - 1, activeLayer - 1));
    const layerNum = li + 1;
    // Find the mesh for this layer
    const mesh = layerMeshes.find(m => m.userData.layerIndex === li);
    if (!mesh) { rebuildTerrain(); return; }
    
    const hScale = state.maxHeight * HEIGHT_SCALE;
    const scaleX = state.sizeX, scaleZ = state.sizeZ;
    const mScaleX = state.modelScaleX, mScaleZ = state.modelScaleZ;
    const lh = layerHeights[li];
    
    // Compute accumulated base Y from layers below
    const baseYArr = new Float32Array(RES * RES);
    for (let bl = 0; bl < li; bl++) {
      const blh = layerHeights[bl];
      for (let i = 0; i < RES * RES; i++) {
        baseYArr[i] += blh[i];
      }
    }
    
    const geo = mesh.geometry;
    const posAttr = geo.getAttribute('position');
    const arr = posAttr.array;
    
    for (let z = 0; z < RES; z++) for (let x = 0; x < RES; x++) {
      const idx = z * RES + x;
      const layerH = lh[idx];
      const baseH = baseYArr[idx];
      const totalH = baseH + layerH;
      const px = (x / (RES-1) - 0.5) * scaleX * mScaleX;
      const pz = (z / (RES-1) - 0.5) * scaleZ * mScaleZ;
      const vi = idx * 3;
      arr[vi] = px;
      arr[vi + 1] = layerH > 0.001 ? totalH * hScale : baseH * hScale;
      arr[vi + 2] = pz;
    }
    posAttr.needsUpdate = true;
    if (updateNormals !== false) {
      geo.computeVertexNormals();
    }
    return;
  }
  
  // Non-layers mode: fast vertex update (original logic)
  if (!terrainMesh) return;
  const hScale = state.maxHeight * HEIGHT_SCALE, N = state.layers;
  let src = heightData;
  if (smooth && state.smoothing > 0) {
    src = new Float32Array(heightData);
    const tmp = new Float32Array(RES*RES);
    for (let p = 0; p < state.smoothing; p++) {
      for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
        const idx = y*RES+x;
        if (src[idx] <= 0.001) { tmp[idx] = 0; continue; }
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x+dx, ny = y+dy;
          if (nx>=0 && nx<RES && ny>=0 && ny<RES) {
            const v = src[ny*RES+nx];
            if (v > 0.001) { s += v; n++; }
          }
        }
        tmp[idx] = n > 0 ? s / n : src[idx];
      }
      src.set(tmp);
    }
  }
  baseHeightData.set(src);
  // Apply brightness/contrast so the display always matches slider values during painting
  applyBrilloContraste();
  const posAttr = terrainMesh.geometry.getAttribute('position');
  const arr = posAttr.array;
  for (let z = 0; z < RES; z++) for (let x = 0; x < RES; x++) {
    const idx = z*RES+x;
    let v = baseHeightData[idx];
    const h = v > 0.001 ? Math.ceil(v * N) / N : 0;
    arr[(z*RES+x)*3+1] = h * hScale;
  }
  posAttr.needsUpdate = true;
  // Only recompute normals when explicitly requested (avoid GPU issues during paint loop)
  if (updateNormals !== false) {
    terrainMesh.geometry.computeVertexNormals();
  }
}

const showBaseBtn = document.getElementById('showBaseBtn');
showBaseBtn.addEventListener('click', () => {
  state.showBase = !state.showBase;
  showBaseBtn.innerHTML = state.showBase ? '🧱 Base visible' : '🧱 Base oculta';
  scheduleRebuild();
});

function setup3dPaintEvents() {
  renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
  renderer.domElement.addEventListener('mousedown', e => {
    if (!terrainMesh || e.button !== 0) return;
    const p = get3dGridPos(e);
    if (!p) return;
    controls.enabled = false;
    is3dPainting = true;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    // Save undo snapshot BEFORE painting
    saveUndoSnapshot();
    // Capture reference height for smooth flatten tool
    if (state.tool === 'smooth') {
      smoothRefHeight = heightData[p.z*RES+p.x];
    }
    // If flood-fill tool is active, flood-fill the connected component
    if (state.tool === 'floodfill') {
      if (activeMaterialId >= 0) {
        floodFillMaterial(p.x, p.z, activeMaterialId);
      } else {
        toast('Seleccioná un material (Tierra/Agua) primero');
      }
      is3dPainting = false;
      controls.enabled = true;
      return;
    }
    // Paint first frame (animate loop handles subsequent frames)
    paint3dAt(p.x, p.z);
    if (state.tool === 'color') {
      updateMeshColors(); // live color feedback
    } else {
      updateMeshVertices(true, false); // smooth display copy, no normals (GPU sync)
    }
    drawCanvas();
    updateBrushRing(e);
  });
  // Track mouse position ALWAYS for animate loop raycasting
  renderer.domElement.addEventListener('mousemove', e => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    updateBrushRing(e);
  });
  window.addEventListener('mouseup', () => {
    if (is3dPainting) {
      is3dPainting = false; controls.enabled = true;
      // Smooth on mouseup — applies smoothing to a COPY of heightData so raw paint
      // data is preserved while the display shows the smooth result immediately.
      updateMeshVertices(true, true);
      drawCanvas();
      if (state.tool === 'color' && terrainMesh) {
        updateMeshColors();
      }
    }
    brushRing.visible = false;
  });
  renderer.domElement.addEventListener('mouseleave', () => {
    if (is3dPainting) {
      is3dPainting = false; controls.enabled = true;
      updateMeshVertices(true, true);
      drawCanvas();
      if (state.tool === 'color' && terrainMesh) {
        updateMeshColors();
      }
    }
    brushRing.visible = false;
  });

  function updateBrushRing(e) {
    if (!brushRing || !terrainGroup) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const py = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(new THREE.Vector2(px, py), camera);
    const hits = raycaster.intersectObject(terrainGroup, true);
    if (hits.length > 0) {
      const pt = hits[0].point;
      const mRing = ((state.modelScaleX || 1) + (state.modelScaleZ || 1)) / 2;
      const ringScale = (state.sizeX + state.sizeZ) / 2 * mRing;
      const r = (state.brushSize / RES) * ringScale * 0.5;
      brushRing.position.set(pt.x, pt.y + 0.02, pt.z);
      brushRing.scale.set(r/0.2, r/0.2, 1);
      brushRing.visible = state.paint3d;
    } else {
      brushRing.visible = false;
    }
  }
  // Ctrl+Z undo for 3D brush strokes
  window.addEventListener('keydown', function undoKeyHandler(e) {
    if (e.ctrlKey && e.key === 'z') {
      e.preventDefault();
      undoLastPaint();
    }
  });
}

// ═══════════════════════════════════════════════════════
// LAYER OUTLINE LINES (for GLB export)
// ═══════════════════════════════════════════════════════
function generateLayerOutlineLines() {
  const N = state.layers;
  const hScale = state.maxHeight * HEIGHT_SCALE;
  const scaleX = state.sizeX;
  const scaleZ = state.sizeZ;
  const pts = [];

function qh(v) { return v > 0.001 ? Math.ceil(v * N) / N : 0; }

  // Horizontal edges (between x and x+1)
  for (let z = 0; z < RES; z++) {
    for (let x = 0; x < RES - 1; x++) {
      const h1 = qh(baseHeightData[z * RES + x]);
      const h2 = qh(baseHeightData[z * RES + (x + 1)]);
      if (h1 !== h2) {
        const minH = Math.min(h1, h2);
        const px1 = (x / (RES - 1) - 0.5) * scaleX;
        const px2 = ((x + 1) / (RES - 1) - 0.5) * scaleX;
        const pz = (z / (RES - 1) - 0.5) * scaleZ;
        pts.push(px1, minH * hScale + 0.002, pz, px2, minH * hScale + 0.002, pz);
      }
    }
  }

  // Vertical edges (between z and z+1)
  for (let z = 0; z < RES - 1; z++) {
    for (let x = 0; x < RES; x++) {
      const h1 = qh(baseHeightData[z * RES + x]);
      const h2 = qh(baseHeightData[(z + 1) * RES + x]);
      if (h1 !== h2) {
        const minH = Math.min(h1, h2);
        const px = (x / (RES - 1) - 0.5) * scaleX;
        const pz1 = (z / (RES - 1) - 0.5) * scaleZ;
        const pz2 = ((z + 1) / (RES - 1) - 0.5) * scaleZ;
        pts.push(px, minH * hScale + 0.002, pz1, px, minH * hScale + 0.002, pz2);
      }
    }
  }

  if (pts.length === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.25,
    linewidth: 1,
  }));
}

// ═══════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════
$('#exportStl').addEventListener('click', () => {
  if (!terrainMesh) { toast('Primero generá el terreno'); return; }
  const b = new Blob([new STLExporter().parse(terrainMesh,{binary:false})], {type:'text/plain'});
  const u = URL.createObjectURL(b); const a = document.createElement('a');
  a.href = u; a.download = 'terrain_model.stl'; a.click(); URL.revokeObjectURL(u);
  toast('STL exportado');
});

$('#exportSvg').addEventListener('click', () => {
  if (!terrainMesh) { toast('Primero generá el terreno'); return; }
  const N = state.layers, W=800, H=800;
  const allParts = [];

  // Marching squares for one material's height data
  function generateMaterialSvgParts(matId, matName, matColor, labelPrefix) {
    const parts = [];
    // Create filtered height: only cells with this material keep height, others = 0
    const filtered = new Float32Array(RES * RES);
    for (let i = 0; i < RES * RES; i++) {
      if (materialMap && materialMap[i] === matId) {
        filtered[i] = baseHeightData[i];
      } else {
        filtered[i] = 0;
      }
    }

    for (let l=1; l<=N; l++) {
      // Capa 1: contorno exterior, capas 2+: borde inferior
      const th = l === 1 ? 0.001 : (l - 1) / N;
      const segs = [];
      for (let z=0;z<RES-1;z++) for (let x=0;x<RES-1;x++) {
        const v00=filtered[z*RES+x], v10=filtered[z*RES+(x+1)], v01=filtered[(z+1)*RES+x], v11=filtered[(z+1)*RES+(x+1)];
        const bits=(v00>=th?8:0)|(v10>=th?4:0)|(v01>=th?2:0)|(v11>=th?1:0);
        if (bits===0||bits===15) continue;
        const xf=g=>((g/(RES-1))-0.5)*W*0.85+W/2, yf=g=>((g/(RES-1))-0.5)*H*0.85+H/2;
        const cx=xf(x), nx=xf(x+1), cy=yf(z), ny=yf(z+1);
        const ip=(a,b,t)=>a+(b-a)*t;
        const ei=e=>{switch(e){case 0:return[ip(cx,nx,(th-v00)/(v10-v00)),cy];case 1:return[nx,ip(cy,ny,(th-v10)/(v11-v10))];case 2:return[ip(cx,nx,(th-v01)/(v11-v01)),ny];case 3:return[cx,ip(cy,ny,(th-v00)/(v01-v00))];default:return[0,0];}};
        const ec={1:[[3,2]],2:[[1,0]],3:[[3,1]],4:[[0,2]],5:[[0,2],[3,1]],6:[[0,0]],7:[[1,2]],8:[[0,1]],9:[[0,1]],10:[[1,3],[0,2]],11:[[1,2]],12:[[3,0]],13:[[1,3]],14:[[3,0]]};
        const es=ec[bits]; if (!es) continue;
        for (const [e1,e2] of es) { const [x1,y1]=ei(e1),[x2,y2]=ei(e2); segs.push({x1,y1,x2,y2}); }
      }
      if (segs.length===0) continue;
      let d = ''; for (const s of segs) d += `M${s.x1.toFixed(1)},${s.y1.toFixed(1)}L${s.x2.toFixed(1)},${s.y2.toFixed(1)}`;
      // Color: vary lightness based on layer within the material's hue
      // Extract hue from the material color
      const tmpC = new THREE.Color(matColor);
      const hsl = {};
      tmpC.getHSL(hsl);
      const hueDeg = Math.round(hsl.h * 360);
      const lightness = 25 + (l / N) * 45;
      const cl = `hsl(${hueDeg},65%,${lightness}%)`;
      const layerName = labelPrefix + ' ' + l;
      parts.push(`<path d="${d}" fill="none" stroke="${cl}" stroke-width="1.5" opacity="0.7"/><text x="20" y="${30+l*20}" font-size="10" fill="${cl}" font-family="sans-serif">${layerName}</text>`);
    }
    return parts;
  }

  // Generate tierra layers (material 0)
  const tierraColor = (MATERIALS[0] && MATERIALS[0].color) || '#c4a265';
  const tierraParts = generateMaterialSvgParts(0, 'Tierra', tierraColor, 'Capa Tierra');
  allParts.push(...tierraParts);

  // Generate agua layers (material 1) if present
  if (materialMap && materialMap.some(v => v === 1)) {
    const aguaColor = (MATERIALS[1] && MATERIALS[1].color) || '#4a9eff';
    const aguaParts = generateMaterialSvgParts(1, 'Agua', aguaColor, 'Capa Agua');
    // Offset agua legend below tierra legend
    for (let i = 0; i < aguaParts.length; i++) {
      aguaParts[i] = aguaParts[i].replace(/y="(\d+)"/, (m, y) => 'y="' + (parseInt(y) + N * 20 + 10) + '"');
    }
    allParts.push(...aguaParts);
  }

  if (allParts.length===0) { toast('No hay suficientes capas'); return; }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#0e0e14"/>${allParts.join('\\n')}</svg>`;
  const b = new Blob([svg], {type:'image/svg+xml'}); const u=URL.createObjectURL(b);
  const a = document.createElement('a'); a.href=u; a.download=`terrain_capas.svg`; a.click(); URL.revokeObjectURL(u);
  toast(`SVG con ${allParts.length} capas exportado`);
});

// Build a group with terrain + layer outline lines for GLB export
function buildGlbExportGroup() {
  const group = new THREE.Group();
  // Clone the terrain mesh for independent export
  const meshClone = terrainMesh.clone();
  // Ensure material is set up for vertex colors
  if (meshClone.material) {
    meshClone.material = meshClone.material.clone();
    meshClone.material.vertexColors = true;
    meshClone.material.roughness = 0.6;
    meshClone.material.metalness = 0.05;
  }
  group.add(meshClone);

  // Add layer outline lines
  const layerLines = generateLayerOutlineLines();
  if (layerLines) group.add(layerLines);

  return group;
}

// Generic GLB export function — calls callback with ArrayBuffer
function exportGlbThen(callback) {
  if (!terrainMesh) { toast('Primero generá el terreno'); return; }
  setLoading('Exportando GLB...');

  // Ensure baseHeightData is current for line generation
  if (!is3dPainting) {
    updateMeshVertices();
    drawCanvas();
  }

  const group = buildGlbExportGroup();
  const exporter = new GLTFExporter();
  const opt = { binary: true, trs: false, onlyVisible: true, includeCustomExtensions: false };
  exporter.parse(group, glb => {
    // Cleanup temporary meshes
    group.children.forEach(c => {
      if (c.geometry && c !== terrainMesh) c.geometry.dispose();
      if (c.material && c !== terrainMesh?.material) c.material.dispose();
    });
    hideLoading();
    callback(glb);
  }, e => { hideLoading(); toast('Error exportando GLB'); }, opt);
}

// Export GLB — download as file
$('#exportGlb').addEventListener('click', () => {
  exportGlbThen(glb => {
    const b = new Blob([glb], {type:'application/octet-stream'});
    const u = URL.createObjectURL(b); const a = document.createElement('a');
    a.href = u; a.download = 'terrain_model.glb'; a.click(); URL.revokeObjectURL(u);
    toast('GLB exportado con líneas de capa');
  });
});

// View GLB — open in glbviewer.html via postMessage
let pendingGlbData = null;
let pendingVectorData = null;

window.addEventListener('message', event => {
  if (event.data === 'glb_viewer_ready' && pendingGlbData) {
    event.source.postMessage({ type: 'glb_data', data: pendingGlbData }, event.origin);
    pendingGlbData = null;
  }
  if (event.data === 'vector_viewer_ready' && pendingVectorData) {
    event.source.postMessage(pendingVectorData, event.origin);
    pendingVectorData = null;
  }
  if (event.data === 'vector_viewer_recalculate') {
    sendVectorDataTo(event.source, event.origin);
  }
});

function sendVectorDataTo(source, origin) {
  source.postMessage({
    type: 'vector_data',
    heightData: Array.from(heightData),
    resolution: RES,
    layers: state.layers,
    sizeX: state.sizeX,
    sizeZ: state.sizeZ,
    modelScaleX: state.modelScaleX,
    modelScaleZ: state.modelScaleZ,
    maxHeight: state.maxHeight,
    smoothing: state.smoothing,
    brillo: state.brillo,
    contraste: state.contraste,
    layerConfig: layerConfig,
    materialMap: materialMap ? Array.from(materialMap) : null,
    materials: MATERIALS,
    version: 3
  }, origin);
  toast('Datos enviados al visor de vectores');
}

$('#viewGlbBtn').addEventListener('click', () => {
  exportGlbThen(glb => {
    pendingGlbData = glb;
    toast('Abriendo visor GLB...');
    // Pass current preset/terrain info so glbviewer URL reflects the model
    let viewerUrl = 'glbviewer.html';
    if (window._activePresetId) {
      viewerUrl += '?preset=' + encodeURIComponent(window._activePresetId);
      // Also save the GLB to the server so the viewer can load it directly
      if (IS_LOCAL) {
        fetch(API_BASE + '/api/terrain/' + encodeURIComponent(window._activePresetId) + '/glb', {
          method: 'POST',
          body: glb,
          headers: { 'Content-Type': 'application/octet-stream' }
        }).catch(err => console.warn('GLB upload failed:', err));
      }
    } else if (state.activeTerrain !== 'default-hill') {
      viewerUrl += '?terrain=' + encodeURIComponent(state.activeTerrain);
    }
    window.open(viewerUrl, '_blank');
  });
});

// Export Vector — open vectorviewer.html via postMessage
$('#exportVectorBtn').addEventListener('click', () => {
  if (!terrainMesh) { toast('Primero generá el terreno'); return; }
  // Send raw heightData — the vector viewer will apply smoothing/brillo itself
  pendingVectorData = {
    type: 'vector_data',
    heightData: Array.from(heightData),
    resolution: RES,
    layers: state.layers,
    sizeX: state.sizeX,
    sizeZ: state.sizeZ,
    modelScaleX: state.modelScaleX,
    modelScaleZ: state.modelScaleZ,
    maxHeight: state.maxHeight,
    smoothing: state.smoothing,
    brillo: state.brillo,
    contraste: state.contraste,
    version: 2
  };
  toast('Abriendo visor de vectores...');
  // Pass current preset/terrain info so vectorviewer URL reflects the model
  let viewerUrl = 'vectorviewer.html';
  if (window._activePresetId) {
    viewerUrl += '?preset=' + encodeURIComponent(window._activePresetId);
  } else if (state.activeTerrain && state.activeTerrain !== 'default-hill') {
    viewerUrl += '?terrain=' + encodeURIComponent(state.activeTerrain);
  }
  window.open(viewerUrl, '_blank');
});

// ═══════════════════════════════════════════════════════
// ADD NUMBER INPUTS TO ALL RANGE SLIDERS
// ═══════════════════════════════════════════════════════
document.querySelectorAll('.panel-left input[type="range"]').forEach(range => {
  const numInput = document.createElement('input');
  numInput.type = 'number';
  numInput.className = 'num-input';
  range.after(numInput);
  // Find the display span for this slider
  const valSpan = range.closest('.control-group')?.querySelector('.value');
  // Detect display scaling (e.g. maxHeight: slider=2.8, span="11.2", scale=4)
  const rawNum = parseFloat(range.value);
  const dispNum = valSpan ? parseFloat(valSpan.textContent) : rawNum;
  const scaleFactor = (!isNaN(rawNum) && !isNaN(dispNum) && rawNum !== 0) ? dispNum / rawNum : 1;
  numInput.dataset.scale = scaleFactor.toFixed(6);
  // Set number input min/max/step to DISPLAY range, not slider range
  const s = parseFloat(range.step) || 1;
  numInput.step = (s * scaleFactor).toFixed(6);
  numInput.min = (parseFloat(range.min) * scaleFactor).toFixed(6);
  numInput.max = (parseFloat(range.max) * scaleFactor).toFixed(6);
  // Range -> Number: read from display span (handles scaled values like maxHeight)
  const syncNumFromRange = () => {
    numInput.value = valSpan ? valSpan.textContent : range.value;
  };
  range.addEventListener('input', syncNumFromRange);
  // Number -> Range: convert from display value to internal slider value using scale factor
  const syncRangeFromNum = () => {
    let v = parseFloat(numInput.value);
    if (isNaN(v)) { syncNumFromRange(); return; }
    // Convert from display value to internal slider value
    const scale = parseFloat(numInput.dataset.scale) || 1;
    v = v / scale;
    // Clamp to slider range
    v = Math.max(parseFloat(range.min), Math.min(parseFloat(range.max), v));
    // Snap to step with epsilon for floating point safety
    const step = parseFloat(range.step) || 1;
    const eps = 1e-10;
    v = Math.round(v / step + eps) * step;
    v = parseFloat(v.toFixed(6));
    range.value = v;
    // Fire input event — existing handler updates state + display span
    range.dispatchEvent(new Event('input', { bubbles: true }));
    // Read back from display span so num shows formatted value
    if (valSpan) numInput.value = valSpan.textContent;
  };
  numInput.addEventListener('change', syncRangeFromNum);
  numInput.addEventListener('blur', syncRangeFromNum);
  numInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); syncRangeFromNum(); } });
  // Initial sync
  syncNumFromRange();
});

// ═══════════════════════════════════════════════════════
// UI BINDINGS
// ═══════════════════════════════════════════════════════
document.querySelectorAll('.paint-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!btn.dataset.tool) return; // skip buttons without data-tool (e.g. material-btn without paint-btn class)
    document.querySelectorAll('.paint-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.tool = btn.dataset.tool;
    updatePaintModeDisplay();
  });
});

// Material selector buttons (Tierra/Agua)
// Select which material the flood-fill tool uses
document.querySelectorAll('.material-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const matId = parseInt(btn.dataset.material);
    if (activeMaterialId === matId) {
      // Toggle off
      activeMaterialId = -1;
      btn.classList.remove('active');
      toast('Material desactivado');
    } else {
      activeMaterialId = matId;
      document.querySelectorAll('.material-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      toast('Material: ' + (MATERIALS[matId]?.name || 'Material'));
    }
    updatePaintModeDisplay();
  });
});

// Update the paint mode indicator in the section title
function updatePaintModeDisplay() {
  const label = document.getElementById('paintModeLabel');
  if (!label) return;
  if (state.tool === 'add') label.textContent = '· ⬆ Subir';
  else if (state.tool === 'sub') label.textContent = '· ⬇ Bajar';
  else if (state.tool === 'smooth') label.textContent = '· 🌊 Suavizar';
  else if (state.tool === 'color') label.textContent = '· 🎨 Color';
  else if (state.tool === 'floodfill') {
    const matName = activeMaterialId >= 0 ? (MATERIALS[activeMaterialId]?.name || '') : '';
    label.textContent = '· 🔫 Rellenar' + (matName ? ' (' + matName + ')' : ' (sin material)');
  }
}

const $layers = $('#layers'), $maxH = $('#maxHeight'), $smooth = $('#smoothing');
const $brillo = $('#brillo'), $constraste = $('#contraste');
const $brushSize = $('#brushSize'), $brushFlow = $('#brushFlow'), $brushStrength = $('#brushStrength'), $paintAlpha = $('#paintAlpha');
const $resolution = $('#resolution');
const $sizeX = $('#sizeX'), $sizeZ = $('#sizeZ');

$layers.addEventListener('input', () => { state.layers = parseInt($layers.value); $('#layersVal').textContent = state.layers; if (state.viewMode === 'layers') initLayerConfig(state.layers); scheduleRebuild(); });
$maxH.addEventListener('input', () => { state.maxHeight = parseFloat($maxH.value); $('#heightVal').textContent = (state.maxHeight * HEIGHT_SCALE).toFixed(1); scheduleRebuild(); });
$sizeX.addEventListener('input', () => { state.sizeX = parseFloat($sizeX.value); $('#sizeXVal').textContent = state.sizeX.toFixed(1); scheduleRebuild(); });
$sizeZ.addEventListener('input', () => { state.sizeZ = parseFloat($sizeZ.value); $('#sizeZVal').textContent = state.sizeZ.toFixed(1); scheduleRebuild(); });
const $modelScaleX = $('#modelScaleX'), $modelScaleZ = $('#modelScaleZ');
$modelScaleX.addEventListener('input', () => { state.modelScaleX = parseFloat($modelScaleX.value); $('#modelScaleXVal').textContent = state.modelScaleX.toFixed(2); scheduleRebuild(); });
$modelScaleZ.addEventListener('input', () => { state.modelScaleZ = parseFloat($modelScaleZ.value); $('#modelScaleZVal').textContent = state.modelScaleZ.toFixed(2); scheduleRebuild(); });
$smooth.addEventListener('input', () => { state.smoothing = parseInt($smooth.value); $('#smoothVal').textContent = state.smoothing; scheduleRebuild(); });
$brillo.addEventListener('input', () => { state.brillo = parseFloat($brillo.value); $('#brilloVal').textContent = state.brillo.toFixed(2); scheduleRebuild(); });
$constraste.addEventListener('input', () => { state.contraste = parseFloat($constraste.value); $('#contrasteVal').textContent = state.contraste.toFixed(2); scheduleRebuild(); });

$resolution.addEventListener('input', () => {
  state.resolution = parseInt($resolution.value);
  $('#resolutionVal').textContent = state.resolution;
  setLoading('Redimensionando...');
  reallocateData(state.resolution);
  drawCanvas();
  if (threeReady) requestAnimationFrame(() => { rebuildTerrain(); hideLoading(); });
});

$brushSize.addEventListener('input', () => { state.brushSize = parseInt($brushSize.value); $('#brushSizeVal').textContent = state.brushSize; });
$brushFlow.addEventListener('input', () => { state.brushFlow = parseInt($brushFlow.value); $('#brushFlowVal').textContent = state.brushFlow; });
$brushStrength.addEventListener('input', () => { state.brushStrength = parseFloat($brushStrength.value); $('#brushStrengthVal').textContent = state.brushStrength.toFixed(2);
  // Solo actualiza el display — la dirección la controlan los botones
  updatePaintModeDisplay();
});
$paintAlpha.addEventListener('input', () => { state.paintAlpha = parseFloat($paintAlpha.value); $('#paintAlphaVal').textContent = state.paintAlpha.toFixed(2); });

// Add color picker bindings
const $baseColor = $('#baseColorPicker');
const $paintColor = $('#paintColorPicker');
$baseColor.addEventListener('input', () => {
  state.baseColor = $baseColor.value;
  // Update Tierra material color
  MATERIALS[0].color = $baseColor.value;
  if (materialMap) syncColorDataFromMaterials();
  else scheduleRebuild();
});
$paintColor.addEventListener('input', () => {
  state.paintColor = $paintColor.value;
});
const $waterColor = $('#waterColorPicker');
$waterColor.addEventListener('input', () => {
  MATERIALS[1].color = $waterColor.value;
  if (materialMap) syncColorDataFromMaterials();
});

// Update mesh vertex colors after color painting (fast path)
function updateMeshColors() {
  if (!terrainMesh || state.viewMode === 'heat') return;
  const colorAttr = terrainMesh.geometry.getAttribute('color');
  if (!colorAttr) return;
  const arr = colorAttr.array;
  for (let z = 0; z < RES; z++) for (let x = 0; x < RES; x++) {
    const idx = (z*RES+x)*3;
    arr[idx] = colorData[idx];
    arr[idx+1] = colorData[idx+1];
    arr[idx+2] = colorData[idx+2];
  }
  colorAttr.needsUpdate = true;
}

$('#applyBtn').addEventListener('click', () => { setLoading('Aplicando cambios...'); requestAnimationFrame(() => rebuildTerrain()); toast('Terreno actualizado'); });
$('#resetHeightBtn').addEventListener('click', () => { 
  heightData.fill(0); baseHeightData.fill(0); 
  // Also reset layerHeights
  if (layerHeights) {
    for (let l = 0; l < layerHeights.length; l++) layerHeights[l].fill(0);
    computeTotalHeight();
  }
  needsRegen = true; drawCanvas(); if (threeReady) rebuildTerrain(); toast('Heightmap limpiado'); 
});
$('#fillHolesBtn').addEventListener('click', () => fillTerrainHoles());

$('#refreshLightBtn').addEventListener('click', () => {
  setLoading('Actualizando luz...');
  requestAnimationFrame(() => { rebuildTerrain(); toast('Iluminación actualizada'); });
});

// ═══════════════════════════════════════════════════════
// EXPORT / IMPORT TERRAIN AS JSON
// ═══════════════════════════════════════════════════════
$('#exportTerrainBtn').addEventListener('click', () => {
  const data = {
    version: 3,
    params: getStateSnapshot(),
    heightData: Array.from(heightData),
    colorData: colorData ? Array.from(colorData) : null,
    materialMap: materialMap ? Array.from(materialMap) : null,
    resolution: RES,
  };
  const json = JSON.stringify(data);
  const blob = new Blob([json], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'terreno_' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('Terreno exportado como JSON');
});

$('#importTerrainBtn').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.addEventListener('change', () => {
    if (!input.files[0]) return;
    setLoading('Importando terreno...');
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data.heightData || !data.resolution) {
          toast('Archivo JSON inválido: falta heightData o resolution');
          hideLoading();
          return;
        }
        // Import from version 1 (0..5 brushStrength) or version 2 (0..1)
        let brushStrength = data.params?.brushStrength;
        if (data.version === undefined || data.version === 1) {
          // Old format: brushStrength was 0..5, convert to 0..1
          if (brushStrength !== undefined) brushStrength = Math.round(brushStrength / 5 * 100) / 100;
        }
        // Restore resolution first
        if (data.resolution !== RES) {
          reallocateData(data.resolution);
        }
        // Force sync state.resolution with RES
        state.resolution = RES;
        $('#resolution').value = RES;
        $('#resolutionVal').textContent = RES;
        heightData = new Float32Array(data.heightData);
        baseHeightData.set(heightData);
        if (data.colorData && data.colorData.length === RES*RES*3) {
          colorData = new Float32Array(data.colorData);
        }
        if (data.materialMap && data.materialMap.length === RES*RES) {
          materialMap = new Uint8Array(data.materialMap);
        }
        if (data.params) {
          if (brushStrength !== undefined) data.params.brushStrength = brushStrength;
          // Apply params but skip resolution (already synced)
          const oldRes = data.params.resolution;
          data.params.resolution = RES; // prevent reallocateData from being called again
          applyStateSnapshot(data.params);
          data.params.resolution = oldRes; // restore for posterity
        }
        needsRegen = true;
        drawCanvas();
        requestAnimationFrame(() => {
          rebuildTerrain();
          // Restore colors after rebuild (rebuild may reset colorData)
          if (data.colorData && data.colorData.length === RES*RES*3) {
            colorData = new Float32Array(data.colorData);
            if (terrainMesh && state.viewMode !== 'heat') {
              updateMeshColors();
            }
          }
          hideLoading();
          toast('Terreno importado');
        });
      } catch (err) {
        toast('Error al leer el archivo: ' + err.message);
        hideLoading();
      }
    };
    reader.readAsText(input.files[0]);
  });
  input.click();
});

// ═══════════════════════════════════════════════════════
// PRESETS: SAVE / LOAD via API
// ═══════════════════════════════════════════════════════
// API_BASE: mismo origen (relativo) para evitar CORS
// Los presets se cargan como archivos estaticos (/uploads/ y /presets-list.json)
const IS_LOCAL = window.location.protocol === 'file:' || ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname);
const BASE_PATH = IS_LOCAL ? '' : '/3dlayerterraingenerator';
const API_BASE = window.location.origin + BASE_PATH;

const $presetName = $('#rightPresetName');
const $presetGrid = $('#rightPresetGrid');
const $savePresetBtn = $('#rightSavePresetBtn');

function getStateSnapshot() {
  return {
    _heightScale: HEIGHT_SCALE,
    layers: state.layers,
    maxHeight: state.maxHeight,
    sizeX: state.sizeX,
    sizeZ: state.sizeZ,
    modelScaleX: state.modelScaleX,
    modelScaleZ: state.modelScaleZ,
    smoothing: state.smoothing,
    brillo: state.brillo,
    contraste: state.contraste,
    resolution: state.resolution,
    tool: state.tool,
    brushSize: state.brushSize,
    brushFlow: state.brushFlow,
    brushStrength: state.brushStrength,
    viewMode: state.viewMode,
    activeTerrain: state.activeTerrain,
    paint3d: state.paint3d,
    baseColor: state.baseColor,
    paintColor: state.paintColor,
    paintAlpha: state.paintAlpha,
    showBase: state.showBase,
    activeLayer: state.activeLayer,
    layerConfig: layerConfig,
    materialColors: MATERIALS.map(m => m.color),
  };
}

function applyStateSnapshot(params) {
  if (!params) return;
  if (params.layers !== undefined) { state.layers = params.layers; $('#layers').value = params.layers; $('#layersVal').textContent = params.layers; }
  if (params.maxHeight !== undefined) {
    let v = params.maxHeight;
    // Rescale old presets (pre-HEIGHT_SCALE, v1 format) — old max=50 → new max=20
    // Rescale old presets: with _heightScale=2.5 → resize to new scale
    if (params._heightScale && params._heightScale !== HEIGHT_SCALE) {
      v = v * (params._heightScale / HEIGHT_SCALE);
    } else if (!params._heightScale && v > 12) {
      v = v / HEIGHT_SCALE;
    }
    state.maxHeight = Math.min(12, Math.max(0.1, v));
    $('#maxHeight').value = state.maxHeight;
    $('#heightVal').textContent = (state.maxHeight * HEIGHT_SCALE).toFixed(1);
  }
  if (params.sizeX !== undefined) { state.sizeX = params.sizeX; $('#sizeX').value = params.sizeX; $('#sizeXVal').textContent = params.sizeX.toFixed(1); }
  if (params.sizeZ !== undefined) { state.sizeZ = params.sizeZ; $('#sizeZ').value = params.sizeZ; $('#sizeZVal').textContent = params.sizeZ.toFixed(1); }
  if (params.modelScaleX !== undefined) { state.modelScaleX = params.modelScaleX; $('#modelScaleX').value = params.modelScaleX; $('#modelScaleXVal').textContent = params.modelScaleX.toFixed(2); }
  if (params.modelScaleZ !== undefined) { state.modelScaleZ = params.modelScaleZ; $('#modelScaleZ').value = params.modelScaleZ; $('#modelScaleZVal').textContent = params.modelScaleZ.toFixed(2); }
  if (params.smoothing !== undefined) { state.smoothing = params.smoothing; $('#smoothing').value = params.smoothing; $('#smoothVal').textContent = params.smoothing; }
  if (params.brillo !== undefined) { state.brillo = params.brillo; $('#brillo').value = params.brillo; $('#brilloVal').textContent = params.brillo.toFixed(2); }
  if (params.contraste !== undefined) { state.contraste = params.contraste; $('#contraste').value = params.contraste; $('#contrasteVal').textContent = params.contraste.toFixed(2); }
  if (params.resolution !== undefined && params.resolution !== RES) {
    state.resolution = params.resolution; $('#resolution').value = params.resolution; $('#resolutionVal').textContent = params.resolution;
    reallocateData(params.resolution);
  }
  if (params.tool !== undefined) { state.tool = params.tool; document.querySelectorAll('.paint-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === params.tool)); }
  if (params.brushSize !== undefined) { state.brushSize = params.brushSize; $('#brushSize').value = params.brushSize; $('#brushSizeVal').textContent = params.brushSize; }
  if (params.brushFlow !== undefined) { state.brushFlow = params.brushFlow; $('#brushFlow').value = params.brushFlow; $('#brushFlowVal').textContent = params.brushFlow; }
  if (params.brushStrength !== undefined) { state.brushStrength = params.brushStrength; $('#brushStrength').value = params.brushStrength; $('#brushStrengthVal').textContent = params.brushStrength.toFixed(2); }
  if (params.viewMode !== undefined && params.viewMode !== state.viewMode) { setViewMode(params.viewMode); }
  if (params.paint3d !== undefined) { state.paint3d = params.paint3d; }
  if (params.baseColor !== undefined) { state.baseColor = params.baseColor; $('#baseColorPicker').value = params.baseColor; }
  if (params.paintColor !== undefined) { state.paintColor = params.paintColor; $('#paintColorPicker').value = params.paintColor; }
  if (params.paintAlpha !== undefined) { state.paintAlpha = params.paintAlpha; $('#paintAlpha').value = params.paintAlpha; $('#paintAlphaVal').textContent = params.paintAlpha.toFixed(2); }
  if (params.showBase !== undefined) { state.showBase = params.showBase; var sb = $('#showBaseBtn'); if(sb) sb.innerHTML = state.showBase ? '🧱 Base visible' : '🧱 Base oculta'; }
  if (params.activeLayer !== undefined) { state.activeLayer = params.activeLayer; activeLayer = params.activeLayer; }
  // Restore layer config if present
  if (params.layerConfig) {
    layerConfig = {};
    for (const [k, v] of Object.entries(params.layerConfig)) {
      layerConfig[k] = { ...v };
    }
    buildLayerConfigUI();
  }
  // Restore material colors if present
  if (params.materialColors) {
    params.materialColors.forEach((color, i) => {
      if (MATERIALS[i]) MATERIALS[i].color = color;
    });
    $('#baseColorPicker').value = MATERIALS[0]?.color || '#c4a265';
    const wc = document.getElementById('waterColorPicker');
    if (wc) wc.value = MATERIALS[1]?.color || '#4a9eff';
    if (materialMap) syncColorDataFromMaterials();
  }
  // Sync number inputs after applying state
  document.querySelectorAll('.num-input').forEach(inp => {
    const range = inp.previousElementSibling;
    if (range && range.type === 'range') {
      const span = range.closest('.control-group')?.querySelector('.value');
      inp.value = span ? span.textContent : range.value;
    }
  });
}

// Compacta un Float32Array a JS Numbers con precisión controlada
// para evitar que JSON.stringify expanda los floats (0.1 → 0.10000000149011612)
function compactFloats(arr, decimals) {
  const factor = Math.pow(10, decimals);
  const result = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    result[i] = Math.round(arr[i] * factor) / factor;
  }
  return result;
}

async function savePreset() {
  if (!$presetName) { toast('Campo de nombre no disponible'); return; }
  if (!IS_LOCAL) { toast('Guardar preset solo disponible en modo local (localhost)'); return; }
  const name = $presetName.value.trim();
  if (!name) { toast('Escribí un nombre para el preset'); if ($presetName) $presetName.focus(); return; }
  const params = getStateSnapshot();
  const payload = {
    name: name,
    params: params,
    heightData: compactFloats(heightData, 6),
    colorData: colorData ? compactFloats(colorData, 4) : null,
    materialMap: materialMap ? Array.from(materialMap) : null,
    layerHeights: layerHeights ? layerHeights.map(lh => compactFloats(lh, 6)) : null,
    resolution: RES,
    thumbnail: null,
  };
  try {
    const res = await fetch(API_BASE + '/api/terrain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) { toast('Error al guardar preset'); return; }
    toast('Preset "' + name + '" guardado');
    if ($presetName) $presetName.value = '';
    loadPresets();
  } catch (e) {
    toast('Error de conexión al guardar preset');
    console.error(e);
  }
}

async function loadPresets() {
  // Guard left panel elements (may be null if removed from DOM)
  if (!$presetGrid) return;
  try {
    // In local mode, use the API endpoint which dynamically lists files
    // In remote mode, use the static presets-list.json
    const url = IS_LOCAL ? API_BASE + '/api/terrains' : API_BASE + '/presets-list.json';
    const res = await fetch(url);
    if (!res.ok) { $presetGrid.innerHTML = '<div style="font-size:10px;color:var(--text2);text-align:center;padding:12px 0;">Error al cargar presets</div>'; return; }
    const list = await res.json();
    if (!list.length) {
      $presetGrid.innerHTML = '<div style="font-size:10px;color:var(--text2);text-align:center;padding:12px 0;">No hay presets guardados</div>';
      return;
    }
    $presetGrid.innerHTML = '';
    for (const item of list) {
      const div = document.createElement('div'); div.className = 'preset-item';
      const dateStr = item.id ? item.id.slice(0, 10) : '';
      const d = document.createElement('span'); d.className = 'p-date'; d.textContent = dateStr;
      const n = document.createElement('span'); n.className = 'p-name'; n.textContent = item.name || item.id;
      const load = document.createElement('button'); load.className = 'p-load'; load.textContent = 'Cargar';
      load.addEventListener('click', e => { e.stopPropagation(); loadPreset(item.id); });
      const update = document.createElement('button'); update.className = 'p-update'; update.textContent = 'Actualizar';
      update.addEventListener('click', e => { e.stopPropagation(); updatePreset(item.id); });
      const del = document.createElement('button'); del.className = 'p-del'; del.textContent = '✕';
      del.addEventListener('click', e => { e.stopPropagation(); deletePreset(item.id); });
      div.appendChild(d); div.appendChild(n); div.appendChild(load); div.appendChild(update); div.appendChild(del);
      if (item.id === window._activePresetId) {
        const badge = document.createElement('span'); badge.className = 'preset-active-badge'; badge.textContent = '✓ ACTIVO';
        div.appendChild(badge);
      }
      $presetGrid.appendChild(div);
    }
  } catch (e) {
    $presetGrid.innerHTML = '<div style="font-size:10px;color:var(--text2);text-align:center;padding:12px 0;">Error de conexión</div>';
    console.error(e);
  }
}

async function loadPreset(id) {
  // Si el id no termina en .json, agregarlo (backward compat)
  const fileName = id.endsWith('.json') ? id : id + '.json';
  setLoading('Cargando preset...');
  try {
    const res = await fetch(API_BASE + '/uploads/' + fileName);
    if (!res.ok) { toast('Error al cargar preset'); hideLoading(); return; }
    const data = await res.json();
    // Support resolution at top level (new format) or inside params (old format)
    const presetRes = data.resolution || (data.params && data.params.resolution);
    if (data.heightData && presetRes) {
      if (presetRes !== RES) {
        reallocateData(presetRes);
      }
      // Ensure slider display matches resolution
      if (data.params && data.params.resolution) {
        $('#resolution').value = data.params.resolution;
        $('#resolutionVal').textContent = data.params.resolution;
      }
      heightData.set(new Float32Array(data.heightData));
        baseHeightData.set(heightData);
        // Restore layerHeights from saved preset (new format)
        if (data.layerHeights && Array.isArray(data.layerHeights)) {
          layerHeights = data.layerHeights.map(arr => new Float32Array(arr));
          computeTotalHeight();
          heightData.set(totalHeightData);
        } else {
          // Legacy preset: distribute into layers
          initLayerHeights(state.layers);
        }
      }
    if (data.colorData) {
      colorData = new Float32Array(data.colorData);
    }
    if (data.materialMap) {
      materialMap = new Uint8Array(data.materialMap);
    }
    if (data.params) applyStateSnapshot(data.params);
    needsRegen = true;
    drawCanvas();
    requestAnimationFrame(() => {
      rebuildTerrain();
      // Restore saved colors AFTER rebuild (rebuild may reset colorData)
      // Skip if materialMap was loaded - colorData is derived from it
      if (data.colorData && !data.materialMap && data.colorData.length === RES*RES*3) {
        colorData = new Float32Array(data.colorData);
        if (terrainMesh && state.viewMode !== 'heat') {
          updateMeshColors();
        }
      }
      // If materialMap was loaded, sync colors from it
      if (data.materialMap && materialMap) {
        syncColorDataFromMaterials();
      }
      hideLoading();
    });
    // Store active preset info for badge display
    window._activePresetId = id;
    window._activePresetName = data.name || id;
    updateActivePresetBtnState();
    // Update URL for sharing
    const url = new URL(window.location);
    url.searchParams.set('preset', id);
    url.searchParams.delete('terrain');
    history.replaceState(null, '', url);
    // Re-render presets list to show active badge
    loadPresets();
    // Re-render terrain library grid
    buildTerrainLibrary();
    // Show model name in viewport
    const nameHint = document.getElementById('modelNameHint');
    if (nameHint) nameHint.textContent = data.name || id;
    toast('Preset "' + (data.name || id) + '" cargado');
  } catch (e) {
    toast('Error de conexión al cargar preset');
    hideLoading();
    console.error(e);
  }
}

async function deletePreset(id) {
  if (!IS_LOCAL) { toast('Eliminar preset solo disponible en modo local'); return; }
  try {
    const res = await fetch(API_BASE + '/api/terrain/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!res.ok) { toast('Error al eliminar preset'); return; }
    toast('Preset eliminado');
    loadPresets();
  } catch (e) {
    toast('Error de conexión al eliminar');
    console.error(e);
  }
}

async function updatePreset(id) {
  if (!IS_LOCAL) { toast('Actualizar preset solo disponible en modo local (localhost)'); return; }
  if (!id) { toast('No hay preset activo para actualizar'); return; }
  const toastMsg = toast('Actualizando preset...');
  try {
    const params = getStateSnapshot();
    const payload = {
      params: params,
      heightData: compactFloats(heightData, 6),
      colorData: colorData ? compactFloats(colorData, 4) : null,
      materialMap: materialMap ? Array.from(materialMap) : null,
      layerHeights: layerHeights ? layerHeights.map(lh => compactFloats(lh, 6)) : null,
      resolution: RES,
      thumbnail: null,
    };
    const res = await fetch(API_BASE + '/api/terrain/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) { toast('Error al actualizar preset'); return; }
    toast('Preset actualizado');
    loadPresets();
  } catch (e) {
    toast('Error de conexión al actualizar preset');
    console.error(e);
  }
}

// Enable/disable the Actualizar button based on whether a preset is active
function updateActivePresetBtnState() {
  if (rightUpdatePresetBtn) {
    rightUpdatePresetBtn.disabled = !window._activePresetId;
  }
}
// Check on load
setTimeout(updateActivePresetBtnState, 100);

if ($savePresetBtn) $savePresetBtn.addEventListener('click', savePreset);
if ($presetName) $presetName.addEventListener('keydown', e => { if (e.key === 'Enter') savePreset(); });
if (rightUpdatePresetBtn) {
  rightUpdatePresetBtn.addEventListener('click', () => {
    updatePreset(window._activePresetId);
  });
}

// Init paint mode display
updatePaintModeDisplay();

// Load presets list on boot
setTimeout(() => loadPresets(), 500);

// Check URL for ?preset=XXX or ?terrain=XXX
const urlParams = new URLSearchParams(window.location.search);
const hash = window.location.hash.replace('#', '');
const presetFromUrl = urlParams.get('preset') || urlParams.get('terrain') || hash;
if (presetFromUrl) {
  // If it's a terrain library key, load that
  if (TERRAIN_LIB[presetFromUrl]) {
    loadTerrain(presetFromUrl);
  } else {
    // Otherwise treat as a saved preset ID
    loadPreset(presetFromUrl);
    // Build terrain library (loadPreset doesn't do this automatically)
    buildTerrainLibrary();
  }
} else {
  // Load sannjuanv2_limpia4 preset by default
  loadPreset('1782427106099-sannjuanv2_limpia4.json');
  // Build terrain library (loadPreset doesn't do this automatically)
  buildTerrainLibrary();
}

initThree();
