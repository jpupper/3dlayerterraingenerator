import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

// ═══════════════════════════════════════════════════════
// TERRAIN LIBRARY
// ═══════════════════════════════════════════════════════
const TERRAIN_LIB = {
  'san-juan': { name:'San Juan', tags:'Relieve completo · fondo negro puro', thumb:'maqueta/heightmap_final.png', depthUrl:'maqueta/heightmap_final.png', layers:20, maxHeight:4.0, smoothing:3 },
  'san-juan-detailed': { name:'San Juan HD', tags:'Relieve detallado', thumb:'maqueta/heightmap_final.png', depthUrl:'maqueta/heightmap_final.png', layers:25, maxHeight:5.0, smoothing:2 },
  'san-juan-topo': { name:'San Juan Topo', tags:'Desde topográfico · fondo negro', thumb:'maqueta/heightmap_topo.png', depthUrl:'maqueta/heightmap_topo.png', layers:18, maxHeight:4.5, smoothing:2 },
  'san-juan-suave': { name:'San Juan Suave', tags:'Relieve suavizado', thumb:'maqueta/heightmap_final.png', depthUrl:'maqueta/heightmap_final.png', layers:15, maxHeight:3.0, smoothing:4 },
  'san-juan-color': { name:'San Juan Color', tags:'Mapa de colores · relieve real 0-6.8m', thumb:'maqueta/heightmapfinalfinal.png', depthUrl:'maqueta/heightmapfinalfinal.png', layers:30, maxHeight:7.0, smoothing:1, isColorMap:true },
  'default-hill': { name:'Colina Default', tags:'Terreno genérico', thumb:null, depthUrl:null, layers:15, maxHeight:3.0, smoothing:2, isDefault:true },
};

// ═══════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════
let RES = 128;
let heightData = new Float32Array(RES * RES);
let baseHeightData = new Float32Array(RES * RES);
let needsRegen = true;
let rebuildPending = false;

// Last known mouse position for frame-driven paint raycasting
let lastMouseX = 0, lastMouseY = 0;

const state = {
  layers:15, maxHeight:3.0, smoothing:2,
  brillo:0, contraste:1, resolution:128,
  sizeX:130, sizeZ:130,
  tool:'add', brushSize:20, brushFlow:30, brushStrength:0.5,
  viewMode:'solid', activeTerrain:'default-hill', paint3d:false,
  baseColor:'#c4a265', paintColor:'#e55336', paintAlpha:0.5,
  showBase:true,
};

let vertexColors = null;
let colorData = null;

let threeReady = false;
let terrainMesh = null;
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
    loadingOverlay.classList.add('show');
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

// Override buildTerrainLibrary to also populate right panel
const _origBuildLibrary = buildTerrainLibrary;
buildTerrainLibrary = function() {
  _origBuildLibrary();
  // Also populate right panel
  if (rightTerrainGrid) {
    rightTerrainGrid.innerHTML = '';
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
      rightTerrainGrid.appendChild(card);
    }
  }
};

// Override loadPresets to also populate right panel
const _origLoadPresets = loadPresets;
loadPresets = async function() {
  await _origLoadPresets();
  // Also populate right panel
  try {
    const res = await fetch(API_BASE + '/api/terrains');
    if (!res.ok) { if (rightPresetGrid) rightPresetGrid.innerHTML = '<div style="font-size:10px;color:var(--text2);text-align:center;padding:12px 0;">Error al cargar presets</div>'; return; }
    const list = await res.json();
    if (!rightPresetGrid) return;
    if (!list.length) {
      rightPresetGrid.innerHTML = '<div style="font-size:10px;color:var(--text2);text-align:center;padding:12px 0;">No hay presets guardados</div>';
      return;
    }
    rightPresetGrid.innerHTML = '';
    for (const item of list) {
      const div = document.createElement('div'); div.className = 'preset-item';
      const dateStr = item.id ? item.id.slice(0, 10) : '';
      const d = document.createElement('span'); d.className = 'p-date'; d.textContent = dateStr;
      const n = document.createElement('span'); n.className = 'p-name'; n.textContent = item.name || item.id;
      const load = document.createElement('button'); load.className = 'p-load'; load.textContent = 'Cargar';
      load.addEventListener('click', e => { e.stopPropagation(); loadPreset(item.id); });
      const del = document.createElement('button'); del.className = 'p-del'; del.textContent = '✕';
      del.addEventListener('click', e => { e.stopPropagation(); deletePreset(item.id); });
      div.appendChild(d); div.appendChild(n); div.appendChild(load); div.appendChild(del);
      rightPresetGrid.appendChild(div);
    }
  } catch (e) {
    if (rightPresetGrid) rightPresetGrid.innerHTML = '<div style="font-size:10px;color:var(--text2);text-align:center;padding:12px 0;">Error de conexión</div>';
    console.error(e);
  }
};

// Right panel save preset — with spinner
if (rightSavePresetBtn) {
  rightSavePresetBtn.addEventListener('click', () => {
    const name = rightPresetName ? rightPresetName.value.trim() : '';
    if (!name) { toast('Escribí un nombre para el preset'); if (rightPresetName) rightPresetName.focus(); return; }
    const oldText = rightSavePresetBtn.textContent;
    rightSavePresetBtn.innerHTML = '⏳'; // spinner indicator
    rightSavePresetBtn.disabled = true;
    const params = getStateSnapshot();
    const payload = {
      name: name,
      params: params,
      heightData: Array.from(heightData),
      colorData: colorData ? Array.from(colorData) : null,
      resolution: RES,
      thumbnail: null,
    };
    (async () => {
      try {
        const res = await fetch(API_BASE + '/api/terrain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        rightSavePresetBtn.innerHTML = oldText;
        rightSavePresetBtn.disabled = false;
        if (!res.ok) { toast('Error al guardar preset'); return; }
        toast('Preset "' + name + '" guardado');
        if (rightPresetName) rightPresetName.value = '';
        loadPresets();
      } catch (e) {
        rightSavePresetBtn.innerHTML = oldText;
        rightSavePresetBtn.disabled = false;
        toast('Error de conexión al guardar preset');
        console.error(e);
      }
    })();
  });
}
if (rightPresetName) {
  rightPresetName.addEventListener('keydown', e => { if (e.key === 'Enter' && rightSavePresetBtn) rightSavePresetBtn.click(); });
}
const terrainGrid = $('#terrainGrid');
function buildTerrainLibrary() {
  if (!terrainGrid) return;
  terrainGrid.innerHTML = '';
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
    if (terrainGrid) terrainGrid.appendChild(card);
  }
}

function loadTerrain(id) {
  const t = TERRAIN_LIB[id];
  if (!t) return;
  state.activeTerrain = id;
  state.layers = t.layers; state.maxHeight = t.maxHeight;
  state.smoothing = t.smoothing;
  state.brillo = 0; state.contraste = 1;

  $('#layers').value = t.layers; $('#layersVal').textContent = t.layers;
  $('#maxHeight').value = t.maxHeight; $('#heightVal').textContent = t.maxHeight.toFixed(1);
  $('#smoothing').value = t.smoothing; $('#smoothVal').textContent = t.smoothing;
  $('#brillo').value = 0; $('#brilloVal').textContent = '0.00';
  $('#contraste').value = 1; $('#contrasteVal').textContent = '1.00';

  buildTerrainLibrary();

  if (t.isDefault) { genDefaultTerrain(); return; }

  loadingOverlay.classList.add('show');
  if (t.depthUrl) {
    const img = new Image();
    img.onload = () => {
      if (t.isColorMap) {
        loadColorHeightmap(img, heightData);
      } else {
        loadImageToData(img, heightData);
      }
      loadingOverlay.classList.remove('show');
      needsRegen = true;
      drawCanvas();
      if (threeReady) rebuildTerrain();
      toast('Terreno "' + t.name + '" cargado');
    };
    img.onerror = () => { loadingOverlay.classList.remove('show'); toast(`Error cargando ${t.name}`); };
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
  needsRegen = true; drawCanvas();
  if (threeReady) rebuildTerrain();
  toast('Default terrain loaded');
}

function reallocateData(newRes) {
  if (newRes === RES) return;
  const oldRes = RES;
  const oldData = new Float32Array(heightData);
  RES = newRes;
  heightData = new Float32Array(RES * RES);
  baseHeightData = new Float32Array(RES * RES);
  // Resample old data into new resolution
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
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x+dx, ny = y+dy;
        if (nx>=0 && nx<RES && ny>=0 && ny<RES) { s += heightData[ny*RES+nx]; n++; }
      }
      tmp[y*RES+x] = s / n;
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
  // Pre-compute max height within brush area for smooth tool
  let maxH = 0;
  if (state.tool === 'smooth') {
    for (let dy = -ceilRad; dy <= ceilRad; dy++) {
      for (let dx = -ceilRad; dx <= ceilRad; dx++) {
        const nx = hx+dx, ny = hy+dy;
        if (nx>=0 && nx<RES && ny>=0 && ny<RES) {
          if (Math.sqrt(dx*dx+dy*dy) <= radius) {
            maxH = Math.max(maxH, heightData[ny*RES+nx]);
          }
        }
      }
    }
  }
  for (let dy = -ceilRad; dy <= ceilRad; dy++) for (let dx = -ceilRad; dx <= ceilRad; dx++) {
    const px = hx+dx, py = hy+dy;
    if (px<0 || px>=RES || py<0 || py>=RES) continue;
    const dist = Math.sqrt(dx*dx+dy*dy);
    if (dist > radius) continue;
    const f = 1 - dist/radius;
    const cur = heightData[py*RES+px];
    if (state.tool === 'add') heightData[py*RES+px] = Math.min(1, cur + f*flow*(0.05 + Math.abs(state.brushStrength)*0.20));
    else if (state.tool === 'sub') heightData[py*RES+px] = Math.max(0, cur - f*flow*(0.05 + Math.abs(state.brushStrength)*0.20));
    else if (state.tool === 'smooth') {
      // Raise terrain toward the highest layer within the brush area
      if (cur < maxH) {
        const amount = f * flow * (0.05 + Math.abs(state.brushStrength) * 0.20);
        heightData[py*RES+px] = Math.min(maxH, cur + amount);
      }
    }
  }
  needsRegen = true;
}

paintOverlay.addEventListener('mousedown', e => { isPainting = true; const p=getCoords(e); paintAt(p.x,p.y); drawCanvas(); pCtx.clearRect(0,0,SZ,SZ); });
window.addEventListener('mousemove', e => { if (!isPainting) return; const p=getCoords(e); paintAt(p.x,p.y); drawCanvas(); pCtx.clearRect(0,0,SZ,SZ); });
window.addEventListener('mouseup', () => { if (isPainting) { isPainting=false; if (threeReady) rebuildTerrain(); }});
paintOverlay.addEventListener('mouseleave', () => { if (isPainting) { isPainting=false; if (threeReady) rebuildTerrain(); }});

paintOverlay.addEventListener('touchstart', e => { e.preventDefault(); isPainting=true; const p=getCoords(e.touches[0]); paintAt(p.x,p.y); drawCanvas(); pCtx.clearRect(0,0,SZ,SZ); }, {passive:false});
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
  loadingOverlay.classList.add('show');
  const reader = new FileReader();
  reader.onerror = () => { loadingOverlay.classList.remove('show'); toast('Error al leer el archivo'); };
  reader.onload = e => {
    const img = new Image();
    img.onerror = () => { loadingOverlay.classList.remove('show'); toast('Error al decodificar la imagen'); };
    img.onload = () => {
      loadImageToData(img, heightData);
      baseHeightData.set(heightData);
      state.activeTerrain = 'custom';
      buildTerrainLibrary();
      drawCanvas();
      needsRegen = true;
      hz.classList.add('has-image');
      hz.querySelector('.icon').textContent = '✅';
      hz.querySelector('.label').textContent = file.name;
      if (threeReady) { requestAnimationFrame(() => { rebuildTerrain(); loadingOverlay.classList.remove('show'); }); } else { loadingOverlay.classList.remove('show'); }
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
  const shMax = Math.max(state.sizeX, state.sizeZ, state.maxHeight) * 1.5;
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
  const labelScale = Math.max(0.3, terrainSize * 0.008);
  const tickLen = Math.max(0.12, terrainSize * 0.005);

  // --- Grid lines ---
  const gridMat = new THREE.LineBasicMaterial({ color: 0x4a6fa5, transparent: true, opacity: 0.12 });
  const gridStep = 0.5;
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
  // Width label (X axis)
  const lblW = makeTextSprite(sizeX.toFixed(1) + 'cm', '#8caadf', labelScale);
  lblW.position.set(0, 0.05, -hz - 0.6);
  rulerGroup.add(lblW);
  // Label arrow line
  const arrMat1 = new THREE.LineBasicMaterial({ color: 0x6a8fcf, transparent: true, opacity: 0.4 });
  const arr1 = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-hx, 0.02, -hz - 0.3), new THREE.Vector3(hx, 0.02, -hz - 0.3)
  ]), arrMat1);
  rulerGroup.add(arr1);

  // Depth label (Z axis)
  const lblD = makeTextSprite(sizeZ.toFixed(1) + 'cm', '#8caadf', labelScale);
  lblD.position.set(hx + 0.6, 0.05, 0);
  rulerGroup.add(lblD);
  const arrMat2 = new THREE.LineBasicMaterial({ color: 0x6a8fcf, transparent: true, opacity: 0.4 });
  const arr2 = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(hx + 0.3, 0.02, -hz), new THREE.Vector3(hx + 0.3, 0.02, hz)
  ]), arrMat2);
  rulerGroup.add(arr2);

  // Height label (Y axis) - vertical line near front-left corner
  const maxH = state.maxHeight;
  const arrMat3 = new THREE.LineBasicMaterial({ color: 0xcf8a6f, transparent: true, opacity: 0.4 });
  const arr3 = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-hx - 0.3, 0, -hz), new THREE.Vector3(-hx - 0.3, maxH, -hz)
  ]), arrMat3);
  rulerGroup.add(arr3);
  // Top tick
  const tickH = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-hx - 0.45, maxH, -hz), new THREE.Vector3(-hx - 0.15, maxH, -hz)
  ]), arrMat3);
  rulerGroup.add(tickH);
  const lblH = makeTextSprite(maxH.toFixed(1) + 'cm', '#cf8a6f', labelScale);
  lblH.position.set(-hx - 0.7, maxH * 0.5, -hz);
  rulerGroup.add(lblH);

  rulerGroup.position.y = 0.01;
  scene.add(rulerGroup);
}

function updateDimOverlay() {
  const w = state.sizeX.toFixed(1), d = state.sizeZ.toFixed(1);
  const maxH = state.maxHeight.toFixed(1);
  const el = $('#dimOverlay');
  if (el) el.textContent = `📐 ${w}cm × ${d}cm · Altura máx ${maxH}cm · Capas ${state.layers}`;
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
      const gx = Math.round(((pt.x / sX) + 0.5) * (RES-1));
      const gz = Math.round(((pt.z / sZ) + 0.5) * (RES-1));
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
function rebuildTerrain() {
  if (!threeReady) return;

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

  // 4. Quantize
  const N = state.layers;
  const quantized = new Float32Array(RES*RES);
  for (let i = 0; i < RES*RES; i++) quantized[i] = Math.floor(baseHeightData[i] * N) / N;

  // Initialize colorData if needed
  if (!colorData || colorData.length !== RES*RES*3) {
    colorData = new Float32Array(RES*RES*3);
    const base = new THREE.Color(state.baseColor || '#c4a265');
    for (let i = 0; i < RES*RES; i++) { colorData[i*3]=base.r; colorData[i*3+1]=base.g; colorData[i*3+2]=base.b; }
  }

  const scaleX = state.sizeX, scaleZ = state.sizeZ, hScale = state.maxHeight;
  const positions = [], indices = [], colors = [];

  const cr = t => {
    const c = new THREE.Color();
    if (state.viewMode === 'heat') {
      if (t<0.25) c.setHSL(0.65-t*1.0, 0.9, 0.3+t*0.5);
      else if (t<0.5) c.setHSL(0.50-(t-0.25)*0.8, 0.85, 0.45+(t-0.25)*0.3);
      else if (t<0.75) c.setHSL(0.25-(t-0.5)*0.6, 0.8, 0.55+(t-0.5)*0.25);
      else c.setHSL(0.08-(t-0.75)*0.2, 0.9, 0.6+(t-0.75)*0.3);
    } else {
      // Use vertex colors (painted or base color)
      const idx = (Math.floor(t * (RES*RES-1)))*3; // fallback - will be overwritten below
    }
    return c;
  };

  for (let z = 0; z < RES; z++) for (let x = 0; x < RES; x++) {
    const h = quantized[z*RES+x];
    positions.push((x/(RES-1)-0.5)*scaleX, h*hScale, (z/(RES-1)-0.5)*scaleZ);
    if (state.viewMode === 'heat') {
      const col = cr(baseHeightData[z*RES+x]); colors.push(col.r, col.g, col.b);
    } else {
      const idx = (z*RES+x)*3;
      colors.push(colorData[idx], colorData[idx+1], colorData[idx+2]);
    }
  }

  for (let z = 0; z < RES-1; z++) for (let x = 0; x < RES-1; x++) {
    const a=z*RES+x, b=z*RES+x+1, c=(z+1)*RES+x, d=(z+1)*RES+x+1;
    // Skip quads where all corners are flat (height = 0) — no geometry for black areas
    if (!state.showBase && quantized[a] === 0 && quantized[b] === 0 && quantized[c] === 0 && quantized[d] === 0) continue;
    indices.push(a,b,c); indices.push(b,d,c);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions,3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors,3));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  if (terrainMesh) { scene.remove(terrainMesh); terrainMesh.geometry.dispose(); terrainMesh.material.dispose(); }

  let mat;
  if (state.viewMode === 'wire') mat = new THREE.MeshStandardMaterial({color:0x8caa80, wireframe:true, roughness:0.7, metalness:0.1});
  else mat = new THREE.MeshStandardMaterial({vertexColors:true, roughness:0.6, metalness:0.05, side:THREE.DoubleSide});

  terrainMesh = new THREE.Mesh(geo, mat);
  terrainMesh.castShadow = true; terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);
  needsRegen = false;
  loadingOverlay.classList.remove('show');

  // Update ruler position and dimension overlay
  if (rulerGroup) { scene.remove(rulerGroup); rulerGroup.traverse(c => { if (c.geometry) c.geometry.dispose(); }); rulerGroup = null; }
  buildRuler(state.sizeX, state.sizeZ);
  updateDimOverlay();

  // Update shadow camera to fit terrain
  const dl = scene.children.find(c => c.isDirectionalLight && c.shadow);
  if (dl) {
    const shMax = Math.max(state.sizeX, state.sizeZ, state.maxHeight) * 1.5;
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
  loadingOverlay.classList.add('show');
  requestAnimationFrame(() => rebuildTerrain());
}
$('#viewMode3d').addEventListener('click', () => setViewMode('solid'));
$('#viewModeHeat').addEventListener('click', () => setViewMode('heat'));
$('#viewModeWire').addEventListener('click', () => setViewMode('wire'));

// ═══════════════════════════════════════════════════════
// 3D RAYCAST PAINTING
// ═══════════════════════════════════════════════════════
let is3dPainting = false;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let paint3dBtn = $('#paint3dBtn');

function get3dGridPos(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  if (!terrainMesh) return null;
  const intersects = raycaster.intersectObject(terrainMesh);
  if (intersects.length === 0) return null;
  const pt = intersects[0].point;
  const sX = state.sizeX, sZ = state.sizeZ;
  const gx = Math.round(((pt.x / sX) + 0.5) * (RES-1));
  const gz = Math.round(((pt.z / sZ) + 0.5) * (RES-1));
  if (gx < 0 || gx >= RES || gz < 0 || gz >= RES) return null;
  return {x: gx, z: gz};
}

function paint3dAt(gx, gz) {
  const size = state.brushSize, flow = state.brushFlow / 100;
  const radius = size / 2;
  const ceilRad = Math.ceil(radius);
  // Pre-compute max height within brush area for smooth tool
  let maxH = 0;
  if (state.tool === 'smooth') {
    for (let dz = -ceilRad; dz <= ceilRad; dz++) {
      for (let dx = -ceilRad; dx <= ceilRad; dx++) {
        const nx = gx+dx, nz = gz+dz;
        if (nx>=0 && nx<RES && nz>=0 && nz<RES) {
          if (Math.sqrt(dx*dx+dz*dz) <= radius) {
            maxH = Math.max(maxH, heightData[nz*RES+nx]);
          }
        }
      }
    }
  }
  for (let dz = -ceilRad; dz <= ceilRad; dz++) for (let dx = -ceilRad; dx <= ceilRad; dx++) {
    const px = gx+dx, pz = gz+dz;
    if (px<0 || px>=RES || pz<0 || pz>=RES) continue;
    const dist = Math.sqrt(dx*dx+dz*dz);
    if (dist > radius) continue;
    const f = 1 - dist/radius;
    const cur = heightData[pz*RES+px];
    if (state.tool === 'smooth') {
      // Raise terrain toward the highest layer within the brush area
      const rate = Math.abs(state.brushStrength);
      const amount = f * flow * (0.05 + rate * 0.20);
      if (cur < maxH) heightData[pz*RES+px] = Math.min(maxH, cur + amount);
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
      heightData[pz*RES+px] = Math.max(0, Math.min(1, cur + dir * amount));
    }
  }
  needsRegen = true;
}

function updateMeshVertices(smooth, updateNormals) {
  if (!terrainMesh) return;
  const hScale = state.maxHeight, N = state.layers;
  let src = heightData;
  if (smooth && state.smoothing > 0) {
    src = new Float32Array(heightData);
    const tmp = new Float32Array(RES*RES);
    for (let p = 0; p < state.smoothing; p++) {
      for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x+dx, ny = y+dy;
          if (nx>=0 && nx<RES && ny>=0 && ny<RES) { s += src[ny*RES+nx]; n++; }
        }
        tmp[y*RES+x] = s / n;
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
    const h = Math.floor(baseHeightData[z*RES+x] * N) / N;
    arr[(z*RES+x)*3+1] = h * hScale;
  }
  posAttr.needsUpdate = true;
  // Only recompute normals when explicitly requested (avoid GPU issues during paint loop)
  if (updateNormals !== false) {
    terrainMesh.geometry.computeVertexNormals();
  }
}

paint3dBtn.addEventListener('click', () => {
  state.paint3d = !state.paint3d;
  paint3dBtn.style.borderColor = state.paint3d ? 'var(--accent)' : 'var(--border)';
  paint3dBtn.style.background = state.paint3d ? 'rgba(229,83,54,0.15)' : '';
  toast(state.paint3d ? '3D Paint activado - click sobre el terreno' : '3D Paint desactivado');
});

const showBaseBtn = document.getElementById('showBaseBtn');
showBaseBtn.addEventListener('click', () => {
  state.showBase = !state.showBase;
  showBaseBtn.innerHTML = state.showBase ? '🧱 Base visible' : '🧱 Base oculta';
  scheduleRebuild();
});

function setup3dPaintEvents() {
  renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
  renderer.domElement.addEventListener('mousedown', e => {
    if (!state.paint3d || !terrainMesh || e.button !== 0) return;
    const p = get3dGridPos(e);
    if (!p) return;
    controls.enabled = false;
    is3dPainting = true;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
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
    if (!state.paint3d) { brushRing.visible = false; return; }
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
    if (!brushRing || !terrainMesh) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const py = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(new THREE.Vector2(px, py), camera);
    const hits = raycaster.intersectObject(terrainMesh);
    if (hits.length > 0) {
      const pt = hits[0].point;
      const ringScale = (state.sizeX + state.sizeZ) / 2;
      const r = (state.brushSize / RES) * ringScale * 0.5;
      brushRing.position.set(pt.x, pt.y + 0.02, pt.z);
      brushRing.scale.set(r/0.2, r/0.2, 1);
      brushRing.visible = state.paint3d;
    } else {
      brushRing.visible = false;
    }
  }
}

// ═══════════════════════════════════════════════════════
// LAYER OUTLINE LINES (for GLB export)
// ═══════════════════════════════════════════════════════
function generateLayerOutlineLines() {
  const N = state.layers;
  const hScale = state.maxHeight;
  const scaleX = state.sizeX;
  const scaleZ = state.sizeZ;
  const pts = [];

  // Horizontal edges (between x and x+1)
  for (let z = 0; z < RES; z++) {
    for (let x = 0; x < RES - 1; x++) {
      const h1 = Math.floor(baseHeightData[z * RES + x] * N) / N;
      const h2 = Math.floor(baseHeightData[z * RES + (x + 1)] * N) / N;
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
      const h1 = Math.floor(baseHeightData[z * RES + x] * N) / N;
      const h2 = Math.floor(baseHeightData[(z + 1) * RES + x] * N) / N;
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
  const parts = [];
  for (let l=1; l<=N; l++) {
    const th = l/N; const segs = [];
    for (let z=0;z<RES-1;z++) for (let x=0;x<RES-1;x++) {
      const v00=baseHeightData[z*RES+x], v10=baseHeightData[z*RES+(x+1)], v01=baseHeightData[(z+1)*RES+x], v11=baseHeightData[(z+1)*RES+(x+1)];
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
    const cl = `hsl(${200-(l/N)*200},70%,50%)`;
    parts.push(`<path d="${d}" fill="none" stroke="${cl}" stroke-width="1.5" opacity="0.7"/><text x="20" y="${30+l*20}" font-size="10" fill="${cl}" font-family="sans-serif">Capa ${l}</text>`);
  }
  if (parts.length===0) { toast('No hay suficientes capas'); return; }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#0e0e14"/>${parts.join('\\n')}</svg>`;
  const b = new Blob([svg], {type:'image/svg+xml'}); const u=URL.createObjectURL(b);
  const a = document.createElement('a'); a.href=u; a.download=`terrain_layers_${N}.svg`; a.click(); URL.revokeObjectURL(u);
  toast(`SVG con ${N} capas exportado`);
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
  loadingOverlay.classList.add('show');

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
    loadingOverlay.classList.remove('show');
    callback(glb);
  }, e => { loadingOverlay.classList.remove('show'); toast('Error exportando GLB'); }, opt);
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

window.addEventListener('message', event => {
  if (event.data === 'glb_viewer_ready' && pendingGlbData) {
    event.source.postMessage({ type: 'glb_data', data: pendingGlbData }, event.origin);
    pendingGlbData = null;
  }
});

$('#viewGlbBtn').addEventListener('click', () => {
  exportGlbThen(glb => {
    pendingGlbData = glb;
    toast('Abriendo visor GLB...');
    window.open('glbviewer.html', '_blank');
  });
});

// ═══════════════════════════════════════════════════════
// UI BINDINGS
// ═══════════════════════════════════════════════════════
document.querySelectorAll('.paint-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.paint-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.tool = btn.dataset.tool;
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
}

const $layers = $('#layers'), $maxH = $('#maxHeight'), $smooth = $('#smoothing');
const $brillo = $('#brillo'), $constraste = $('#contraste');
const $brushSize = $('#brushSize'), $brushFlow = $('#brushFlow'), $brushStrength = $('#brushStrength'), $paintAlpha = $('#paintAlpha');
const $resolution = $('#resolution');
const $sizeX = $('#sizeX'), $sizeZ = $('#sizeZ');

$layers.addEventListener('input', () => { state.layers = parseInt($layers.value); $('#layersVal').textContent = state.layers; scheduleRebuild(); });
$maxH.addEventListener('input', () => { state.maxHeight = parseFloat($maxH.value); $('#heightVal').textContent = state.maxHeight.toFixed(1); scheduleRebuild(); });
$sizeX.addEventListener('input', () => { state.sizeX = parseFloat($sizeX.value); $('#sizeXVal').textContent = state.sizeX.toFixed(1); scheduleRebuild(); });
$sizeZ.addEventListener('input', () => { state.sizeZ = parseFloat($sizeZ.value); $('#sizeZVal').textContent = state.sizeZ.toFixed(1); scheduleRebuild(); });
$smooth.addEventListener('input', () => { state.smoothing = parseInt($smooth.value); $('#smoothVal').textContent = state.smoothing; scheduleRebuild(); });
$brillo.addEventListener('input', () => { state.brillo = parseFloat($brillo.value); $('#brilloVal').textContent = state.brillo.toFixed(2); scheduleRebuild(); });
$constraste.addEventListener('input', () => { state.contraste = parseFloat($constraste.value); $('#contrasteVal').textContent = state.contraste.toFixed(2); scheduleRebuild(); });

$resolution.addEventListener('input', () => {
  state.resolution = parseInt($resolution.value);
  $('#resolutionVal').textContent = state.resolution;
  loadingOverlay.classList.add('show');
  reallocateData(state.resolution);
  drawCanvas();
  if (threeReady) requestAnimationFrame(() => { rebuildTerrain(); loadingOverlay.classList.remove('show'); });
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
  // Re-init colorData with new base color
  const base = new THREE.Color(state.baseColor);
  for (let i = 0; i < RES*RES; i++) { colorData[i*3]=base.r; colorData[i*3+1]=base.g; colorData[i*3+2]=base.b; }
  scheduleRebuild();
});
$paintColor.addEventListener('input', () => {
  state.paintColor = $paintColor.value;
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

$('#applyBtn').addEventListener('click', () => { loadingOverlay.classList.add('show'); requestAnimationFrame(() => rebuildTerrain()); toast('Terreno actualizado'); });
$('#resetHeightBtn').addEventListener('click', () => { heightData.fill(0); baseHeightData.fill(0); needsRegen = true; drawCanvas(); if (threeReady) rebuildTerrain(); toast('Heightmap limpiado'); });

// ═══════════════════════════════════════════════════════
// EXPORT / IMPORT TERRAIN AS JSON
// ═══════════════════════════════════════════════════════
$('#exportTerrainBtn').addEventListener('click', () => {
  const data = {
    version: 2,
    params: getStateSnapshot(),
    heightData: Array.from(heightData),
    colorData: colorData ? Array.from(colorData) : null,
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
    loadingOverlay.classList.add('show');
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data.heightData || !data.resolution) {
          toast('Archivo JSON inválido: falta heightData o resolution');
          loadingOverlay.classList.remove('show');
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
        heightData = new Float32Array(data.heightData);
        baseHeightData.set(heightData);
        if (data.colorData && data.colorData.length === RES*RES*3) {
          colorData = new Float32Array(data.colorData);
        }
        if (data.params) {
          if (brushStrength !== undefined) data.params.brushStrength = brushStrength;
          applyStateSnapshot(data.params);
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
          loadingOverlay.classList.remove('show');
          toast('Terreno importado');
        });
      } catch (err) {
        toast('Error al leer el archivo: ' + err.message);
        loadingOverlay.classList.remove('show');
      }
    };
    reader.readAsText(input.files[0]);
  });
  input.click();
});

// ═══════════════════════════════════════════════════════
// PRESETS: SAVE / LOAD via API
// ═══════════════════════════════════════════════════════
// Cambiá API_BASE a la URL del VPS cuando deployes el frontend standalone
const API_BASE = window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1')
  ? window.location.origin
  : 'https://vps-4455523-x.dattaweb.com/3dlayerterraingenerator';

const $presetName = $('#presetName');
const $presetGrid = $('#presetGrid');
const $savePresetBtn = $('#savePresetBtn');

function getStateSnapshot() {
  return {
    layers: state.layers,
    maxHeight: state.maxHeight,
    sizeX: state.sizeX,
    sizeZ: state.sizeZ,
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
  };
}

function applyStateSnapshot(params) {
  if (!params) return;
  if (params.layers !== undefined) { state.layers = params.layers; $('#layers').value = params.layers; $('#layersVal').textContent = params.layers; }
  if (params.maxHeight !== undefined) { state.maxHeight = params.maxHeight; $('#maxHeight').value = params.maxHeight; $('#heightVal').textContent = params.maxHeight.toFixed(1); }
  if (params.sizeX !== undefined) { state.sizeX = params.sizeX; $('#sizeX').value = params.sizeX; $('#sizeXVal').textContent = params.sizeX.toFixed(1); }
  if (params.sizeZ !== undefined) { state.sizeZ = params.sizeZ; $('#sizeZ').value = params.sizeZ; $('#sizeZVal').textContent = params.sizeZ.toFixed(1); }
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
  if (params.paint3d !== undefined) { state.paint3d = params.paint3d; paint3dBtn.style.borderColor = params.paint3d ? 'var(--accent)' : 'var(--border)'; paint3dBtn.style.background = params.paint3d ? 'rgba(229,83,54,0.15)' : ''; }
  if (params.baseColor !== undefined) { state.baseColor = params.baseColor; $('#baseColorPicker').value = params.baseColor; }
  if (params.paintColor !== undefined) { state.paintColor = params.paintColor; $('#paintColorPicker').value = params.paintColor; }
  if (params.paintAlpha !== undefined) { state.paintAlpha = params.paintAlpha; $('#paintAlpha').value = params.paintAlpha; $('#paintAlphaVal').textContent = params.paintAlpha.toFixed(2); }
  if (params.showBase !== undefined) { state.showBase = params.showBase; var sb = $('#showBaseBtn'); if(sb) sb.innerHTML = state.showBase ? '🧱 Base visible' : '🧱 Base oculta'; }
}

async function savePreset() {
  if (!$presetName) { toast('Panel izquierdo no disponible'); return; }
  const name = $presetName.value.trim();
  if (!name) { toast('Escribí un nombre para el preset'); if ($presetName) $presetName.focus(); return; }
  const params = getStateSnapshot();
  const payload = {
    name: name,
    params: params,
    heightData: Array.from(heightData),
    colorData: colorData ? Array.from(colorData) : null,
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
    const res = await fetch(API_BASE + '/api/terrains');
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
      const del = document.createElement('button'); del.className = 'p-del'; del.textContent = '✕';
      del.addEventListener('click', e => { e.stopPropagation(); deletePreset(item.id); });
      div.appendChild(d); div.appendChild(n); div.appendChild(load); div.appendChild(del);
      $presetGrid.appendChild(div);
    }
  } catch (e) {
    $presetGrid.innerHTML = '<div style="font-size:10px;color:var(--text2);text-align:center;padding:12px 0;">Error de conexión</div>';
    console.error(e);
  }
}

async function loadPreset(id) {
  loadingOverlay.classList.add('show');
  try {
    const res = await fetch(API_BASE + '/api/terrain/' + encodeURIComponent(id));
    if (!res.ok) { toast('Error al cargar preset'); loadingOverlay.classList.remove('show'); return; }
    const data = await res.json();
    if (data.heightData && data.resolution) {
      if (data.resolution !== RES) {
        reallocateData(data.resolution);
      }
      heightData.set(new Float32Array(data.heightData));
      baseHeightData.set(heightData);
    }
    if (data.colorData) {
      colorData = new Float32Array(data.colorData);
    }
    if (data.params) applyStateSnapshot(data.params);
    needsRegen = true;
    drawCanvas();
    requestAnimationFrame(() => {
      rebuildTerrain();
      // Restore saved colors AFTER rebuild (rebuild may reset colorData)
      if (data.colorData && data.colorData.length === RES*RES*3) {
        colorData = new Float32Array(data.colorData);
        if (terrainMesh && state.viewMode !== 'heat') {
          updateMeshColors();
        }
      }
      loadingOverlay.classList.remove('show');
    });
    toast('Preset "' + (data.name || id) + '" cargado');
  } catch (e) {
    toast('Error de conexión al cargar preset');
    loadingOverlay.classList.remove('show');
    console.error(e);
  }
}

async function deletePreset(id) {
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

if ($savePresetBtn) $savePresetBtn.addEventListener('click', savePreset);
if ($presetName) $presetName.addEventListener('keydown', e => { if (e.key === 'Enter') savePreset(); });

// Init paint mode display
updatePaintModeDisplay();

// Load presets list on boot
setTimeout(() => loadPresets(), 500);
loadTerrain('san-juan-color');
initThree();
