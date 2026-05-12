const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

async function getGoogleToken() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON non configuree');
  const creds = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })).toString('base64url');
  const signingInput = header + '.' + payload;
  const { createSign } = await import('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(creds.private_key, 'base64url');
  const jwt = signingInput + '.' + signature;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Token invalide: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

async function driveSearch(token, query) {
  const q = encodeURIComponent(query);
  const url = 'https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name,mimeType,webViewLink,parents)&pageSize=50';
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();
  return data.files || [];
}

// CHECK DRIVE
app.post('/api/check-drive', async (req, res) => {
  const { stock, parentId } = req.body;
  if (!stock || !parentId) return res.status(400).json({ error: 'stock et parentId requis' });
  try {
    const token = await getGoogleToken();
    const stockUpper = stock.toUpperCase();
    const stockLower = stock.toLowerCase();
    const folders = await driveSearch(token,
      "'" + parentId + "' in parents and mimeType='application/vnd.google-apps.folder' and name contains '" + stockUpper + "' and trashed=false"
    );
    if (!folders.length) {
      return res.json({ folderFound: false, folderUrl: null, carfax: false, inspection: false, estimation: false, files: [] });
    }
    const folder = folders[0];
    const files = await driveSearch(token, "'" + folder.id + "' in parents and trashed=false");
    const names = files.map(function(f) { return f.name.toLowerCase(); });
    const carfax = names.some(function(n) { return n.includes('carfax'); });
    const estimation = names.some(function(n) { return n.includes('-i') || n.endsWith('-i.pdf'); });
    const inspection = names.some(function(n) {
      const clean = n.replace('.pdf', '').toLowerCase();
      const s = stockLower;
      return clean === s || (clean.startsWith(s) && !clean.includes('carfax') && !clean.includes('-i'));
    });
    return res.json({
      folderFound: true,
      folderId: folder.id,
      folderUrl: folder.webViewLink,
      carfax: carfax,
      inspection: inspection,
      estimation: estimation,
      files: files.map(function(f) { return f.name; })
    });
  } catch (err) {
    console.error('check-drive:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// CREATE DRIVE FOLDER
app.post('/api/create-folder', async (req, res) => {
  const { stock, year, make, model, parentId } = req.body;
  if (!stock || !parentId) return res.status(400).json({ error: 'stock et parentId requis' });
  try {
    const token = await getGoogleToken();
    const stockUpper = stock.toUpperCase();
    const folderName = stockUpper + ' ' + (make || '').toUpperCase() + ' ' + (model || '').toUpperCase() + ' ' + (year || '');

    // Check if folder already exists
    const existing = await driveSearch(token,
      "'" + parentId + "' in parents and mimeType='application/vnd.google-apps.folder' and name contains '" + stockUpper + "' and trashed=false"
    );
    if (existing.length) {
      return res.json({ created: false, existed: true, folderId: existing[0].id, folderUrl: existing[0].webViewLink, folderName: existing[0].name });
    }

    // Create new folder
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
    });
    const folder = await createRes.json();
    if (!folder.id) throw new Error('Erreur création dossier: ' + JSON.stringify(folder));
    return res.json({ created: true, existed: false, folderId: folder.id, folderUrl: 'https://drive.google.com/drive/folders/' + folder.id, folderName: folderName });
  } catch (err) {
    console.error('create-folder:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// MOVE CARFAX from parent folder to vehicle folder
app.post('/api/move-carfax', async (req, res) => {
  const { stock, parentId, folderId } = req.body;
  if (!stock || !parentId || !folderId) return res.status(400).json({ error: 'stock, parentId et folderId requis' });
  try {
    const token = await getGoogleToken();
    const stockUpper = stock.toUpperCase();

    // Search for carfax in parent folder
    const files = await driveSearch(token,
      "'" + parentId + "' in parents and name contains '" + stockUpper + "' and name contains 'CARFAX' and trashed=false"
    );
    if (!files.length) {
      return res.json({ moved: false, message: 'Carfax introuvable dans le dossier parent' });
    }

    const file = files[0];
    // Move file: add new parent, remove old parent
    const moveRes = await fetch(
      'https://www.googleapis.com/drive/v3/files/' + file.id + '?addParents=' + folderId + '&removeParents=' + parentId + '&fields=id,name,parents',
      { method: 'PATCH', headers: { Authorization: 'Bearer ' + token } }
    );
    const moved = await moveRes.json();
    if (!moved.id) throw new Error('Erreur déplacement: ' + JSON.stringify(moved));
    return res.json({ moved: true, fileName: file.name, fileId: moved.id });
  } catch (err) {
    console.error('move-carfax:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// UPLOAD FILE to vehicle Drive folder
app.post('/api/upload-file', async (req, res) => {
  const { folderId, fileName, fileData, mimeType } = req.body;
  if (!folderId || !fileName || !fileData) return res.status(400).json({ error: 'folderId, fileName et fileData requis' });
  try {
    const token = await getGoogleToken();
    const fileBuffer = Buffer.from(fileData, 'base64');

    // Multipart upload to Drive
    const boundary = 'boundary_' + Date.now();
    const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
    const body = Buffer.concat([
      Buffer.from('--' + boundary + '\r\nContent-Type: application/json\r\n\r\n'),
      Buffer.from(metadata),
      Buffer.from('\r\n--' + boundary + '\r\nContent-Type: ' + (mimeType || 'application/pdf') + '\r\n\r\n'),
      fileBuffer,
      Buffer.from('\r\n--' + boundary + '--')
    ]);

    const uploadRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'multipart/related; boundary=' + boundary,
        'Content-Length': body.length
      },
      body: body
    });
    const uploaded = await uploadRes.json();
    if (!uploaded.id) throw new Error('Erreur upload: ' + JSON.stringify(uploaded));
    return res.json({ uploaded: true, fileId: uploaded.id, fileName: uploaded.name, fileUrl: uploaded.webViewLink });
  } catch (err) {
    console.error('upload-file:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// CHECK WEB
app.post('/api/check-web', async (req, res) => {
  const { stock } = req.body;
  if (!stock) return res.status(400).json({ error: 'stock requis' });
  try {
    const stockUp = stock.toUpperCase();
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const response = await fetch('https://www.hyundaistraymond.com/occasion/recherche.html', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(12000)
    });
    const buffer = await response.arrayBuffer();
    const html = new TextDecoder('iso-8859-1').decode(buffer);
    const enligne = html.includes(stockUp) || html.includes(stock);
    let photos = 0;
    let ficheUrl = null;
    if (enligne) {
      const idx1 = html.indexOf(stockUp);
      const idx2 = html.indexOf(stock);
      const idx = idx1 !== -1 ? idx1 : idx2;
      const winStart = Math.max(0, idx - 3000);
      const winEnd = Math.min(html.length, idx + 1000);
      const win = html.substring(winStart, winEnd);
      const reUrl = new RegExp('href="(/occasion/[^"]+id[0-9]+\\.html)"');
      const urlMatch = win.match(reUrl);
      if (urlMatch) {
        ficheUrl = 'https://www.hyundaistraymond.com' + urlMatch[1];
        try {
          const ficheRes = await fetch(ficheUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
          const ficheBuffer = await ficheRes.arrayBuffer();
          const ficheHtml = new TextDecoder('iso-8859-1').decode(ficheBuffer);
          const rePhoto = new RegExp('imagescdn\\.d2cmedia\\.ca/[^/]+/1918/[0-9]+/([0-9]+)/', 'g');
          const indices = new Set();
          let m;
          while ((m = rePhoto.exec(ficheHtml)) !== null) { indices.add(m[1]); }
          photos = indices.size;
          if (photos === 0) {
            const reAllImgs = new RegExp('imagescdn\\.d2cmedia\\.ca/[^"\\s]+\\.jpg', 'gi');
            const allImgs = ficheHtml.match(reAllImgs) || [];
            photos = new Set(allImgs).size;
          }
        } catch (e) { photos = 0; }
      }
    }
    return res.json({ enligne: enligne, photos: photos, ficheUrl: ficheUrl });
  } catch (err) {
    console.error('check-web:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, function() {
  console.log('Hyundai St-Raymond VO - Port ' + PORT);
});
