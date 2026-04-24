const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Multer config — store with unique names
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2,8)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  }
});

// Serve uploaded images
app.use('/uploads', express.static(uploadsDir));

// API: list all uploaded images (newest first)
app.get('/api/images', (req, res) => {
  try {
    const files = fs.readdirSync(uploadsDir)
      .filter(f => /\.(jpg|jpeg|png|gif|webp|heic)$/i.test(f))
      .map(f => ({
        name: f,
        url: `/uploads/${f}`,
        time: fs.statSync(path.join(uploadsDir, f)).mtimeMs
      }))
      .sort((a, b) => b.time - a.time);
    res.json(files);
  } catch (e) {
    res.json([]);
  }
});

// API: upload images (up to 10 at once)
app.post('/api/upload', upload.array('photos', 10), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }
  const uploaded = req.files.map(f => ({
    name: f.filename,
    url: `/uploads/${f.filename}`
  }));
  res.json({ success: true, files: uploaded });
});

// Serve the main site
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`Lobby 420 running on port ${PORT}`));
