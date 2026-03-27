const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const path = require('path');
const cors = require('cors');
const { Readable } = require('stream');
 
const app = express();
const PORT = process.env.PORT || 10000;
 
// ─── Configuración de Cloudinary ─────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
 
// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));
 
// ─── Multer (memoria) ─────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
  fileFilter: (req, file, cb) => {
    const allowed = /image\/(jpeg|jpg|png|gif|webp|heic|heif)|video\/(mp4|mov|avi|mkv|quicktime)/;
    if (allowed.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten fotos y videos'), false);
    }
  },
});
 
// ─── Ruta principal ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
 
// ─── Ruta de subida a Cloudinary ─────────────────────────────────────────────
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No se recibió ningún archivo' });
  }
 
  try {
    const isVideo = req.file.mimetype.startsWith('video/');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const publicId = `xv-camila/${isVideo ? 'video' : 'foto'}_${timestamp}`;
 
    // Subir a Cloudinary usando stream
    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id: publicId,
          resource_type: isVideo ? 'video' : 'image',
          folder: 'xv-camila',
          overwrite: false,
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
 
      const readable = Readable.from(req.file.buffer);
      readable.pipe(uploadStream);
    });
 
    console.log(`✅ Archivo subido: ${result.public_id}`);
    res.json({
      success: true,
      publicId: result.public_id,
      url: result.secure_url,
    });
 
  } catch (error) {
    console.error('❌ Error al subir a Cloudinary:', error.message);
    res.status(500).json({ error: error.message });
  }
});
 
// ─── Webhook de WhatsApp ──────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
 
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});
 
app.post('/webhook', (req, res) => {
  console.log('📩 Webhook recibido:', JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});
 
// ─── Server ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`☁️  Cloudinary cloud: ${process.env.CLOUDINARY_CLOUD_NAME}`);
});
 
