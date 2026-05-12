const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

const poolConfig = { connectionString: process.env.DATABASE_URL };
if (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')) {
  poolConfig.ssl = { rejectUnauthorized: false };
} else if (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('postgres')) {
  poolConfig.ssl = { rejectUnauthorized: false };
}
const pool = new Pool(poolConfig);

const TEAM_EMAILS = {
  'Etienne Plamondon': 'eplamondon@hyundaistraymond.ca',
  'Serge Grenier': 'serge.grenier@hyundaistraymond.ca',
  'Nicolas Rivard': 'nrivard@hyundaistraymond.ca',
  'Martin Napier': 'livraison@hyundaistraymond.ca',
  'Nicolas Fiset': 'autofiset@outlook.com',
  'Charles Boivin': 'charles.boivin@hyundaistraymond.ca',
  'Vincent Bouchard': 'vbouchard@hyundaistraymond.ca',
};

async function initDB() {
  let retries = 5;
  while (retries > 0) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS vehicles (
          id SERIAL PRIMARY KEY,
          stock VARCHAR(50) UNIQUE NOT NULL,
          year INTEGER, make VARCHAR(100), model VARCHAR(200),
          km INTEGER, price INTEGER, color VARCHAR(100), resp VARCHAR(200),
          opts JSONB DEFAULT '{}', sd JSONB DEFAULT '[]', docs JSONB DEFAULT '{}',
          expanded BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS comments (
          id SERIAL PRIMARY KEY,
          stock VARCHAR(50) NOT NULL,
          step_id VARCHAR(100),
          author VARCHAR(200),
          message TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      console.log('DB ready');
      return;
    } catch (err) {
      retries--;
      console.error('DB init error (retries left: '+retries+'):', err.message, err.code);
      if (retries > 0) await new Promise(r => setTimeout(r, 3000));
    }
  }
}
initDB();

// HEALTH CHECK
app.get('/api/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT NOW() as time, current_database() as db');
    res.json({ ok: true, time: r.rows[0].time, db: r.rows[0].db });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// VEHICLES CRUD
app.get('/api/vehicles', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vehicles ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/vehicles', async (req, res) => {
  const { stock, year, make, model, km, price, color, resp, opts, sd, docs, expanded } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO vehicles (stock,year,make,model,km,price,color,resp,opts,sd,docs,expanded)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (stock) DO UPDATE SET updated_at=NOW() RETURNING *`,
      [stock,year,make,model,km,price,color||'',resp,JSON.stringify(opts||{}),JSON.stringify(sd||[]),JSON.stringify(docs||{}),expanded||false]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/vehicles/:stock', async (req, res) => {
  const { stock } = req.params;
  const { sd, docs, expanded, opts } = req.body;
  try {
    const fields = [], values = [];
    let i = 1;
    if (sd !== undefined) { fields.push('sd=$'+i++); values.push(JSON.stringify(sd)); }
    if (docs !== undefined) { fields.push('docs=$'+i++); values.push(JSON.stringify(docs)); }
    if (expanded !== undefined) { fields.push('expanded=$'+i++); values.push(expanded); }
    if (opts !== undefined) { fields.push('opts=$'+i++); values.push(JSON.stringify(opts)); }
    fields.push('updated_at=NOW()');
    values.push(stock);
    const result = await pool.query('UPDATE vehicles SET '+fields.join(',')+' WHERE stock=$'+i+' RETURNING *', values);
    if (!result.rows.length) return res.status(404).json({ error: 'Introuvable' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/vehicles/:stock', async (req, res) => {
  try {
    await pool.query('DELETE FROM vehicles WHERE stock=$1', [req.params.stock]);
    await pool.query('DELETE FROM comments WHERE stock=$1', [req.params.stock]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// COMMENTS
app.get('/api/comments/:stock', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM comments WHERE stock=$1 ORDER BY created_at ASC', [req.params.stock]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/comments', async (req, res) => {
  const { stock, stepId, author, message } = req.body;
  if (!stock || !message) return res.status(400).json({ error: 'stock et message requis' });
  try {
    const result = await pool.query(
      'INSERT INTO comments (stock,step_id,author,message) VALUES ($1,$2,$3,$4) RETURNING *',
      [stock, stepId||null, author||'Inconnu', message]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEND EMAIL via Microsoft 365 Graph API (HTTP - no SMTP port needed)
app.post('/api/notify', async (req, res) => {
  const { to, subject, html } = req.body;
  if (!to) return res.status(400).json({ error: 'Destinataire requis' });
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  const tenantId = process.env.MS_TENANT_ID;
  if (!clientId || !clientSecret || !tenantId) {
    // Fallback: Brevo API
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Configuration email manquante' });
    try {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'accept': 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          sender: { name: 'Hyundai St-Raymond VO', email: 'hyundaistraymondusages@gmail.com' },
          to: [{ email: to }],
          subject: subject || 'Notification — Mise en marché VO',
          htmlContent: html
        })
      });
      const data = await r.json();
      if (data.messageId) return res.json({ sent: true, id: data.messageId });
      return res.status(502).json({ error: 'Erreur Brevo', detail: data });
    } catch (err) { return res.status(502).json({ error: err.message }); }
  }
  try {
    // Get access token from Microsoft
    const tokenRes = await fetch('https://login.microsoftonline.com/' + tenantId + '/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('Token Microsoft invalide: ' + JSON.stringify(tokenData));

    // Send email via Graph API
    const sendRes = await fetch('https://graph.microsoft.com/v1.0/users/' + process.env.O365_EMAIL + '/sendMail', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tokenData.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: subject || 'Notification — Mise en marché VO',
          body: { contentType: 'HTML', content: html },
          toRecipients: [{ emailAddress: { address: to } }]
        }
      })
    });
    if (sendRes.status === 202) {
      res.json({ sent: true, id: 'graph-' + Date.now() });
    } else {
      const err = await sendRes.json();
      res.status(502).json({ error: 'Erreur Graph API', detail: err });
    }
  } catch (err) {
    console.error('Graph API error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// GOOGLE DRIVE
async function getGoogleToken() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON non configuree');
  const creds = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: creds.client_email, scope: 'https://www.googleapis.com/auth/drive', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })).toString('base64url');
  const signingInput = header + '.' + payload;
  const { createSign } = await import('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const jwt = signingInput + '.' + sign.sign(creds.private_key, 'base64url');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
  const d = await tokenRes.json();
  if (!d.access_token) throw new Error('Token invalide: ' + JSON.stringify(d));
  return d.access_token;
}

async function driveSearch(token, query) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(query) + '&fields=files(id,name,mimeType,webViewLink,parents)&pageSize=50', { headers: { Authorization: 'Bearer ' + token } });
  return (await res.json()).files || [];
}

app.post('/api/check-drive', async (req, res) => {
  const { stock, parentId } = req.body;
  if (!stock || !parentId) return res.status(400).json({ error: 'stock et parentId requis' });
  try {
    const token = await getGoogleToken();
    const sU = stock.toUpperCase(), sL = stock.toLowerCase();
    const folders = await driveSearch(token, "'"+parentId+"' in parents and mimeType='application/vnd.google-apps.folder' and name contains '"+sU+"' and trashed=false");
    if (!folders.length) return res.json({ folderFound: false, folderUrl: null, carfax: false, inspection: false, estimation: false, files: [] });
    const folder = folders[0];
    const files = await driveSearch(token, "'"+folder.id+"' in parents and trashed=false");
    const names = files.map(function(f){return f.name.toLowerCase();});
    return res.json({ folderFound: true, folderId: folder.id, folderUrl: folder.webViewLink,
      carfax: names.some(function(n){return n.includes('carfax');}),
      estimation: names.some(function(n){return n.includes('-i')||n.endsWith('-i.pdf');}),
      inspection: names.some(function(n){const c=n.replace('.pdf','');return c===sL||(c.startsWith(sL)&&!c.includes('carfax')&&!c.includes('-i'));}),
      files: files.map(function(f){return f.name;}) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/create-folder', async (req, res) => {
  const { stock, year, make, model, parentId } = req.body;
  if (!stock || !parentId) return res.status(400).json({ error: 'stock et parentId requis' });
  try {
    const token = await getGoogleToken();
    const sU = stock.toUpperCase();
    const folderName = sU + ' ' + (make||'').toUpperCase() + ' ' + (model||'').toUpperCase() + ' ' + (year||'');
    const existing = await driveSearch(token, "'"+parentId+"' in parents and mimeType='application/vnd.google-apps.folder' and name contains '"+sU+"' and trashed=false");
    if (existing.length) return res.json({ created: false, existed: true, folderId: existing[0].id, folderUrl: existing[0].webViewLink, folderName: existing[0].name });
    const r = await fetch('https://www.googleapis.com/drive/v3/files', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }) });
    const folder = await r.json();
    if (!folder.id) throw new Error('Erreur creation: ' + JSON.stringify(folder));
    return res.json({ created: true, existed: false, folderId: folder.id, folderUrl: 'https://drive.google.com/drive/folders/' + folder.id, folderName: folderName });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/move-carfax', async (req, res) => {
  const { stock, parentId, folderId } = req.body;
  if (!stock || !parentId || !folderId) return res.status(400).json({ error: 'stock, parentId et folderId requis' });
  try {
    const token = await getGoogleToken();
    const files = await driveSearch(token, "'"+parentId+"' in parents and name contains '"+stock.toUpperCase()+"' and name contains 'CARFAX' and trashed=false");
    if (!files.length) return res.json({ moved: false, message: 'Carfax introuvable dans le dossier parent' });
    const file = files[0];
    const r = await fetch('https://www.googleapis.com/drive/v3/files/'+file.id+'?addParents='+folderId+'&removeParents='+parentId+'&fields=id,name', { method: 'PATCH', headers: { Authorization: 'Bearer ' + token } });
    const moved = await r.json();
    if (!moved.id) throw new Error('Erreur: ' + JSON.stringify(moved));
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
    const body = Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Type: application/json\r\n\r\n'), Buffer.from(metadata), Buffer.from('\r\n--'+boundary+'\r\nContent-Type: '+(mimeType||'application/pdf')+'\r\n\r\n'), fileBuffer, Buffer.from('\r\n--'+boundary+'--')]);
    const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary='+boundary, 'Content-Length': body.length }, body: body });
    const uploaded = await r.json();
    if (!uploaded.id) throw new Error('Erreur upload: ' + JSON.stringify(uploaded));
    return res.json({ uploaded: true, fileId: uploaded.id, fileName: uploaded.name, fileUrl: uploaded.webViewLink });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/check-web', async (req, res) => {
  const { stock } = req.body;
  if (!stock) return res.status(400).json({ error: 'stock requis' });
  try {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const invRes = await fetch('https://www.hyundaistraymond.com/js/json/chatboost/inventory/inventory-index.json', {
      headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000)
    });
    const inventory = await invRes.json();
    const vehicle = inventory.find(function(v) {
      return (v['stock number'] || '').toUpperCase() === stock.toUpperCase();
    });
    if (!vehicle) return res.json({ enligne: false, photos: 0, ficheUrl: null });

    const d2cId = vehicle['D2C Vehicle ID'];
    const ficheUrl = (vehicle['Vehicle Details Page (VDP)'] || '').replace('/used/', '/occasion/') || null;
    let photos = 0;

    // Get token from main picture
    const mainPic = vehicle['main picture'] || '';
    const tokenMatch = mainPic.match(new RegExp('imagescdn\.d2cmedia\.ca\/([^\/]+)\/1918\/'));
    const token = tokenMatch ? tokenMatch[1] : null;

    if (token && d2cId) {
      const make = (vehicle.make || '').replace(/ /g,'_');
      const model = (vehicle.model || '').replace(/ /g,'_');
      const year = vehicle.year || '';
      let i = 1, found = true;
      while (found && i <= 60) {
        try {
          const url = 'https://imagescdn.d2cmedia.ca/' + token + '/1918/' + d2cId + '/' + i + '/' + make + '-' + model + '-' + year + '.jpg';
          const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
          if (r.status === 200) { photos = i; i++; } else { found = false; }
        } catch(e) { found = false; }
      }
    }

    return res.json({ enligne: true, photos: photos, ficheUrl: ficheUrl, d2cId: d2cId, token: token });
  } catch (err) {
    console.error('check-web:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', function(req, res) { res.sendFile(path.join(__dirname, 'index.html')); });
app.listen(PORT, function() { console.log('Hyundai St-Raymond VO - Port ' + PORT); });
