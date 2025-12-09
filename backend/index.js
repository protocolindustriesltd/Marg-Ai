// backend/index.js
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// Security: simple API key (optional)
const API_KEY = process.env.API_KEY || null;
app.use((req,res,next) => {
  if (req.method === 'GET' || !API_KEY) return next();
  const key = req.header('x-api-key');
  if (!key || key !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
});

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname,'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req,file,cb) => cb(null, UPLOAD_DIR),
  filename: (req,file,cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g,'_'))
});
const upload = multer({ storage, limits: { fileSize: 8*1024*1024 } }); // 8MB limit

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.get('/', (req,res) => res.json({ status: 'ok' }));

// POST /detect expects 'frame' field (image/jpeg); returns stubbed detections for now
app.post('/detect', upload.single('frame'), (req,res) => {
  if (!req.file) return res.status(400).json({ error: 'no frame uploaded (field: frame)' });
  // In real integration: run model, produce detections
  // Here we return a stubbed detection if in demo or empty list
  const payload = {
    frame_w: req.body.frame_w || 640,
    frame_h: req.body.frame_h || 360,
    detections: [], // replace with real detections array: [{xyxy:[x1,y1,x2,y2], conf:0.87, label:"pothole"}]
    alerts: [] // optional alerts
  };
  // Optionally: emit over socket
  io.emit('detection', { filename: req.file.filename, ...payload });
  res.json(payload);
});

// serve static uploads (not for public prod usage without auth)
app.use('/uploads', express.static(UPLOAD_DIR));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Backend listening on port ${PORT}`));
