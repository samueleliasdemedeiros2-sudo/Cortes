const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const RAPIDAPI_KEY = 'c9dea9a596msh9565df12086412fp1d11cejsnadb3d0bd41ad';
const RAPIDAPI_HOST = 'cloud-api-hub-youtube-downloader.p.rapidapi.com';

// Rotas de verificação de estado (Health Check)
app.get('/', (req, res) => {
  res.status(200).json({ status: 'online', message: 'Servidor ativo' });
});

app.get('/api/status', (req, res) => {
  res.status(200).json({ status: 'online' });
});

// Rota para processar e descarregar o vídeo
app.get('/api/download', async (req, res) => {
  const videoId = req.query.id;

  if (!videoId) {
    return res.status(400).json({ error: 'O parâmetro id do vídeo é obrigatório.' });
  }

  try {
    // 1. Consulta com os parâmetros validados no teste da RapidAPI
    const response = await axios.get(`https://${RAPIDAPI_HOST}/download`, {
      params: {
        id: videoId,
        quality: 'lowest'
      },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      },
      timeout: 30000
    });

    const data = response.data;

    // 2. Extração do link direto descartando miniaturas/storyboard (ytimg.com)
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

    // 3. Redireciona diretamente para o link de transferência do telemóvel
    return res.redirect(fileUrl);

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
