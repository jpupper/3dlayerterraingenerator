const THREE = require('three');
const fs = require('fs');
const path = require('path');

// ──────────────────────────────────────────────
// Manual GLB writer (no browser APIs needed)
// ──────────────────────────────────────────────

function writeGLB(json, binBuffer) {
  const encoder = new TextEncoder();
  const jsonStr = JSON.stringify(json);
  // Pad JSON string to 4-byte alignment (required by GLTFLoader)
  const padLen = (4 - (jsonStr.length % 4)) % 4;
  const paddedJsonStr = jsonStr + ' '.repeat(padLen);
  const jsonData = encoder.encode(paddedJsonStr);

  // Chunk headers
  const jsonChunkHeader = new ArrayBuffer(8);
  const jv = new DataView(jsonChunkHeader);
  jv.setUint32(0, jsonData.byteLength, true);  // chunk length (now 4-byte aligned)
  jv.setUint32(4, 0x4E4F534A, true);            // JSON chunk type

  const binChunkHeader = new ArrayBuffer(8);
  const bv = new DataView(binChunkHeader);
  bv.setUint32(0, binBuffer.byteLength, true);  // chunk length
  bv.setUint32(4, 0x004E4942, true);            // BIN chunk type

  // Total length: header (12) + json chunk header (8) + json data + bin chunk header (8) + bin data
  const totalLength = 12 + jsonChunkHeader.byteLength + jsonData.byteLength +
                            binChunkHeader.byteLength + binBuffer.byteLength;

  const glb = new ArrayBuffer(totalLength);
  const view = new DataView(glb);

  // GLB header
  view.setUint32(0, 0x46546C67, true);  // "glTF"
  view.setUint32(4, 2, true);           // version
  view.setUint32(8, totalLength, true); // total length

  let offset = 12;
  // JSON chunk
  new Uint8Array(glb, offset, 8).set(new Uint8Array(jsonChunkHeader));
  offset += 8;
  new Uint8Array(glb, offset, jsonData.byteLength).set(jsonData);
  offset += jsonData.byteLength;

  // BIN chunk
  new Uint8Array(glb, offset, 8).set(new Uint8Array(binChunkHeader));
  offset += 8;
  new Uint8Array(glb, offset, binBuffer.byteLength).set(new Uint8Array(binBuffer));

  return Buffer.from(glb);
}

// ──────────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────────
const INPUT = path.join(__dirname, 'sanjuanf.json');
const OUTPUT = path.join(__dirname, '..', 'caminosysabores', 'maqueta', 'san_juan_territorio.glb');
const TARGET_RES = 256;

console.log(`Reading ${INPUT}...`);
const raw = JSON.parse(fs.readFileSync(INPUT, 'utf-8'));

const params = raw.params;
const originalRes = raw.resolution || 800;
const heightData = new Float32Array(raw.heightData);
const colorData = raw.colorData ? new Float32Array(raw.colorData) : null;

console.log(`Original: ${originalRes}x${originalRes} → Target: ${TARGET_RES}x${TARGET_RES}`);
console.log(`Params: layers=${params.layers}, maxHeight=${params.maxHeight}, smoothing=${params.smoothing}`);

const maxHeight = params.maxHeight || 2.3;
// Override to match old GLB terrain dimensions (X: -6.02 to 5.70, Z: -6.18 to 5.44)
const sizeX = 12;
const sizeZ = 12;
const N = params.layers || 17;
const smoothing = params.smoothing || 2;
const brillo = params.brillo || 0;
const contraste = params.contraste || 1;
const showBase = true; // Always show base so POIs at flat areas have geometry underneath

// ── Smoothing ──
function smoothHeightmap(data, res, passes) {
  if (passes <= 0) return;
  const tmp = new Float32Array(res * res);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < res && ny >= 0 && ny < res) { s += data[ny * res + nx]; n++; }
      }
      tmp[y * res + x] = s / n;
    }
    data.set(tmp);
  }
}

// ── Downsample ──
function downsample(src, srcRes, dstRes) {
  const dst = new Float32Array(dstRes * dstRes);
  const scale = srcRes / dstRes;
  for (let dy = 0; dy < dstRes; dy++) {
    for (let dx = 0; dx < dstRes; dx++) {
      const sx = dx * scale, sy = dy * scale;
      const ix = Math.min(Math.floor(sx), srcRes - 2);
      const iy = Math.min(Math.floor(sy), srcRes - 2);
      const fx = sx - ix, fy = sy - iy;
      const a = src[iy * srcRes + ix];
      const b = src[iy * srcRes + Math.min(ix + 1, srcRes - 1)];
      const c = src[Math.min(iy + 1, srcRes - 1) * srcRes + ix];
      const d = src[Math.min(iy + 1, srcRes - 1) * srcRes + Math.min(ix + 1, srcRes - 1)];
      dst[dy * dstRes + dx] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    }
  }
  return dst;
}

// ── Downsample color ──
function downsampleColor(src, srcRes, dstRes) {
  const dst = new Float32Array(dstRes * dstRes * 3);
  const scale = srcRes / dstRes;
  for (let dy = 0; dy < dstRes; dy++) {
    for (let dx = 0; dx < dstRes; dx++) {
      const sx = dx * scale, sy = dy * scale;
      const ix = Math.min(Math.floor(sx), srcRes - 2);
      const iy = Math.min(Math.floor(sy), srcRes - 2);
      const fx = sx - ix, fy = sy - iy;
      const si = (iy * srcRes + ix) * 3;
      const a = [src[si], src[si+1], src[si+2]];
      const b = [src[si+3], src[si+4], src[si+5]];
      const c = [src[si + srcRes*3], src[si + srcRes*3 + 1], src[si + srcRes*3 + 2]];
      const d = [src[si + srcRes*3 + 3], src[si + srcRes*3 + 4], src[si + srcRes*3 + 5]];
      const di = (dy * dstRes + dx) * 3;
      for (let k = 0; k < 3; k++) {
        dst[di + k] = a[k]*(1-fx)*(1-fy) + b[k]*fx*(1-fy) + c[k]*(1-fx)*fy + d[k]*fx*fy;
      }
    }
  }
  return dst;
}

// ── Process ──
console.log('Smoothing...');
smoothHeightmap(heightData, originalRes, smoothing);

console.log('Applying brightness/contrast...');
for (let i = 0; i < heightData.length; i++) {
  const v = heightData[i];
  if (v > 0.001) {
    heightData[i] = Math.max(0, Math.min(1, (v - 0.5) * contraste + 0.5 + brillo));
  }
}

console.log('Downsampling...');
const downsampled = downsample(heightData, originalRes, TARGET_RES);
const colorDataDown = colorData ? downsampleColor(colorData, originalRes, TARGET_RES) : null;

console.log('Quantizing...');
const RES = TARGET_RES;
const quantized = new Float32Array(RES * RES);
for (let i = 0; i < RES * RES; i++) {
  quantized[i] = Math.floor(downsampled[i] * N) / N;
}

// ── Build GLTF JSON ──
console.log('Building GLTF...');

// Determine min/max for mesh
const positions = [];
const colors = [];
const indices = [];

for (let z = 0; z < RES; z++) {
  for (let x = 0; x < RES; x++) {
    const h = quantized[z * RES + x];
    positions.push(
      (x / (RES - 1) - 0.5) * sizeX,
      h * maxHeight,
      (z / (RES - 1) - 0.5) * sizeZ
    );
    if (colorDataDown) {
      const idx = (z * RES + x) * 3;
      colors.push(colorDataDown[idx], colorDataDown[idx+1], colorDataDown[idx+2]);
    } else {
      colors.push(0.77, 0.64, 0.40);
    }
  }
}

for (let z = 0; z < RES - 1; z++) {
  for (let x = 0; x < RES - 1; x++) {
    const a = z * RES + x;
    const b = z * RES + x + 1;
    const c = (z + 1) * RES + x;
    const d = (z + 1) * RES + x + 1;

    if (!showBase && quantized[a] === 0 && quantized[b] === 0 && quantized[c] === 0 && quantized[d] === 0) continue;
    indices.push(a, b, c);
    indices.push(b, d, c);
  }
}

console.log(`Positions: ${positions.length/3}, Indices: ${indices.length/3}`);

// Compute normals (simple per-face normals averaged per vertex)
const normals = new Float32Array(positions.length);
normals.fill(0);

function addNormal(vIdx, nx, ny, nz) {
  normals[vIdx*3] += nx;
  normals[vIdx*3+1] += ny;
  normals[vIdx*3+2] += nz;
}

for (let i = 0; i < indices.length; i += 3) {
  const i0 = indices[i], i1 = indices[i+1], i2 = indices[i+2];
  const p0 = [positions[i0*3], positions[i0*3+1], positions[i0*3+2]];
  const p1 = [positions[i1*3], positions[i1*3+1], positions[i1*3+2]];
  const p2 = [positions[i2*3], positions[i2*3+1], positions[i2*3+2]];
  const e1 = [p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2]];
  const e2 = [p2[0]-p0[0], p2[1]-p0[1], p2[2]-p0[2]];
  // Cross product
  const nx = e1[1]*e2[2] - e1[2]*e2[1];
  const ny = e1[2]*e2[0] - e1[0]*e2[2];
  const nz = e1[0]*e2[1] - e1[1]*e2[0];
  // Normalize
  const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
  addNormal(i0, nx/len, ny/len, nz/len);
  addNormal(i1, nx/len, ny/len, nz/len);
  addNormal(i2, nx/len, ny/len, nz/len);
}

// Normalize normals
for (let i = 0; i < positions.length/3; i++) {
  const len = Math.sqrt(normals[i*3]*normals[i*3] + normals[i*3+1]*normals[i*3+1] + normals[i*3+2]*normals[i*3+2]) || 1;
  normals[i*3] /= len;
  normals[i*3+1] /= len;
  normals[i*3+2] /= len;
}

// Build binary buffer: [positions][normals][colors][indices]
const floatView = new Float32Array(positions.length + normals.length + colors.length);
floatView.set(positions, 0);
floatView.set(normals, positions.length);
floatView.set(colors, positions.length + normals.length);

// Write indices as Uint16 (max 65536 vertices, Uint16 is fine since RES=256 -> 65536)
const indicesView = new Uint16Array(indices);
const binaryBuffer = new ArrayBuffer(
  floatView.byteLength + indicesView.byteLength
);
new Uint8Array(binaryBuffer).set(new Uint8Array(floatView.buffer), 0);
new Uint8Array(binaryBuffer).set(new Uint8Array(indicesView.buffer), floatView.byteLength);

// GLTF JSON
const gltf = {
  asset: { version: '2.0', generator: 'sanjuanf-converter' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{
    primitives: [{
      attributes: {
        POSITION: 0,
        NORMAL: 1,
        COLOR_0: 2
      },
      indices: 3,
      material: 0
    }]
  }],
  materials: [{
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 0.05,
      roughnessFactor: 0.6
    },
    doubleSided: true
  }],
  accessors: [
    // 0: POSITION
    { bufferView: 0, componentType: 5126, count: positions.length/3, type: 'VEC3', min: [-sizeX/2, 0, -sizeZ/2], max: [sizeX/2, maxHeight, sizeZ/2] },
    // 1: NORMAL
    { bufferView: 1, componentType: 5126, count: normals.length/3, type: 'VEC3' },
    // 2: COLOR_0
    { bufferView: 2, componentType: 5126, count: colors.length/3, type: 'VEC3' },
    // 3: INDICES
    { bufferView: 3, componentType: 5123, count: indices.length, type: 'SCALAR' }
  ],
  bufferViews: [
    // 0: positions
    { buffer: 0, byteOffset: 0, byteLength: positions.length * 4, target: 34962 },
    // 1: normals
    { buffer: 0, byteOffset: positions.length * 4, byteLength: normals.length * 4, target: 34962 },
    // 2: colors
    { buffer: 0, byteOffset: (positions.length + normals.length) * 4, byteLength: colors.length * 4, target: 34962 },
    // 3: indices
    { buffer: 0, byteOffset: (positions.length + colors.length + normals.length) * 4, byteLength: indicesView.byteLength, target: 34963 }
  ],
  buffers: [{
    byteLength: binaryBuffer.byteLength
  }]
};

console.log('Writing GLB...');
const glbBuffer = writeGLB(gltf, binaryBuffer);
fs.writeFileSync(OUTPUT, glbBuffer);
console.log(`GLB written to ${OUTPUT}`);
console.log(`Size: ${(glbBuffer.length / 1024 / 1024).toFixed(1)} MB`);

// Also check the original GLB size
const originalGLB = path.join(__dirname, '..', 'caminosysabores', 'maqueta', 'san_juan_territorio_con_pois.glb');
if (fs.existsSync(originalGLB)) {
  const origSize = fs.statSync(originalGLB).size;
  console.log(`Old GLB (con_pois): ${(origSize / 1024 / 1024).toFixed(1)} MB`);
}
