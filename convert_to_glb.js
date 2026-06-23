const THREE = require('three');
const fs = require('fs');
const path = require('path');

// Import GLTFExporter
const { GLTFExporter } = require('three/examples/jsm/exporters/GLTFExporter.js');

// Config
const INPUT = path.join(__dirname, 'sanjuanf.json');
const OUTPUT = path.join(__dirname, '..', 'caminosysabores', 'maqueta', 'san_juan_territorio.glb');

// Downsample resolution for manageable GLB size
// Original: 800x800 (640K vertices -> huge GLB)
// Target: 256x256 (65K vertices -> reasonable)
const TARGET_RES = 256;

console.log(`Reading ${INPUT}...`);
const raw = JSON.parse(fs.readFileSync(INPUT, 'utf-8'));

const params = raw.params;
const originalRes = raw.resolution || 800;
const heightData = new Float32Array(raw.heightData);
const colorData = raw.colorData ? new Float32Array(raw.colorData) : null;

console.log(`Original resolution: ${originalRes}x${originalRes}`);
console.log(`Params: layers=${params.layers}, maxHeight=${params.maxHeight}, smoothing=${params.smoothing}`);
console.log(`sizeX=${params.sizeX}, sizeZ=${params.sizeZ}`);

// Step 1: Smooth the heightData (same as terrain generator)
function smoothHeightmap(data, res, passes) {
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

// Step 2: Downsample from originalRes to TARGET_RES
function downsample(src, srcRes, dstRes) {
  const dst = new Float32Array(dstRes * dstRes);
  const scale = srcRes / dstRes;
  for (let dy = 0; dy < dstRes; dy++) {
    for (let dx = 0; dx < dstRes; dx++) {
      // Bilinear interpolation from source
      const sx = dx * scale;
      const sy = dy * scale;
      const ix = Math.min(Math.floor(sx), srcRes - 2);
      const iy = Math.min(Math.floor(sy), srcRes - 2);
      const fx = sx - ix;
      const fy = sy - iy;
      const a = src[iy * srcRes + ix];
      const b = src[iy * srcRes + Math.min(ix + 1, srcRes - 1)];
      const c = src[Math.min(iy + 1, srcRes - 1) * srcRes + ix];
      const d = src[Math.min(iy + 1, srcRes - 1) * srcRes + Math.min(ix + 1, srcRes - 1)];
      dst[dy * dstRes + dx] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    }
  }
  return dst;
}

console.log('Smoothing height data...');
smoothHeightmap(heightData, originalRes, params.smoothing || 2);

console.log('Applying brightness/contrast...');
const brillo = params.brillo || 0;
const contraste = params.contraste || 1;
const N = params.layers || 17;
const maxHeight = params.maxHeight || 2.3;
const sizeX = params.sizeX || 5;
const sizeZ = params.sizeZ || 5;

// Apply brightness/contrast
for (let i = 0; i < heightData.length; i++) {
  const v = heightData[i];
  if (v > 0.001) {
    heightData[i] = Math.max(0, Math.min(1, (v - 0.5) * contraste + 0.5 + brillo));
  }
}

console.log(`Downsampling to ${TARGET_RES}x${TARGET_RES}...`);
const downsampled = downsample(heightData, originalRes, TARGET_RES);

// Downsample colorData if available
let colorDataDown = null;
if (colorData) {
  colorDataDown = new Float32Array(TARGET_RES * TARGET_RES * 3);
  const scale = originalRes / TARGET_RES;
  for (let dy = 0; dy < TARGET_RES; dy++) {
    for (let dx = 0; dx < TARGET_RES; dx++) {
      const sx = dx * scale;
      const sy = dy * scale;
      const ix = Math.min(Math.floor(sx), originalRes - 2);
      const iy = Math.min(Math.floor(sy), originalRes - 2);
      const fx = sx - ix;
      const fy = sy - iy;
      const idx = (iy * originalRes + ix) * 3;
      const a_r = colorData[idx], a_g = colorData[idx + 1], a_b = colorData[idx + 2];
      const b_r = colorData[idx + 3], b_g = colorData[idx + 4], b_b = colorData[idx + 5];
      const c_r = colorData[idx + originalRes * 3], c_g = colorData[idx + originalRes * 3 + 1], c_b = colorData[idx + originalRes * 3 + 2];
      const d_r = colorData[idx + originalRes * 3 + 3], d_g = colorData[idx + originalRes * 3 + 4], d_b = colorData[idx + originalRes * 3 + 5];
      const di = (dy * TARGET_RES + dx) * 3;
      colorDataDown[di] = a_r * (1-fx) * (1-fy) + b_r * fx * (1-fy) + c_r * (1-fx) * fy + d_r * fx * fy;
      colorDataDown[di+1] = a_g * (1-fx) * (1-fy) + b_g * fx * (1-fy) + c_g * (1-fx) * fy + d_g * fx * fy;
      colorDataDown[di+2] = a_b * (1-fx) * (1-fy) + b_b * fx * (1-fy) + c_b * (1-fx) * fy + d_b * fx * fy;
    }
  }
}

// Quantize to N layers
console.log('Quantizing...');
const quantized = new Float32Array(TARGET_RES * TARGET_RES);
for (let i = 0; i < TARGET_RES * TARGET_RES; i++) {
  // Apply contrast/brightness to downsampled data
  const v = downsampled[i];
  quantized[i] = Math.floor(v * N) / N;
}

// Build geometry
console.log('Building mesh...');
const RES = TARGET_RES;
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
      colors.push(colorDataDown[idx], colorDataDown[idx + 1], colorDataDown[idx + 2]);
    } else {
      // Default sandy color
      colors.push(0.77, 0.64, 0.40);
    }
  }
}

// Build triangle indices
for (let z = 0; z < RES - 1; z++) {
  for (let x = 0; x < RES - 1; x++) {
    const a = z * RES + x;
    const b = z * RES + x + 1;
    const c = (z + 1) * RES + x;
    const d = (z + 1) * RES + x + 1;

    // Skip quads where all corners are flat (height = 0)
    if (quantized[a] === 0 && quantized[b] === 0 && quantized[c] === 0 && quantized[d] === 0) continue;

    indices.push(a, b, c);
    indices.push(b, d, c);
  }
}

console.log(`Vertices: ${positions.length / 3}, Triangles: ${indices.length / 3}`);

const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
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

const scene = new THREE.Scene();
scene.add(mesh);

console.log('Exporting GLB...');
const exporter = new GLTFExporter();

exporter.parse(
  scene,
  (glb) => {
    // glb is an ArrayBuffer
    const buffer = Buffer.from(glb);
    fs.writeFileSync(OUTPUT, buffer);
    console.log(`GLB exported to ${OUTPUT}`);
    console.log(`File size: ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);

    // Also save as a copy in the terrain generator project
    const localCopy = path.join(__dirname, 'san_juan_territorio.glb');
    fs.writeFileSync(localCopy, buffer);
    console.log(`Also saved to ${localCopy}`);
  },
  (error) => {
    console.error('Export error:', error);
  },
  { binary: true, includeCustomExtensions: false }
);
