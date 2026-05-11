const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.post('/api/check-drive', async (req, res) => {
  const { stock, parentId } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurée' });
  }
  if (!stock || !parentId) {
    return res.status(400).json({ error: 'stock et parentId requis' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'mcp-client-2025-04-04'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        mcp_servers: [{
          type: 'url',
          url: 'https://drivemcp.googleapis.com/mcp/v1',
          name: 'google-drive'
        }],
        messages: [{
          role: 'user',
          content: `Cherche dans Google Drive le dossier dont le titre commence par "${stock}" dans le dossier parent ID "${parentId}". Liste ses fichiers. Réponds UNIQUEMENT en JSON sans markdown: {"folderFound":bool,"folderUrl":"url ou null","carfax":bool,"inspection":bool,"estimation":bool}`
        }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(502).json({ error: 'Erreur API Anthropic', detail: data });
    }

    const txt = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const match = txt.match(/\{[\s\S]*?\}/);
    if (match) {
      try {
        return res.json(JSON.parse(match[0]));
      } catch (e) {
        return res.status(502).json({ error: 'Réponse JSON invalide', raw: txt });
      }
    }
    return res.status(502).json({ error: 'Aucun JSON dans la réponse', raw: txt });

  } catch (err) {
    console.error('Erreur /api/check-drive:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Hyundai St-Raymond VO — Port ${PORT}`);
});
