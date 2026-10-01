// Rota que recorta ESTRITAMENTE o pedaço do corte gerado pela IA
app.get('/api/download', async (req, res) => {
  const videoId = req.query.id;
  const start = parseInt(req.query.start || 0, 10);      // Segundo inicial do corte
  const duration = parseInt(req.query.duration || 60, 10); // Duração (ex: 60s)

  if (!videoId) {
    return res.status(400).json({ error: 'O parâmetro id do vídeo é obrigatório.' });
  }

  try {
    // 1. Obtém o link da mídia direta
    const response = await axios.get(`https://${RAPIDAPI_HOST}/download`, {
      params: { id: videoId, quality: 'lowest' },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      },
      timeout: 25000
    });

    const data = response.data;
    let fileUrl = data?.url || data?.download_url;

    if (!fileUrl && Array.isArray(data?.formats)) {
      const formatoValido = data.formats.find(f => f.url && !f.url.includes('ytimg.com'));
      fileUrl = formatoValido?.url;
    }

    if (!fileUrl) {
      return res.status(500).json({ error: 'Link de mídia não disponível.' });
    }

    // Define nome e headers de download para o telemóvel
    res.setHeader('Content-Disposition', `attachment; filename="corte_${videoId}_${start}s.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');

    // 2. O FFmpeg salta direto para o ponto do corte e extrai só os segundos solicitados!
    // Usando cópia direta (-c copy), o processo é instantâneo e gera um arquivo minúsculo (< 15 MB)
    ffmpeg(fileUrl)
      .inputOptions([
        `-ss ${start}` // Pula direto para o início do corte
      ])
      .duration(duration)
      .outputOptions([
        '-c copy', // Cópia direta de vídeo e áudio: gasta zero de RAM no Render
        '-movflags frag_keyframe+empty_moov'
      ])
      .format('mp4')
      .on('error', (err) => {
        console.error('Erro FFmpeg ao cortar:', err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Erro ao extrair o corte.' });
        }
      })
      .pipe(res, { end: true });

  } catch (error) {
    console.error('Erro no processamento do corte:', error.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Falha ao descarregar corte.',
        details: error.response?.data || error.message
      });
    }
  }
});
