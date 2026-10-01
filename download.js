export default async function handler(req, res) {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'ID do vídeo obrigatório.' });
  }

  // Instâncias públicas da API do Piped (sem anúncios, sem encurtadores, stream limpo)
  const instances = [
    'https://pipedapi.kavin.rocks',
    'https://api.piped.privacydev.net',
    'https://pipedapi.leptons.xyz',
    'https://api.piped.projectsegfau.lt'
  ];

  for (const instance of instances) {
    try {
      const response = await fetch(`${instance}/streams/${id}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) continue;

      const data = await response.json();

      // Procura por streams que já venham com vídeo e áudio combinados (MP4)
      const stream = data.videoStreams?.find(s => s.format === 'MPEG_4' && !s.videoOnly)
                  || data.videoStreams?.find(s => s.format === 'MPEG_4');

      if (stream && stream.url) {
        // Redireciona diretamente para o link de stream do vídeo do YouTube
        return res.redirect(stream.url);
      }
    } catch (err) {
      console.warn(`Falha na instância ${instance}, tentando próxima...`);
    }
  }

  // Fallback para download web direto se as instâncias oscilarem
  return res.redirect(`https://yewtu.be/latest_version?id=${id}&itag=22`);
}
