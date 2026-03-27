const express = require('express');
const { google } = require('googleapis');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const busboy = require('busboy');
 
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
  console.log('✅ Tokens actualizados');
 
  try {
    const serviceId = process.env.RENDER_SERVICE_ID;
    const renderApiKey = process.env.RENDER_API_KEY;
    if (serviceId && renderApiKey) {
      const res = await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${renderApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ key: 'GOOGLE_TOKENS', value: JSON.stringify(tokens) }]),
      });
      if (res.ok) console.log('✅ Tokens persistidos en Render');
      else console.log('⚠️ Error persistiendo:', await res.text());
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
 
// ─── Subida con streaming (no carga el archivo completo en RAM) ───────────────
app.post('/upload', (req, res) => {
  if (!tokens) return res.status(401).json({ error: 'Drive no autorizado. Visita /auth' });
 
  const bb = busboy({ headers: req.headers, limits: { fileSize: 4 * 1024 * 1024 * 1024 } });
 
  bb.on('file', async (name, fileStream, info) => {
    const { filename, mimeType } = info;
    const isVideo = mimeType.startsWith('video/');
    const isImage = mimeType.startsWith('image/');
 
    if (!isVideo && !isImage) {
      fileStream.resume();
      return res.status(400).json({ error: 'Solo se permiten fotos y videos' });
    }
 
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = path.extname(filename) || (isVideo ? '.mp4' : '.jpg');
    const finalName = `${isVideo ? 'video' : 'foto'}_${timestamp}${ext}`;
 
    console.log(`📤 Streaming ${finalName} a Drive...`);
 
    try {
      const response = await drive.files.create({
        requestBody: { name: finalName, parents: [FOLDER_ID] },
        media: { mimeType, body: fileStream },
        fields: 'id, name',
      });
 
      console.log(`✅ Subido: ${response.data.name}`);
      res.json({ success: true, fileId: response.data.id, fileName: response.data.name });
    } catch (error) {
      console.error('❌ Error streaming a Drive:', error.message);
      if (!res.headersSent) res.status(500).json({ error: error.message });
    }
  });
 
  bb.on('error', (err) => {
    console.error('❌ Error busboy:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
 
  req.pipe(bb);
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
 
