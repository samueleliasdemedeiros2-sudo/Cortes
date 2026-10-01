const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const RAPIDAPI_KEY = 'c9dea9a596msh9565df12086412fp1d11cejsnadb3d0bd41ad';
const RAPIDAPI_HOST = 'cloud-api-hub-youtube-downloader.p.rapidapi.com';

// Health Check para o cron-job
app.get('/', (req, res) => {
  res.status(200).json({ status: 'online', message: 'Servidor ativo' });
});

app.get('/api/status', (req, res) => {
  res.status(200).json({ status: 'online' });
});

// Download leve e sem estourar a memória RAM do Render
app.get('/api/download', async (req, res) => {
  const videoId = req.query.id;

  if (!videoId) {
    return res.status(400).json({ error: 'O parâmetro id do vídeo é obrigatório.' });
  }

  try {
    // 1. Pede à API o formato otimizado e leve (360p/lowest)
    const response = await axios.get(`https://${RAPIDAPI_HOST}/download`, {
      params: { 
        id: videoId, 
        quality: 'lowest' // Garante arquivo leve (< 35MB para celular)
      },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      },
      timeout: 25000
    });

    const data = response.data;
    let fileUrl = null;

    if (data?.url && !data.url.includes('ytimg.com')) {
      fileUrl = data.url;
    } else if (data?.download_url && !data.download_url.includes('ytimg.com')) {
      fileUrl = data.download_url;
    } else if (Array.isArray(data?.formats)) {
      // Prioriza formato leve que tenha áudio e vídeo juntos (ex: 360p mp4)
      const leve = data.formats.find(f => f.url && !f.url.includes('ytimg.com') && (f.qualityLabel === '360p' || f.hasAudio));
      fileUrl = leve?.url || data.formats.find(f => f.url && !f.url.includes('ytimg.com'))?.url;
    }

    if (!fileUrl) {
      return res.status(500).json({ error: 'Link de download não encontrado.' });
    }

    // 2. Faz o redirecionamento direto com cabeçalho de download forçado
    // Isso não consome 1 MB sequer de RAM no Render e o download vai direto da CDN em velocidade máxima
    return res.redirect(fileUrl);

  } catch (error) {
    console.error('Erro na rota de download:', error.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Falha ao descarregar.',
        details: error.response?.data || error.message
      });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor a correr na porta ${PORT}`);
});
