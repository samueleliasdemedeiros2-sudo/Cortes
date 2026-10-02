// ============================================================
// CLIPFORGE PRO 12.7.1
// DOWNLOAD ENGINE - YT-API + FFmpeg
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DOWNLOAD_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const DOWNLOAD_REFERER = 'https://www.youtube.com/';


// ============================================================
// BUSCAR DADOS DO YT-API
// ============================================================

async function ytApiDownload(videoId) {

  if (!RAPIDAPI_KEY) {
    throw new Error('RAPIDAPI_KEY não configurada.');
  }

  const endpoint =
    `https://${RAPIDAPI_HOST}/dl?id=${encodeURIComponent(videoId)}&cgeo=BR`;

  console.log('[YT-API] Buscando Download/Stream para', videoId);
  console.log('[YT-API] Endpoint:', endpoint);

  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      'x-rapidapi-key': RAPIDAPI_KEY,
      'x-rapidapi-host': RAPIDAPI_HOST,
      'accept': 'application/json',
      'user-agent': DOWNLOAD_UA
    }
  });

  const texto = await response.text();

  if (!response.ok) {
    throw new Error(
      `YT-API HTTP ${response.status}: ${texto.slice(0, 500)}`
    );
  }

  let data;

  try {
    data = JSON.parse(texto);
  } catch {
    throw new Error('YT-API retornou resposta que não é JSON.');
  }

  return data;
}


// ============================================================
// EXTRAIR URLS RECURSIVAMENTE
// ============================================================

function coletarUrls(obj, resultado = []) {

  if (!obj) {
    return resultado;
  }

  if (typeof obj === 'string') {

    if (
      obj.startsWith('http://') ||
      obj.startsWith('https://')
    ) {
      resultado.push(obj);
    }

    return resultado;
  }

  if (Array.isArray(obj)) {

    for (const item of obj) {
      coletarUrls(item, resultado);
    }

    return resultado;
  }

  if (typeof obj === 'object') {

    for (const valor of Object.values(obj)) {
      coletarUrls(valor, resultado);
    }

  }

  return resultado;
}


// ============================================================
// ANALISAR STREAM
// ============================================================

function analisarStream(url) {

  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return {
      url,
      video: false,
      audio: false,
      altura: 0,
      largura: 0,
      bitrate: 0,
      itag: 0,
      mime: ''
    };
  }

  const params = parsed.searchParams;

  const mime =
    (params.get('mime') || '').toLowerCase();

  const type =
    (params.get('type') || '').toLowerCase();

  const itag =
    Number(params.get('itag') || 0);

  const height =
    Number(
      params.get('height') ||
      params.get('size')?.split('x')?.[1] ||
      0
    );

  const width =
    Number(
      params.get('width') ||
      params.get('size')?.split('x')?.[0] ||
      0
    );

  const bitrate =
    Number(
      params.get('bitrate') ||
      params.get('abr') ||
      0
    );

  const codecs =
    (
      params.get('codecs') ||
      type
    ).toLowerCase();

  const isVideoMime =
    mime.startsWith('video/');

  const isAudioMime =
    mime.startsWith('audio/');

  const hasVideoCodec =
    /avc|vp9|vp09|av01|hev1|hvc1/.test(codecs);

  const hasAudioCodec =
    /mp4a|opus|vorbis|ac-3|ec-3/.test(codecs);

  /*
   * Alguns formatos do YouTube são combinados.
   * O itag 18 é um dos principais exemplos.
   */
  const combinedItag =
    [5, 17, 18, 22, 34, 35, 36, 37, 43, 44, 45, 46]
      .includes(itag);

  const video =
    isVideoMime ||
    hasVideoCodec ||
    combinedItag;

  const audio =
    isAudioMime ||
    hasAudioCodec ||
    combinedItag;

  return {
    url,
    video,
    audio,
    combinado: video && audio,
    altura: height,
    largura: width,
    bitrate,
    itag,
    mime
  };
}


// ============================================================
// ENCONTRAR MELHORES STREAMS
// ============================================================

function encontrarStreams(urls) {

  const analisados = urls
    .map(analisarStream)
    .filter(item => item.url);

  const videoSeparado = analisados
    .filter(item => item.video && !item.audio)
    .sort((a, b) => {

      const aOk = a.altura <= 720 ? 1 : 0;
      const bOk = b.altura <= 720 ? 1 : 0;

      if (aOk !== bOk) {
        return bOk - aOk;
      }

      return (
        Math.abs((a.altura || 720) - 720) -
        Math.abs((b.altura || 720) - 720)
      );
    });

  const audioSeparado = analisados
    .filter(item => item.audio && !item.video)
    .sort((a, b) =>
      (b.bitrate || 0) - (a.bitrate || 0)
    );

  const combinados = analisados
    .filter(item => item.video && item.audio)
    .sort((a, b) => {

      const a720 =
        a.altura <= 720 ? 1 : 0;

      const b720 =
        b.altura <= 720 ? 1 : 0;

      if (a720 !== b720) {
        return b720 - a720;
      }

      return (
        Math.abs((a.altura || 720) - 720) -
        Math.abs((b.altura || 720) - 720)
      );
    });

  return {
    todos: analisados,
    video: videoSeparado[0] || null,
    audio: audioSeparado[0] || null,
    combinado: combinados[0] || null
  };
}


// ============================================================
// TESTAR URL ANTES DO FFMPEG
// ============================================================

async function testarStream(url) {

  try {

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': DOWNLOAD_UA,
        'Referer': DOWNLOAD_REFERER,
        'Accept': '*/*'
      },
      redirect: 'follow'
    });

    console.log(
      `[Download] Teste HTTP: ${response.status} ${response.statusText}`
    );

    if (!response.ok) {
      return false;
    }

    return true;

  } catch (erro) {

    console.log(
      '[Download] Falha no teste HTTP:',
      erro.message
    );

    return false;
  }
}


// ============================================================
// FFMPEG COM HEADERS DE NAVEGADOR
// ============================================================

function executarFfmpegStreams(
  videoUrl,
  audioUrl,
  inicio,
  duracao,
  res
) {

  console.log(
    `[FFmpeg] Gerando corte: ${inicio}s → ${inicio + duracao}s`
  );

  const ffmpegArgs = [

    '-hide_banner',
    '-loglevel',
    'warning',

    '-ss',
    String(inicio),

    '-headers',
    `User-Agent: ${DOWNLOAD_UA}\r\nReferer: ${DOWNLOAD_REFERER}\r\n`,

    '-i',
    videoUrl
  ];

  if (audioUrl) {

    ffmpegArgs.push(

      '-ss',
      String(inicio),

      '-headers',
      `User-Agent: ${DOWNLOAD_UA}\r\nReferer: ${DOWNLOAD_REFERER}\r\n`,

      '-i',
      audioUrl
    );
  }

  ffmpegArgs.push(

    '-t',
    String(duracao),

    '-map',
    '0:v:0',

  );

  if (audioUrl) {

    ffmpegArgs.push(
      '-map',
      '1:a:0'
    );
  } else {

    ffmpegArgs.push(
      '-map',
      '0:a:0?'
    );
  }

  ffmpegArgs.push(

    '-c:v',
    'libx264',

    '-preset',
    'veryfast',

    '-crf',
    '23',

    '-c:a',
    'aac',

    '-b:a',
    '128k',

    '-movflags',
    'frag_keyframe+empty_moov',

    '-f',
    'mp4',

    'pipe:1'
  );

  console.log(
    '[FFmpeg] Iniciando processo...'
  );

  const ffmpeg = spawn(
    'ffmpeg',
    ffmpegArgs,
    {
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  let erro = '';

  ffmpeg.stderr.on(
    'data',
    chunk => {
      erro += chunk.toString();

      const linhas =
        chunk
          .toString()
          .split('\n')
          .filter(Boolean);

      for (const linha of linhas) {
        console.log('[FFmpeg]', linha);
      }
    }
  );

  ffmpeg.stdout.on(
    'data',
    chunk => {

      if (!res.headersSent) {

        res.setHeader(
          'Content-Type',
          'video/mp4'
        );

        res.setHeader(
          'Content-Disposition',
          'attachment; filename="clipforge-corte.mp4"'
        );

        res.setHeader(
          'Cache-Control',
          'no-store'
        );
      }

      res.write(chunk);
    }
  );

  ffmpeg.on(
    'close',
    codigo => {

      console.log(
        `[FFmpeg] Processo encerrado: ${codigo}`
      );

      if (codigo !== 0) {

        console.error(
          '[FFmpeg Error]',
          erro.slice(-3000)
        );

        if (!res.headersSent) {

          return res.status(500).json({
            error:
              'FFmpeg não conseguiu gerar o corte.',
            detalhe:
              erro.slice(-1000)
          });
        }

        try {
          res.end();
        } catch {}

        return;
      }

      try {
        res.end();
      } catch {}
    }
  );

  ffmpeg.on(
    'error',
    erroProcesso => {

      console.error(
        '[FFmpeg Process Error]',
        erroProcesso
      );

      if (!res.headersSent) {

        return res.status(500).json({
          error:
            'Não foi possível iniciar o FFmpeg.'
        });
      }

      try {
        res.end();
      } catch {}
    }
  );
}


// ============================================================
// DOWNLOAD
// ============================================================

app.get(
  '/api/download',
  async (req, res) => {

    try {

      const videoId =
        req.query.id;

      const inicio =
        Math.max(
          0,
          Number(req.query.start || 0)
        );

      const duracao =
        Math.max(
          1,
          Number(req.query.duration || 30)
        );

      console.log('');
      console.log(
        '[Download] NOVO DOWNLOAD'
      );

      console.log(
        '[Download] ID:',
        videoId
      );

      console.log(
        '[Download] Início:',
        inicio + 's'
      );

      console.log(
        '[Download] Duração:',
        duracao + 's'
      );

      if (!videoId) {

        return res.status(400).json({
          error:
            'ID do vídeo não informado.'
        });
      }

      if (
        !Number.isFinite(inicio) ||
        !Number.isFinite(duracao)
      ) {

        return res.status(400).json({
          error:
            'Início ou duração inválidos.'
        });
      }

      metrics.downloads++;

      console.log(
        '[Download] Consultando YT-API...'
      );

      const dados =
        await ytApiDownload(videoId);

      const urls =
        coletarUrls(dados);

      console.log(
        '[YT-API] URLs encontradas:',
        urls.length
      );

      if (!urls.length) {

        throw new Error(
          'YT-API não retornou URLs de mídia.'
        );
      }

      const streams =
        encontrarStreams(urls);

      console.log(
        '[Download] Streams analisadas:',
        streams.todos.length
      );

      if (streams.video) {

        console.log(
          '[Download] Vídeo:',
          `itag=${streams.video.itag}`,
          `altura=${streams.video.altura}`,
          `mime=${streams.video.mime}`
        );
      }

      if (streams.audio) {

        console.log(
          '[Download] Áudio:',
          `itag=${streams.audio.itag}`,
          `bitrate=${streams.audio.bitrate}`
        );
      }

      if (streams.combinado) {

        console.log(
          '[Download] Stream combinado:',
          `itag=${streams.combinado.itag}`,
          `altura=${streams.combinado.altura}`
        );
      }


      // --------------------------------------------------------
      // PRIMEIRA OPÇÃO:
      // VÍDEO + ÁUDIO SEPARADOS
      // --------------------------------------------------------

      if (
        streams.video &&
        streams.audio
      ) {

        console.log(
          '[Download] Vídeo + áudio encontrados.'
        );

        /*
         * Testamos a URL antes de entregar ao FFmpeg.
         * Se a origem negar acesso, não mascaramos o erro.
         */

        const videoOk =
          await testarStream(
            streams.video.url
          );

        const audioOk =
          await testarStream(
            streams.audio.url
          );

        if (videoOk && audioOk) {

          console.log(
            '[Download] Streams acessíveis. Enviando ao FFmpeg.'
          );

          return executarFfmpegStreams(
            streams.video.url,
            streams.audio.url,
            inicio,
            duracao,
            res
          );
        }

        console.log(
          '[Download] Stream separada recusada pelo servidor.'
        );
      }


      // --------------------------------------------------------
      // SEGUNDA OPÇÃO:
      // STREAM COMBINADA
      // --------------------------------------------------------

      if (streams.combinado) {

        console.log(
          '[Download] Tentando stream combinada...'
        );

        const combinadoOk =
          await testarStream(
            streams.combinado.url
          );

        if (combinadoOk) {

          return executarFfmpegStreams(
            streams.combinado.url,
            null,
            inicio,
            duracao,
            res
          );
        }

        console.log(
          '[Download] Stream combinada também recusada.'
        );
      }


      // --------------------------------------------------------
      // ERRO DETALHADO
      // --------------------------------------------------------

      throw new Error(
        'As URLs de mídia foram encontradas pelo YT-API, ' +
        'mas o servidor de mídia recusou o acesso.'
      );

    } catch (erro) {

      metrics.erros++;

      console.error(
        '[Download Error]:',
        erro.message
      );

      if (!res.headersSent) {

        return res.status(500).json({
          error:
            'Não foi possível gerar o corte.',
          detalhe:
            erro.message
        });
      }

      try {
        res.end();
      } catch {}
    }
  }
);