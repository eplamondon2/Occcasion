const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

async function getGoogleToken() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON non configurée');
  const creds = JSON.parse(raw);

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })).toString('base64url');

  const signingInput = `${header}.${payload}`;
  const privateKey = creds.private_key;

  const { createSign } = await import('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(privateKey, 'base64url');
  const jwt = `${signingInput}.${signature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Token Google invalide: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

async function driveSearch(token, query) {
  const q = encodeURIComponent(query);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,webViewLink)&pageSize=50`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
}

app.post('/api/check-drive', async (req, res) => {
  const { stock, parentId } = req.body;
  if (!stock || !parentId) return res.status(400).json({ error: 'stock et parentId requis' });

  try {
    const token = await getGoogleToken();
    const stockUpper = stock.toUpperCase();
    const stockLower = stock.toLowerCase();

    const folders = await driveSearch(token,
      `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and name contains '${stockUpper}' and trashed=false`
    );

    if (!folders.length) {
      return res.json({ folderFound: false, folderUrl: null, carfax: false, inspection: false, estimation: false, files: [] });
    }

    const folder = folders[0];
    const files = await driveSearch(token,
      `'${folder.id}' in parents and trashed=false`
    );

    const names = files.map(f => f.name.toLowerCase());
    const carfax = names.some(n => n.includes('carfax'));
    const estimation = names.some(n => n.includes('-i') || n.endsWith('-i.pdf'));
    const inspection = names.some(n => {
      const clean = n.replace('.pdf','').toLowerCase();
      const s = stockLower;
      return clean === s || (clean.startsWith(s) && !clean.includes('carfax') && !clean.includes('-i'));
    });

    return res.json({
      folderFound: true,
      folderUrl: folder.webViewLink,
      carfax,
      inspection,
      estimation,
      files: files.map(f => f.name)
    });

  } catch (err) {
    console.error('Erreur /api/check-drive:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Hyundai St-Raymond VO — Port ${PORT}`);
});
