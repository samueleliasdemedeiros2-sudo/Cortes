export default async function handler(req, res) {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'ID do vídeo obrigatório.' });
  }

  const RAPIDAPI_KEY = 'c9dea9a596msh9565df12086412fp1d11cejsnadb3d0bd41ad';
  const RAPIDAPI_HOST = 'youtube-video-fast-downloader-24-7.p.rapidapi.com';

  try {
    // 1. Pede o link de download direto para a sua RapidAPI
    const apiUrl = `https://${RAPIDAPI_HOST}/download?id=${id}`;
    const apiRes = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      }
    });

    const data = await apiRes.json();
    const downloadUrl = data?.url || data?.link || data?.downloadUrl;

    if (!downloadUrl) {
      return res.status(500).json({ 
        error: 'Não foi possível extrair o link da API.', 
        detalhes: data 
      });
    }

    // 2. Busca o vídeo diretamente e joga os dados pro celular baixar limpo
    const videoStream = await fetch(downloadUrl);

    if (!videoStream.ok) {
      // Se o link direto exigir redirecionamento imediato
      return res.redirect(downloadUrl);
    }

    // Configura o cabeçalho para baixar como arquivo no celular
    res.setHeader('Content-Disposition', `attachment; filename="corte_${id}.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');

    // Transmite os bytes do vídeo direto pro celular
    const buffer = await videoStream.arrayBuffer();
    return res.send(Buffer.from(buffer));

  } catch (err) {
    console.error('Erro no download:', err);
    return res.status(500).json({ error: 'Erro ao processar download', details: err.message });
  }
}
