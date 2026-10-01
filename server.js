const express = require('express');
const axios = require('axios');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

// Define o caminho do FFmpeg
ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
app.use(cors());
app.use(express.json());

const RAPIDAPI_KEY = 'c9dea9a596msh9565df12086412fp1d11cejsnadb3d0bd41ad';
const RAPIDAPI_HOST = 'cloud-api-hub-youtube-downloader.p.rapidapi.com';

// Rotas de verificação para o cron-job manter o serviço ativo
app.get('/', (req, res) => {
  res.status(200).json({ status: 'online', message: 'Servidor ativo' });
});

app.get('/api/status', (req, res) => {
  res.status(200).json({ status: 'online' });
});

// Rota que gera cortes com tamanho reduzido (< 20 MB garantidos)
app.get('/api/download', async (req, res) => {
  const videoId = req.query.id;
  const startSeconds = parseInt(req.query.start || 0, 10);
  const duration = parseInt(req.query.duration || 30, 10); // Duração padrão do corte: 30 a 60s

  if (!videoId) {
    return res.status(400).json({ error: 'O parâmetro id do vídeo é obrigatório.' });
  }

  try {
    // 1. Obtém o stream fonte
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

    if (data?.url && !data.url.includes('ytimg.com')) {
      fileUrl = data.url;
    } else if (data?.download_url && !data.download_url.includes('ytimg.com')) {
      fileUrl = data.download_url;
    } else if (Array.isArray(data?.formats)) {
      const formatoValido = data.formats.find(f => f.url && !f.url.includes('ytimg.com'));
      fileUrl = formatoValido?.url;
    }

    if (!fileUrl) {
      return res.status(500).json({ error: 'Não foi possível obter o link do vídeo.' });
    }

    res.setHeader('Content-Disposition', `attachment; filename="corte_${videoId}_${startSeconds}s.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');

    // 2. FFmpeg configurado para salto rápido e compressão leve para telemóvel
    ffmpeg(fileUrl)
      .inputOptions([
        `-ss ${startSeconds}` // Salta direto para o corte antes de ler a stream
      ])
      .duration(duration)
      .videoCodec('libx264')
      .size('?x720') // Limita a resolução máxima vertical/HD sem distorcer
      .outputOptions([
        '-preset ultrafast',
        '-b:v 1500k',       // Trava a taxa de dados: 60s = ~11 MB
        '-maxrate 2000k',
        '-bufsize 3000k',
        '-c:a aac',
        '-b:a 128k',
        '-movflags frag_keyframe+empty_moov'
      ])
      .format('mp4')
      .on('error', (err) => {
        console.error('Erro FFmpeg:', err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Erro ao processar corte leve.' });
        }
      })
      .pipe(res, { end: true });

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
  console.log(`Servidor de cortes a correr na porta ${PORT}`);
});
