export default async function handler(req, res) {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'ID do vídeo obrigatório.' });
  }

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
      const stream = data.videoStreams?.find(s => s.format === 'MPEG_4' && !s.videoOnly)
                  || data.videoStreams?.find(s => s.format === 'MPEG_4');

      if (stream && stream.url) {
        return res.redirect(stream.url);
      }
    } catch (err) {
      console.warn(`Falha na instância ${instance}, tentando próxima...`);
    }
  }

  return res.redirect(`https://yewtu.be/latest_version?id=${id}&itag=22`);
}
