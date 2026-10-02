function executarDownloadComFfmpeg(
  streamUrl,
  inicio,
  duracao,
  res
) {
  return new Promise((resolve, reject) => {

    const headers = [
      'Referer: https://www.youtube.com/',
      'Origin: https://www.youtube.com',
      'User-Agent: Mozilla/5.0'
    ].join('\r\n') + '\r\n';

    let finalizado = false;
    let fallbackIniciado = false;
    let processo = null;

    function finalizarErro(error) {
      if (finalizado) return;

      finalizado = true;

      reject(error);
    }

    function iniciarFallback() {

      if (
        finalizado ||
        fallbackIniciado ||
        res.destroyed
      ) {
        return;
      }

      fallbackIniciado = true;

      const argumentosFallback = [
        '-hide_banner',
        '-loglevel',
        'error',

        '-ss',
        String(inicio),

        '-i',
        streamUrl,

        '-t',
        String(duracao),

        '-map',
        '0:v:0?',
        '-map',
        '0:a:0?',

        '-vf',
        'scale=-2:360',

        '-c:v',
        'libx264',

        '-preset',
        'ultrafast',

        '-crf',
        '30',

        '-c:a',
        'aac',

        '-b:a',
        '64k',

        '-ac',
        '2',

        '-threads',
        '0',

        '-movflags',
        'frag_keyframe+empty_moov',

        '-f',
        'mp4',

        '-headers',
        headers,

        'pipe:1'
      ];

      processo = spawn(
        'ffmpeg',
        argumentosFallback,
        {
          stdio: [
            'ignore',
            'pipe',
            'pipe'
          ]
        }
      );

      let erro = '';

      processo.stderr.on(
        'data',
        dados => {
          erro += dados.toString();
        }
      );

      processo.stdout.on(
        'error',
        error => {
          if (error.code !== 'EPIPE') {
            console.error(
              '[FFmpeg fallback]',
              error.message
            );
         