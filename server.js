const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const RAPIDAPI_KEY = 'c9dea9a596msh9565df12086412fp1d11cejsnadb3d0bd41ad';
const RAPIDAPI_HOST = 'cloud-api-hub-youtube-downloader.p.rapidapi.com';

// Rota para processar e descarregar o vídeo/corte
app.get('/api/download', async (req, res) => {
  const videoId = req.query.id;

  if (!videoId) {
    return res.status(400).json({ error: 'O parâmetro id do vídeo é obrigatório.' });
  }

  try {
    // 1. Consulta a Cloud API Hub configurada com áudio e vídeo juntos
    const response = await axios.get(`https://${RAPIDAPI_HOST}/download`, {
      params: {
        id: videoId,
        quality: 'highest',
        filter: 'audioandvideo'
      },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      },
      timeout: 30000
    });

    const data = response.data;

    // 2. Extrai o link direto ignorando miniaturas/storyboard (ytimg.com)
    let fileUrl = null;
    if (data?.url && !data.url.includes('ytimg.com')) {
      fileUrl = data.url;
    } else if (data?.download_url && !data.download_url.includes('ytimg.com')) {
      fileUrl = data.download_url;
    } else if (Array.isArray(data?.formats)) {
      const formatoCompleto = data.formats.find(f => f.hasAudio && f.hasVideo && !f.url?.includes('ytimg.com')) || data.formats[0];
      fileUrl = formatoCompleto?.url;
    }

    if (!fileUrl) {
      return res.status(500).json({ error: 'A API não forneceu um link válido para o vídeo.' });
    }

    // 3. Faz o stream do arquivo direto para o usuário (força download do mp4 no celular)
    const streamResponse = await axios({
      method: 'GET',
      url: fileUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    res.setHeader('Content-Disposition', `attachment; filename="corte_${videoId}.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');

    streamResponse.data.pipe(res);

  } catch (error) {
    console.error('Erro ao processar o descarregamento:', error.message);
    res.status(500).json({
      error: 'Não foi possível descarregar o vídeo.',
      details: error.response?.data || error.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor a correr na porta ${PORT}`);
});
