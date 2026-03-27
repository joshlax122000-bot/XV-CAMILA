const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
 
const app = express();
const PORT = process.env.PORT || 10000;
 
// ─── OAuth2 ───────────────────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
 
let tokens = null;
const TOKEN_FILE = '/tmp/tokens.json';
 
function loadTokens() {
  try {
    if (process.env.GOOGLE_TOKENS) {
      tokens = JSON.parse(process.env.GOOGLE_TOKENS);
      oauth2Client.setCredentials(tokens);
      console.log('✅ Tokens cargados desde env');
      return;
    }
    if (fs.existsSync(TOKEN_FILE)) {
      tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      oauth2Client.setCredentials(tokens);
      console.log('✅ Tokens cargados desde archivo');
    }
  } catch (e) {
    console.log('⚠️ Error cargando tokens:', e.message);
  }
}
 
async function saveTokens(newTokens) {
  tokens = { ...tokens, ...newTokens };
  oauth2Client.setCredentials(tokens);
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens)); } catch(e) {}
 
  // Persistir en Render
  try {
    const serviceId = process.env.RENDER_SERVICE_ID;
    const renderApiKey = process.env.RENDER_API_KEY;
    if (serviceId && renderApiKey) {
      const current = await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars`, {
        headers: { 'Authorization': `Bearer ${renderApiKey}` }
      });
      const envVars = await current.json();
      const others = Array.isArray(envVars) 
        ? envVars.filter(v => v.envVar?.key !== 'GOOGLE_TOKENS').map(v => ({ key: v.envVar.key, value: v.envVar.value }))
        : [];
      others.push({ key: 'GOOGLE_TOKENS', value: JSON.stringify(tokens) });
      await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${renderApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(others),
      });
      console.log('✅ Tokens persistidos en Render');
    }
  } catch (e) {
    console.log('⚠️ Error Render API:', e.message);
  }
}
 
loadTokens();
oauth2Client.on('tokens', (newTokens) => saveTokens(newTokens));
 
const drive = google.drive({ version: 'v3', auth: oauth2Client });
const FOLDER_ID = process.env.DRIVE_FOLDER_ID;
 
// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));
 
// ─── Multer — guarda en disco temporal para no usar RAM ───────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, '/tmp'),
  filename: (req, file, cb) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = path.extname(file.originalname) || '';
    const tipo = file.mimetype.startsWith('video/') ? 'video' : 'foto';
    cb(null, `${tipo}_${timestamp}${ext}`);
  }
});
 
const upload = multer({
  storage,
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
 
// ─── OAuth2 ───────────────────────────────────────────────────────────────────
app.get('/auth', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive'],
  });
  res.redirect(authUrl);
});
 
app.get('/oauth2callback', async (req, res) => {
  try {
    const { tokens: newTokens } = await oauth2Client.getToken(req.query.code);
    await saveTokens(newTokens);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#fdf8f2">
        <h1 style="color:#c9a96e">✅ ¡Autorización exitosa!</h1>
        <p>Google Drive conectado correctamente.</p>
        <a href="/" style="color:#c4788e">Ir a la página de fotos →</a>
      </body></html>
    `);
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});
 
// ─── Subida a Drive via disco temporal (no usa RAM) ──────────────────────────
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
  if (!tokens) return res.status(401).json({ error: 'Drive no autorizado. Visita /auth' });
 
  const filePath = req.file.path;
 
  try {
    const sizeMB = (req.file.size / (1024 * 1024)).toFixed(1);
    console.log(`📤 Subiendo ${req.file.filename} (${sizeMB}MB) a Drive...`);
 
    // Leer desde disco como stream — sin cargar en RAM
    const fileStream = fs.createReadStream(filePath);
 
    const response = await drive.files.create({
      requestBody: { name: req.file.filename, parents: [FOLDER_ID] },
      media: { mimeType: req.file.mimetype, body: fileStream },
      fields: 'id, name',
    });
 
    console.log(`✅ Subido: ${response.data.name}`);
    res.json({ success: true, fileId: response.data.id, fileName: response.data.name });
 
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    // Eliminar archivo temporal del disco
    try { fs.unlinkSync(filePath); } catch(e) {}
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
 
app.post('/webhook', (req, res) => { res.sendStatus(200); });
 
// ─── Server ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  console.log(`📁 Drive Folder ID: ${FOLDER_ID}`);
  console.log(`🔐 OAuth autorizado: ${tokens !== null}`);
});
 
