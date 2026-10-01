// Rota de download leve (força formatos compactados de 2MB a 20MB)
app.get('/api/download', async (req, res) => {
  const videoId = req.query.id;

  if (!videoId) {
    return res.status(400).json({ error: 'O parâmetro id do vídeo é obrigatório.' });
  }

  try {
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

    // 1. Procura primeiro na lista de formatos pelo arquivo leve (360p / 240p com áudio)
    if (Array.isArray(data?.formats) && data.formats.length > 0) {
      // Pega o formato leve (ex: 360p que gera aquele arquivo de ~3MB)
      const formatoLeve = data.formats.find(f => 
        f.url && 
        !f.url.includes('ytimg.com') && 
        (f.qualityLabel === '360p' || f.quality === 'medium' || f.hasAudio === true)
      );

      fileUrl = formatoLeve ? formatoLeve.url : data.formats[0].url;
    }

    // 2. Se não estiver na lista de formatos, pega o link direto leve
    if (!fileUrl) {
      fileUrl = data?.download_url || data?.url;
    }

    // Garante que não é miniatura/imagem
    if (!fileUrl || fileUrl.includes('ytimg.com')) {
      return res.status(500).json({ error: 'Formato de vídeo leve não encontrado.' });
    }

    // 3. Redireciona diretamente para o download do arquivo leve
    return res.redirect(fileUrl);

  } catch (error) {
    console.error('Erro ao baixar vídeo leve:', error.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Não foi possível descarregar o arquivo leve.',
        details: error.response?.data || error.message
      });
    }
  }
});
