const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const RAPIDAPI_KEY = 'c9dea9a596msh9565df12086412fp1d11cejsnadb3d0bd41ad';
const RAPIDAPI_HOST = 'cloud-api-hub-youtube-downloader.p.rapidapi.com';

// Health Check
app.get('/', (req, res) => {
  res.status(200).json({ status: 'online', message: 'Servidor ativo' });
});

app.get('/api/status', (req, res) => {
  res.status(200).json({ status: 'online' });
});

// Rota otimizada de alta velocidade para o download
app.get('/api/download', async (req, res) => {
  const videoId = req.query.id;

  if (!videoId) {
    return res.status(400).json({ error: 'O parâmetro id do vídeo é obrigatório.' });
  }

  try {
    // 1. Consulta com timeout rápido
    const response = await axios.get(`https://${RAPIDAPI_HOST}/download`, {
      params: {
        id: videoId,
        quality: 'lowest' // Mantém o formato mais leve e rápido de puxar
      },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      },
      timeout: 20000
    });

    const data = response.data;

    let fileUrl = null;
    if (data?.url && !data.url.includes('ytimg.com')) {
      fileUrl = data.url;
    } else if (data?.download_url && !data.download_url.includes('ytimg.com')) {
      fileUrl = data.download_url;
    } else if (Array.isArray(data?.formats)) {
      const formatoValido = data.formats.find(f => f.url && !f.url.includes('ytimg.com'));
      fileUrl = formatoValido?.url;
    }

    if (!fileUrl) {
      return res.status(500).json({
        error: 'A API não forneceu um link válido para o vídeo.',
        apiResponse: data
      });
    }

    // 2. Stream turbo com cabeçalhos que desbloqueiam a velocidade do YouTube
    const stream = await axios({
      method: 'GET',
      url: fileUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Connection': 'keep-alive'
      }
    });

    // Repassa os tamanhos e headers para o celular baixar acelerado
    res.setHeader('Content-Disposition', `attachment; filename="corte_${videoId}.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');
    if (stream.headers['content-length']) {
      res.setHeader('Content-Length', stream.headers['content-length']);
    }

    // Conecta a transmissão sem travar memória
    stream.data.pipe(res);

  } catch (error) {
    console.error('Erro no download:', error.message);
    res.status(500).json({
      error: 'Erro na velocidade de transferência.',
      details: error.response?.data || error.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor a correr na porta ${PORT}`);
});
