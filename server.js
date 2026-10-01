const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Variáveis de ambiente ou valores padrão de fallback
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'c9dea9a596msh9565df12086412fp1d11cejsnadb3d0bd41ad';
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'cloud-api-hub-youtube-downloader.p.rapidapi.com';

// 1. Rotas de Health Check (mantêm o Render acordado 24/7 com o cron-job.org)
app.get('/', (req, res) => {
  res.status(200).json({ 
    status: 'online', 
    version: '1.0.1', 
    message: 'Servidor ClipForge ativo e pronto' 
  });
});

app.get('/api/status', (req, res) => {
  res.status(200).json({ 
    status: 'online', 
    version: '1.0.1' 
  });
});

// 2. Rota de download otimizada (corte leve < 20 MB)
app.get('/api/download', async (req, res) => {
  const videoId = req.query.id;
  const start = parseInt(req.query.start || 0, 10);
  const duration = parseInt(req.query.duration || 60, 10);

  if (!videoId) {
    return res.status(400).json({ error: 'O parâmetro id do vídeo é obrigatório.' });
  }

  try {
    // Consulta a API buscando o formato mais leve
    const response = await axios.get(`https://${RAPIDAPI_HOST}/download`, {
      params: { 
        id: videoId, 
        quality: 'lowest' 
      },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      },
      timeout: 25000
    });

    const data = response.data;
    let fileUrl = null;

    // Prioriza formatos leves em vídeo + áudio (360p mobile)
    if (Array.isArray(data?.formats) && data.formats.length > 0) {
      const formatoLeve = data.formats.find(f => 
        f.url && 
        !f.url.includes('ytimg.com') && 
        (f.qualityLabel === '360p' || f.hasAudio)
      );
      fileUrl = formatoLeve ? formatoLeve.url : data.formats[0].url;
    }

    if (!fileUrl) {
      fileUrl = data?.url || data?.download_url;
    }

    if (!fileUrl || fileUrl.includes('ytimg.com')) {
      return res.status(500).json({ error: 'Link de mídia não disponível.' });
    }

    // Limita o corte em ~18 MB (baixa em segundos no 4G/Wi-Fi sem travar o Render)
    const MAX_BYTES = 18 * 1024 * 1024;

    const streamResponse = await axios({
      method: 'GET',
      url: fileUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Range': `bytes=0-${MAX_BYTES}`
      }
    });

    res.setHeader('Content-Disposition', `attachment; filename="corte_${videoId}_${start}s.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');

    // Conecta a transmissão direto ao cliente
    streamResponse.data.pipe(res);

  } catch (error) {
    console.error('Erro na rota de download:', error.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Falha ao descarregar corte.',
        details: error.response?.data || error.message
      });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ClipForge Server v1.0.1 a rodar na porta ${PORT}`);
});
