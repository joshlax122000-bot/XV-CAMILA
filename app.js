const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const { Readable } = require('stream');
 
const app = express();
const PORT = process.env.PORT || 10000;
 
// ─── OAuth2 Config ────────────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
 
// Cargar tokens guardados si existen
let tokens = null;
const TOKEN_FILE = '/tmp/tokens.json';
 
function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      oauth2Client.setCredentials(tokens);
      console.log('✅ Tokens cargados correctamente');
    }
  } catch (e) {
    console.log('⚠️ No se pudieron cargar tokens:', e.message);
  }
}
 
function saveTokens(newTokens) {
  tokens = newTokens;
  oauth2Client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens));
  console.log('✅ Tokens guardados');
}
 
loadTokens();
 
// Refrescar token automáticamente
oauth2Client.on('tokens', (newTokens) => {
  if (newTokens.refresh_token) {
    saveTokens({ ...tokens, ...newTokens });
  } else {
    tokens = { ...tokens, ...newTokens };
    oauth2Client.setCredentials(tokens);
  }
});
 
const drive = google.drive({ version: 'v3', auth: oauth2Client });
const FOLDER_ID = process.env.DRIVE_FOLDER_ID;
 
// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));
 
// ─── Multer sin límite ────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
  fileFilter: (req, file, cb) => {
    const allowed = /image\/(jpeg|jpg|png|gif|webp|heic|heif)|video\/(mp4|mov|avi|mkv|quicktime)/;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error('Solo se permiten fotos y videos'), false);
  },
});
 
// ─── Ruta principal ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
 
// ─── OAuth2: iniciar autorización (solo tú usarás esto una vez) ───────────────
app.get('/auth', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive'],
  });
  res.redirect(authUrl);
});
 
// ─── OAuth2: callback después de autorizar ────────────────────────────────────
app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens: newTokens } = await oauth2Client.getToken(code);
    saveTokens(newTokens);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#fdf8f2">
        <h1 style="color:#c9a96e">✅ ¡Autorización exitosa!</h1>
        <p>Google Drive está conectado correctamente.</p>
        <p>Ya puedes cerrar esta ventana.</p>
        <a href="/" style="color:#c4788e">Ir a la página de fotos →</a>
      </body></html>
    `);
  } catch (error) {
    console.error('Error en OAuth callback:', error);
    res.status(500).send('Error al obtener tokens: ' + error.message);
  }
});
 
// ─── Estado de autorización ───────────────────────────────────────────────────
app.get('/auth-status', (req, res) => {
  res.json({ authorized: tokens !== null });
});
 
// ─── Subida a Drive ───────────────────────────────────────────────────────────
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No se recibió ningún archivo' });
  }
 
  if (!tokens) {
    return res.status(401).json({ 
      error: 'Google Drive no está autorizado. Visita /auth para autorizar.' 
    });
  }
 
  try {
    const stream = Readable.from(req.file.buffer);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = path.extname(req.file.originalname) || '';
    const isVideo = req.file.mimetype.startsWith('video/');
    const fileName = `${isVideo ? 'video' : 'foto'}_${timestamp}${ext}`;
    const fileSizeMB = (req.file.size / (1024 * 1024)).toFixed(1);
 
    console.log(`📤 Subiendo ${fileName} (${fileSizeMB}MB) a Drive...`);
 
    const response = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [FOLDER_ID],
      },
      media: {
        mimeType: req.file.mimetype,
        body: stream,
      },
      fields: 'id, name',
    });
 
    console.log(`✅ Subido: ${response.data.name}`);
    res.json({ success: true, fileId: response.data.id, fileName: response.data.name });
 
  } catch (error) {
    console.error('❌ Error al subir a Drive:', error.message);
    res.status(500).json({ error: error.message });
  }
});
 
// ─── Webhook WhatsApp ─────────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});
 
app.post('/webhook', (req, res) => {
  console.log('📩 Webhook:', JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});
 
// ─── Server ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  console.log(`📁 Drive Folder ID: ${FOLDER_ID}`);
  console.log(`🔐 OAuth autorizado: ${tokens !== null}`);
});
 
