const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

// PostgreSQL connection
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Initialize database table
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vehicles (
        id SERIAL PRIMARY KEY,
        stock VARCHAR(50) UNIQUE NOT NULL,
        year INTEGER,
        make VARCHAR(100),
        model VARCHAR(200),
        km INTEGER,
        price INTEGER,
        color VARCHAR(100),
        resp VARCHAR(200),
        opts JSONB DEFAULT '{}',
        sd JSONB DEFAULT '[]',
        docs JSONB DEFAULT '{}',
        expanded BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('DB ready');
  } catch (err) {
    console.error('DB init error:', err.message);
  }
}
initDB();

// GET all vehicles
app.get('/api/vehicles', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vehicles ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('GET vehicles:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST create vehicle
app.post('/api/vehicles', async (req, res) => {
  const { stock, year, make, model, km, price, color, resp, opts, sd, docs, expanded } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO vehicles (stock, year, make, model, km, price, color, resp, opts, sd, docs, expanded)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (stock) DO UPDATE SET updated_at=NOW()
       RETURNING *`,
      [stock, year, make, model, km, price, color||'', resp, JSON.stringify(opts||{}), JSON.stringify(sd||[]), JSON.stringify(docs||{}), expanded||false]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('POST vehicle:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH update vehicle
app.patch('/api/vehicles/:stock', async (req, res) => {
  const { stock } = req.params;
  const { sd, docs, expanded, opts } = req.body;
  try {
    const fields = [];
    const values = [];
    let i = 1;
    if (sd !== undefined) { fields.push('sd=$' + i++); values.push(JSON.stringify(sd)); }
    if (docs !== undefined) { fields.push('docs=$' + i++); values.push(JSON.stringify(docs)); }
    if (expanded !== undefined) { fields.push('expanded=$' + i++); values.push(expanded); }
    if (opts !== undefined) { fields.push('opts=$' + i++); values.push(JSON.stringify(opts)); }
    fields.push('updated_at=NOW()');
    values.push(stock);
    const result = await pool.query(
      'UPDATE vehicles SET ' + fields.join(',') + ' WHERE stock=$' + i + ' RETURNING *',
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Véhicule introuvable' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH vehicle:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE vehicle
app.delete('/api/vehicles/:stock', async (req, res) => {
  try {
    await pool.query('DELETE FROM vehicles WHERE stock=$1', [req.params.stock]);
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE vehicle:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GOOGLE DRIVE
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
    iat: now, exp: now + 3600
  })).toString('base64url');
  const signingInput = header + '.' + payload;
  const { createSign } = await import('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const jwt = signingInput + '.' + sign.sign(creds.private_key, 'base64url');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Token invalide: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

async function driveSearch(token, query) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(query) + '&fields=files(id,name,mimeType,webViewLink,parents)&pageSize=50',
    { headers: { Authorization: 'Bearer ' + token } });
  return (await res.json()).files || [];
}

app.post('/api/check-drive', async (req, res) => {
  const { stock, parentId } = req.body;
  if (!stock || !parentId) return res.status(400).json({ error: 'stock et parentId requis' });
  try {
    const token = await getGoogleToken();
    const stockUpper = stock.toUpperCase();
    const stockLower = stock.toLowerCase();
    const folders = await driveSearch(token, "'" + parentId + "' in parents and mimeType='application/vnd.google-apps.folder' and name contains '" + stockUpper + "' and trashed=false");
    if (!folders.length) return res.json({ folderFound: false, folderUrl: null, carfax: false, inspection: false, estimation: false, files: [] });
    const folder = folders[0];
    const files = await driveSearch(token, "'" + folder.id + "' in parents and trashed=false");
    const names = files.map(function(f) { return f.name.toLowerCase(); });
    const carfax = names.some(function(n) { return n.includes('carfax'); });
    const estimation = names.some(function(n) { return n.includes('-i') || n.endsWith('-i.pdf'); });
    const inspection = names.some(function(n) {
      const clean = n.replace('.pdf','').toLowerCase();
      return clean === stockLower || (clean.startsWith(stockLower) && !clean.includes('carfax') && !clean.includes('-i'));
    });
    return res.json({ folderFound: true, folderId: folder.id, folderUrl: folder.webViewLink, carfax: carfax, inspection: inspection, estimation: estimation, files: files.map(function(f){return f.name;}) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/create-folder', async (req, res) => {
  const { stock, year, make, model, parentId } = req.body;
  if (!stock || !parentId) return res.status(400).json({ error: 'stock et parentId requis' });
  try {
    const token = await getGoogleToken();
    const stockUpper = stock.toUpperCase();
    const folderName = stockUpper + ' ' + (make||'').toUpperCase() + ' ' + (model||'').toUpperCase() + ' ' + (year||'');
    const existing = await driveSearch(token, "'" + parentId + "' in parents and mimeType='application/vnd.google-apps.folder' and name contains '" + stockUpper + "' and trashed=false");
    if (existing.length) return res.json({ created: false, existed: true, folderId: existing[0].id, folderUrl: existing[0].webViewLink, folderName: existing[0].name });
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
    });
    const folder = await createRes.json();
    if (!folder.id) throw new Error('Erreur creation: ' + JSON.stringify(folder));
    return res.json({ created: true, existed: false, folderId: folder.id, folderUrl: 'https://drive.google.com/drive/folders/' + folder.id, folderName: folderName });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/move-carfax', async (req, res) => {
  const { stock, parentId, folderId } = req.body;
  if (!stock || !parentId || !folderId) return res.status(400).json({ error: 'stock, parentId et folderId requis' });
  try {
    const token = await getGoogleToken();
    const files = await driveSearch(token, "'" + parentId + "' in parents and name contains '" + stock.toUpperCase() + "' and name contains 'CARFAX' and trashed=false");
    if (!files.length) return res.json({ moved: false, message: 'Carfax introuvable dans le dossier parent' });
    const file = files[0];
    const moveRes = await fetch('https://www.googleapis.com/drive/v3/files/' + file.id + '?addParents=' + folderId + '&removeParents=' + parentId + '&fields=id,name',
      { method: 'PATCH', headers: { Authorization: 'Bearer ' + token } });
    const moved = await moveRes.json();
    if (!moved.id) throw new Error('Erreur deplacement: ' + JSON.stringify(moved));
    return res.json({ moved: true, fileName: file.name, fileId: moved.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/upload-file', async (req, res) => {
  const { folderId, fileName, fileData, mimeType } = req.body;
  if (!folderId || !fileName || !fileData) return res.status(400).json({ error: 'folderId, fileName et fileData requis' });
  try {
    const token = await getGoogleToken();
    const fileBuffer = Buffer.from(fileData, 'base64');
    const boundary = 'boundary_' + Date.now();
    const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
    const body = Buffer.concat([
      Buffer.from('--' + boundary + '\r\nContent-Type: application/json\r\n\r\n'),
      Buffer.from(metadata),
      Buffer.from('\r\n--' + boundary + '\r\nContent-Type: ' + (mimeType||'application/pdf') + '\r\n\r\n'),
      fileBuffer,
      Buffer.from('\r\n--' + boundary + '--')
    ]);
    const uploadRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary, 'Content-Length': body.length },
      body: body
    });
    const uploaded = await uploadRes.json();
    if (!uploaded.id) throw new Error('Erreur upload: ' + JSON.stringify(uploaded));
    return res.json({ uploaded: true, fileId: uploaded.id, fileName: uploaded.name, fileUrl: uploaded.webViewLink });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/check-web', async (req, res) => {
  const { stock } = req.body;
  if (!stock) return res.status(400).json({ error: 'stock requis' });
  try {
    const stockUp = stock.toUpperCase();
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const response = await fetch('https://www.hyundaistraymond.com/occasion/recherche.html', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    const html = new TextDecoder('iso-8859-1').decode(await response.arrayBuffer());
    const enligne = html.includes(stockUp) || html.includes(stock);
    let photos = 0, ficheUrl = null;
    if (enligne) {
      const idx = html.indexOf(stockUp) !== -1 ? html.indexOf(stockUp) : html.indexOf(stock);
      const win = html.substring(Math.max(0, idx-3000), Math.min(html.length, idx+1000));
      const urlMatch = win.match(new RegExp('href="(/occasion/[^"]+id[0-9]+\\.html)"'));
      if (urlMatch) {
        ficheUrl = 'https://www.hyundaistraymond.com' + urlMatch[1];
        try {
          const ficheHtml = new TextDecoder('iso-8859-1').decode(await (await fetch(ficheUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) })).arrayBuffer());
          const rePhoto = new RegExp('imagescdn\\.d2cmedia\\.ca/[^/]+/1918/[0-9]+/([0-9]+)/', 'g');
          const indices = new Set(); let m;
          while ((m = rePhoto.exec(ficheHtml)) !== null) { indices.add(m[1]); }
          photos = indices.size || new Set((ficheHtml.match(new RegExp('imagescdn\\.d2cmedia\\.ca/[^"\\s]+\\.jpg', 'gi')) || [])).size;
        } catch(e) {}
      }
    }
    return res.json({ enligne: enligne, photos: photos, ficheUrl: ficheUrl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('*', function(req, res) { res.sendFile(path.join(__dirname, 'index.html')); });
app.listen(PORT, function() { console.log('Hyundai St-Raymond VO - Port ' + PORT); });
