const express = require('express');
const { google } = require('googleapis');
const path = require('path');
const cors = require('cors');
 
const app = express();
const PORT = process.env.PORT || 10000;
 
// ─── OAuth2 Config ────────────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
 
let tokens = null;
 
// Cargar tokens desde variable de entorno (persisten entre reinicios)
function loadTokens() {
  try {
    const raw = process.env.GOOGLE_TOKENS;
    if (raw) {
      tokens = JSON.parse(raw);
      oauth2Client.setCredentials(tokens);
      console.log('✅ Tokens cargados correctamente');
    } else {
      console.log('⚠️ Sin tokens. Visita /auth para autorizar.');
    }
  } catch (e) {
    console.log('⚠️ Error cargando tokens:', e.message);
  }
}
 
// Guardar tokens en Render via API (para que persistan al reiniciar)
async function saveTokens(newTokens) {
  tokens = { ...tokens, ...newTokens };
  oauth2Client.setCredentials(tokens);
  console.log('✅ Tokens actualizados en memoria');
 
  // Persistir en Render environment variables
  try {
    const serviceId = process.env.RENDER_SERVICE_ID;
    const renderApiKey = process.env.RENDER_API_KEY;
 
    if (serviceId && renderApiKey) {
      const res = await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${renderApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([
          { key: 'GOOGLE_TOKENS', value: JSON.stringify(tokens) }
        ]),
      });
      if (res.ok) console.log('✅ Tokens guardados en Render');
      else console.log('⚠️ No se pudo guardar en Render:', await res.text());
    }
  } catch (e) {
    console.log('⚠️ Error guardando en Render:', e.message);
  }
}
 
loadTokens();
 
oauth2Client.on('tokens', (newTokens) => {
  saveTokens(newTokens);
});
 
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
  const { code } = req.query;
  try {
    const { tokens: newTokens } = await oauth2Client.getToken(code);
    await saveTokens(newTokens);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#fdf8f2">
        <h1 style="color:#c9a96e">✅ ¡Autorización exitosa!</h1>
        <p>Google Drive conectado correctamente.</p>
        <p style="font-size:12px;color:#999">El token quedará guardado permanentemente.</p>
        <a href="/" style="color:#c4788e">Ir a la página de fotos →</a>
      </body></html>
    `);
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});
 
// ─── Generar URL de subida directa para cualquier archivo ─────────────────────
app.post('/get-upload-url', async (req, res) => {
  if (!tokens) {
    return res.status(401).json({ error: 'Drive no autorizado. Visita /auth' });
  }
 
  try {
    const { fileName, mimeType, fileSize } = req.body;
    const isVideo = mimeType.startsWith('video/');
    const isImage = mimeType.startsWith('image/');
 
    if (!isVideo && !isImage) {
      return res.status(400).json({ error: 'Solo se permiten fotos y videos' });
    }
 
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = path.extname(fileName) || (isVideo ? '.mp4' : '.jpg');
    const finalName = `${isVideo ? 'video' : 'foto'}_${timestamp}${ext}`;
 
    const { token } = await oauth2Client.getAccessToken();
 
    const initResponse = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': mimeType,
          'X-Upload-Content-Length': fileSize,
        },
        body: JSON.stringify({
          name: finalName,
          parents: [FOLDER_ID],
        }),
      }
    );
 
    if (!initResponse.ok) {
      const err = await initResponse.text();
      throw new Error(`Error iniciando subida: ${err}`);
    }
 
    const uploadUrl = initResponse.headers.get('location');
    console.log(`🔗 URL generada para ${finalName} (${(fileSize / (1024*1024)).toFixed(1)}MB)`);
    res.json({ success: true, uploadUrl, fileName: finalName });
 
  } catch (error) {
    console.error('❌ Error:', error.message);
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
 
app.post('/webhook', (req, res) => { res.sendStatus(200); });
 
// ─── Server ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  console.log(`📁 Drive Folder ID: ${FOLDER_ID}`);
  console.log(`🔐 OAuth autorizado: ${tokens !== null}`);
});
 
