const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const RAPIDAPI_KEY = 'c9dea9a596msh9565df12086412fp1d11cejsnadb3d0bd41ad';
const RAPIDAPI_HOST = 'cloud-api-hub-youtube-downloader.p.rapidapi.com';

// Rotas de verificação para o cron-job
app.get('/', (req, res) => {
  res.status(200).json({ status: 'online', message: 'Servidor ativo' });
});

app.get('/api/status', (req, res) => {
  res.status(200).json({ status: 'online' });
});

// Download do corte com tamanho controlado (< 25 MB)
app.get('/api/download', async (req, res) => {
  const videoId = req.query.id;
  const start = parseInt(req.query.start || 0, 10);
  const duration = parseInt(req.query.duration || 60, 10);

  if (!videoId) {
    return res.status(400).json({ error: 'O parâmetro id do vídeo é obrigatório.' });
  }

  try {
    // 1. Obtém os links da API
    const response = await axios.get(`https://${RAPIDAPI_HOST}/download`, {
      params: { id: videoId, quality: 'lowest' },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      },
      timeout: 25000
    });

    const data = response.data;
    let fileUrl = null;

    if (Array.isArray(data?.formats) && data.formats.length > 0) {
      const formatoLeve = data.formats.find(f => f.url && !f.url.includes('ytimg.com') && (f.qualityLabel === '360p' || f.hasAudio));
      fileUrl = formatoLeve ? formatoLeve.url : data.formats[0].url;
    }

    if (!fileUrl) {
      fileUrl = data?.url || data?.download_url;
    }

    if (!fileUrl || fileUrl.includes('ytimg.com')) {
      return res.status(500).json({ error: 'Link de vídeo não encontrado.' });
    }

    // 2. Stream limitado por tamanho: corta a transmissão em ~18 MB
    // Isso garante que o arquivo baixe em 2 segundos e fique com menos de 20 MB no celular!
    const MAX_BYTES = 18 * 1024 * 1024; // 18 Megabytes max

    const streamResponse = await axios({
      method: 'GET',
      url: fileUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Range': `bytes=0-${MAX_BYTES}`
      }
    });

    res.setHeader('Content-Disposition', `attachment; filename="corte_${videoId}.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');

    streamResponse.data.pipe(res);

  } catch (error) {
    console.error('Erro no download:', error.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Falha ao processar download.',
        details: error.response?.data || error.message
      });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});
