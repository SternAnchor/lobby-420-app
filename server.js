const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 8080;

// Gate secret — used to sign the auth cookie
const GATE_SECRET = process.env.GATE_SECRET || 'lobby420-wonderland-2026';

// Cookie-based gate auth
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Keywords that prove you know the theme
const GATE_KEYWORDS = [
  'alice', 'wonderland', 'rabbit hole', 'mad hatter', 'cheshire',
  'queen of hearts', 'tea party', 'white rabbit', 'looking glass',
  'down the rabbit', 'curiouser', 'off with', 'eat me', 'drink me',
  'tweedledee', 'tweedledum', 'caterpillar', 'hookah', 'unbirthday'
];

function isValidGateAnswer(text) {
  const lower = text.toLowerCase();
  return GATE_KEYWORDS.some(kw => lower.includes(kw));
}

function makeGateToken() {
  const payload = `lobby420-authed-${Date.now()}`;
  const hmac = crypto.createHmac('sha256', GATE_SECRET).update(payload).digest('hex');
  return `${payload}.${hmac}`;
}

function verifyGateToken(token) {
  if (!token || !token.includes('.')) return false;
  const lastDot = token.lastIndexOf('.');
  const payload = token.substring(0, lastDot);
  const sig = token.substring(lastDot + 1);
  const expected = crypto.createHmac('sha256', GATE_SECRET).update(payload).digest('hex');
  return sig === expected;
}

// Serve the gate page
app.get('/gate', (req, res) => {
  if (verifyGateToken(req.cookies.lobby_gate)) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'gate.html'));
});

// Gate validation endpoint
app.post('/api/gate', (req, res) => {
  const answer = (req.body.answer || '').trim();
  if (!answer) return res.json({ success: false, message: "You didn't say anything." });
  if (isValidGateAnswer(answer)) {
    const token = makeGateToken();
    res.cookie('lobby_gate', token, {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      httpOnly: true,
      sameSite: 'lax'
    });
    return res.json({ success: true });
  }
  return res.json({ success: false, message: "That's not it. Think harder... 🐇" });
});

// Public paths that don't require auth
const PUBLIC_PATHS = new Set([
  '/gate', '/gate.html', '/api/gate', '/favicon.svg'
]);

// Gate middleware — protect everything except explicitly public paths
function gateMiddleware(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) {
    return next();
  }
  // Check auth cookie
  if (verifyGateToken(req.cookies.lobby_gate)) {
    return next();
  }
  // For browser navigation, redirect to gate
  const accept = req.headers.accept || '';
  if (accept.includes('text/html')) {
    return res.redirect('/gate');
  }
  // For direct asset/API requests (curl, img tags, etc.), return 403
  res.status(403).json({ error: 'Authentication required' });
}

app.use(gateMiddleware);

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
const thumbsDir = path.join(uploadsDir, 'thumbs');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(thumbsDir)) fs.mkdirSync(thumbsDir, { recursive: true });

// Multer config
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2,8)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only images and videos allowed'));
  }
});

// Generate thumbnail from video using ffmpeg
function generateThumbnail(videoPath, thumbPath) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-i', videoPath,
      '-ss', '00:00:01',     // grab frame at 1 second
      '-vframes', '1',
      '-vf', 'scale=400:-1', // 400px wide, maintain aspect
      '-y',
      thumbPath
    ], (err) => {
      if (err) reject(err);
      else resolve(thumbPath);
    });
  });
}

const videoExts = ['.mp4','.mov','.webm','.avi','.mkv','.m4v'];

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// API: list all uploaded media (newest first)
app.get('/api/images', (req, res) => {
  try {
    const files = fs.readdirSync(uploadsDir)
      .filter(f => /\.(jpg|jpeg|png|gif|webp|heic|mp4|mov|webm|avi|mkv|m4v)$/i.test(f))
      .map(f => {
        const ext = path.extname(f).toLowerCase();
        const isVideo = videoExts.includes(ext);
        const baseName = path.basename(f, ext);
        const thumbFile = `${baseName}.jpg`;
        const hasThumb = isVideo && fs.existsSync(path.join(thumbsDir, thumbFile));
        return {
          name: f,
          url: `/uploads/${f}`,
          type: isVideo ? 'video' : 'image',
          thumb: hasThumb ? `/uploads/thumbs/${thumbFile}` : null,
          time: fs.statSync(path.join(uploadsDir, f)).mtimeMs
        };
      })
      .sort((a, b) => b.time - a.time);
    res.json(files);
  } catch (e) {
    res.json([]);
  }
});

// API: upload media (up to 10 at once)
app.post('/api/upload', upload.array('photos', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  // Generate thumbnails for videos
  for (const f of req.files) {
    const ext = path.extname(f.filename).toLowerCase();
    if (videoExts.includes(ext)) {
      const baseName = path.basename(f.filename, ext);
      const thumbPath = path.join(thumbsDir, `${baseName}.jpg`);
      try {
        await generateThumbnail(f.path, thumbPath);
      } catch (e) {
        console.error(`Thumbnail failed for ${f.filename}:`, e.message);
      }
    }
  }

  const uploaded = req.files.map(f => ({
    name: f.filename,
    url: `/uploads/${f.filename}`
  }));
  res.json({ success: true, files: uploaded });
});

// Serve the main site
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`420 Lobby running on port ${PORT}`));
