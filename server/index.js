const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4938;
const BASE_PATH = process.env.BASE_PATH || '';

// CORS - allow frontend from any origin
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With'],
}));
app.options('*', cors());

// --- Config ---
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Ensure dirs exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// --- Middleware ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static files
app.use(BASE_PATH + '/', express.static(PUBLIC_DIR));

// --- Multer for file uploads ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.dat';
    const name = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
    cb(null, name);
  }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// --- API Routes ---

// Save heightmap image
app.post(BASE_PATH + '/api/heightmap', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: '/uploads/' + req.file.filename, filename: req.file.filename });
});

// Save 3D model (STL/GLB)
app.post(BASE_PATH + '/api/model', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: '/uploads/' + req.file.filename, filename: req.file.filename });
});

// Save a complete terrain project (JSON with heightData + params)
app.post(BASE_PATH + '/api/terrain', (req, res) => {
  const data = req.body;
  if (!data || !data.name) return res.status(400).json({ error: 'Name required' });
  const filename = Date.now() + '-' + data.name.replace(/[^a-zA-Z0-9_-]/g, '') + '.json';
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), JSON.stringify(data, null, 2));
  res.json({ url: '/uploads/' + filename, filename });
});

// List saved terrains
app.get(BASE_PATH + '/api/terrains', (req, res) => {
  const files = fs.readdirSync(UPLOADS_DIR).filter(f => f.endsWith('.json'));
  const terrains = files.map(f => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(UPLOADS_DIR, f), 'utf-8'));
      return { id: f, name: raw.name || f, thumbnail: raw.thumbnail || null, params: raw.params || {} };
    } catch(e) { return null; }
  }).filter(Boolean);
  res.json(terrains);
});

// Load a specific terrain
app.get(BASE_PATH + '/api/terrain/:id', (req, res) => {
  const filepath = path.join(UPLOADS_DIR, req.params.id);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filepath);
});

// Delete a terrain
app.delete(BASE_PATH + '/api/terrain/:id', (req, res) => {
  const filepath = path.join(UPLOADS_DIR, req.params.id);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(filepath);
  res.json({ success: true });
});

// Serve uploaded files
app.use(BASE_PATH + '/uploads', express.static(UPLOADS_DIR));

// API info
app.get(BASE_PATH + '/api', (req, res) => {
  res.json({ name: '3D Layer Terrain Generator API', version: '1.0.0', endpoints: ['/api/heightmap', '/api/model', '/api/terrain', '/api/terrains'] });
});

// --- Start ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Terrain Generator running on port ${PORT}`);
  console.log(`Serving static from: ${PUBLIC_DIR}`);
  console.log(`Uploads: ${UPLOADS_DIR}`);
});
