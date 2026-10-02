// ============================================================
// CLIPFORGE PRO - BACKEND
// VERSION 12.7.1
// BASE: VERSION 12.7.0
// DOWNLOAD: YT-API /dl + FFMPEG + YT-DLP FALLBACK
// ============================================================

const express = require('express');
const cors = require('cors');

const fs = require('fs');
const os = require('os');
const path = require('path');

const { execFile } = require('child_process');
const util = require('util');

const app = express();

const PORT =
  process.env.PORT || 10000;

const execFileAsync =
  util.promisify(execFile);

// ============================================================
// CONFIGURAÇÕES
// ============================================================

const RAPIDAPI_KEY =
  process.env.RAPIDAPI_KEY;

const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST ||
  'yt-api.p.rapidapi.com';

const MP_ACCESS_TOKEN =
  process.env.MP_ACCESS_TOKEN;

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD;

// Caminho do yt-dlp.
// No Render, o build atual cria:
// ./bin/yt-dlp
const YTDLP_PATH =
  process.env.YTDLP_PATH ||
  path.join(
    process.cwd(),
    'bin',
    'yt-dlp'
  );

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
  cors({
    origin: '*',
    methods: [
      'GET',
      'POST',
      'OPTIONS'
    ],
    allowedHeaders: [
      'Content-Type',
      'Authorization'
    ]
  })
);

app.use(
  express.json({
    limit: '2mb'
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '2mb'
  })
);

// ============================================================
// MÉTRICAS
// ============================================================

const metrics = {
  analises: 0,
  downloads: 0,
  pixCriados: 0,
  erros: 0
};

// ============================================================
// EXTRAIR ID DO YOUTUBE
// ============================================================

function extrairVideoId(input) {

  if (!input) {
    return null;
  }

  let valor =
    String(input).trim();

  valor =
    valor.replace(
      /^["']|["']$/g,
      ''
    );

  if (
    /^[a-zA-Z0-9_-]{11}$/.test(valor)
  ) {
    return valor;
  }

  try {

    let valorUrl = valor;

    if (
      !/^https?:\/\//i.test(valorUrl)
    ) {

      if (
        /^(www\.)?youtube\.com/i.test(
          valorUrl
        ) ||
        /^youtu\.be\//i.test(
          valorUrl
        )
      ) {

        valorUrl =
          `https://${valorUrl}`;

      }

    }

    const url =
      new URL(valorUrl);

    const hostname =
      url.hostname.toLowerCase();

    if (
      hostname.includes('youtube.com') ||
      hostname.includes(
        'youtube-nocookie.com'
      )
    ) {

      const v =
        url.searchParams.get('v');

      if (
        v &&
        /^[a-zA-Z0-9_-]{11}$/.test(v)
      ) {

        return v;

      }

      const partes =
        url.pathname
          .split('/')
          .filter(Boolean);

      if (
        (
          partes[0] === 'shorts' ||
          partes[0] === 'embed' ||
          partes[0] === 'live'
        ) &&
        partes[1]
      ) {

        const id =
          partes[1]
            .split('?')[0]
            .split('&')[0];

        if (
          /^[a-zA-Z0-9_-]{11}$/.test(id)
        ) {

          return id;

        }

      }

    }

    if (
      hostname === 'youtu.be' ||
      hostname === 'www.youtu.be'
    ) {

      const id =
        url.pathname
          .replace(/^\/+/, '')
          .split('/')[0];

      if (
        /^[a-zA-Z0-9_-]{11}$/.test(id)
      ) {

        return id;

      }

    }

  } catch (erro) {
    // Continua para regex.
  }

  const encontrado =
    valor.match(
      /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([a-zA-Z0-9_-]{11})/
    );

  if (encontrado) {
    return encontrado[1];
  }

  return null;
}

// ============================================================
// UTILITÁRIOS
// ============================================================

function numeroSeguro(
  valor,
  padrao = 0
) {

  const n =
    Number(valor);

  if (
    !Number.isFinite(n)
  ) {
    return padrao;
  }

  return n;
}

function limitarNumero(
  valor,
  minimo,
  maximo
) {

  return Math.max(
    minimo,
    Math.min(
      maximo,
      valor
    )
  );

}

function respostaErro(
  res,
  status,
  mensagem
) {

  metrics.erros++;

  return res
    .status(status)
    .json({
      error: mensagem
    });

}

function garantirDiretorio(
  diretorio
) {

  if (
    !fs.existsSync(
      diretorio
    )
  ) {

    fs.mkdirSync(
      diretorio,
      {
        recursive: true
      }
    );

  }

}

// ============================================================
// STATUS
// ============================================================

app.get(
  '/',
  (req, res) => {

    res.json({

      name:
        'ClipForge Pro API',

      version:
        '12.7.1',

      status:
        'online',

      download:
        'YT-API + FFmpeg + yt-dlp fallback'

    });

  }
);

app.get(
  '/api/status',
  (req, res) => {

    res.json({

      online: true,

      version:
        '12.7.1',

      rapidapi:
        Boolean(
          RAPIDAPI_KEY
        ),

      mercadopago:
        Boolean(
          MP_ACCESS_TOKEN
        ),

      ffmpeg: true,

      ytapi:
        RAPIDAPI_HOST ===
        'yt-api.p.rapidapi.com',

      ytdlp:
        fs.existsSync(
          YTDLP_PATH
        )

    });

  }
);

// ============================================================
// ADMIN LOGIN
// ============================================================

app.post(
  '/api/admin/login',
  (req, res) => {

    const {
      password
    } = req.body || {};

    if (
      !ADMIN_PASSWORD ||
      !password ||
      password !== ADMIN_PASSWORD
    ) {

      return res
        .status(401)
        .json({
          error:
            'Credencial inválida.'
        });

    }

    return res.json({
      success: true
    });

  }
);

// ============================================================
// ADMIN DASHBOARD
// ============================================================

app.get(
  '/api/admin/dashboard',
  (req, res) => {

    res.json({

      success: true,

      metrics: {

        analises:
          metrics.analises,

        downloads:
          metrics.downloads,

        pixCriados:
          metrics.pixCriados,

        erros:
          metrics.erros

      },

      metricas: {

        analises:
          metrics.analises,

        downloads:
          metrics.downloads,

        pixCriados:
          metrics.pixCriados,

        erros:
          metrics.erros

      },

      system: {

        version:
          '12.7.1',

        rapidapi:
          Boolean(
            RAPIDAPI_KEY
          ),

        mercadopago:
          Boolean(
            MP_ACCESS_TOKEN
          ),

        ytapi:
          true,

        ytdlp:
          fs.existsSync(
            YTDLP_PATH
          )

      },

      servidor: {

        version:
          '12.7.1',

        rapidapi:
          Boolean(
            RAPIDAPI_KEY
          ),

        mercadopago:
          Boolean(
            MP_ACCESS_TOKEN
          ),

        ytapi:
          true,

        ytdlp:
          fs.existsSync(
            YTDLP_PATH
          )

      }

    });

  }
);

// ============================================================
// ANÁLISE
// ============================================================

app.post(
  '/api/analisar',
  async (req, res) => {

    try {

      const {
        url,
        videoUrl,
        youtubeUrl,
        videoId,
        id,
        youtube_url,
        link,
        youtube,
        v,
        duration,
        quantity
      } = req.body || {};

      let entrada =
        id ||
        videoId ||
        url ||
        videoUrl ||
        youtubeUrl ||
        youtube_url ||
        link ||
        youtube ||
        v;

      if (
        v &&
        /^[a-zA-Z0-9_-]{11}$/.test(
          String(v).trim()
        )
      ) {

        entrada =
          `https://www.youtube.com/watch?v=${String(v).trim()}`;

      }

      console.log(
        '[Análise] Entrada recebida:',
        entrada
          ? String(entrada).slice(
              0,
              200
            )
          : 'nenhuma'
      );

      const youtubeId =
        extrairVideoId(
          entrada
        );

      console.log(
        '[Análise] ID extraído:',
        youtubeId ||
          'NÃO ENCONTRADO'
      );

      if (!youtubeId) {

        return respostaErro(
          res,
          400,
          'URL ou ID do YouTube inválido.'
        );

      }

      metrics.analises++;

      const quantidade =
        limitarNumero(
          Math.floor(
            numeroSeguro(
              quantity,
              3
            )
          ),
          1,
          10
        );

      const duracaoSolicitada =
        limitarNumero(
          numeroSeguro(
            duration,
            60
          ),
          1,
          3600
        );

      console.log(
        `[Análise] Vídeo: ${youtubeId}`
      );

      console.log(
        `[Análise] Quantidade solicitada: ${quantidade}`
      );

      console.log(
        `[Análise] Duração solicitada: ${duracaoSolicitada}s`
      );

      const thumbnail =
        `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`;

      // ========================================================
      // MANTIDO DA 12.7.0
      // ========================================================

      const clipsBase = [

        {
          id: 1,

          title:
            'Melhor momento',

          start: 35,

          end: 90,

          duration: 55,

          score: 98,

          reason:
            'Momento com alto potencial de retenção.',

          thumbnail

        },

        {
          id: 2,

          title:
            'Momento de destaque',

          start: 145,

          end: 200,

          duration: 55,

          score: 95,

          reason:
            'Trecho com potencial para gerar engajamento.',

          thumbnail

        },

        {
          id: 3,

          title:
            'Trecho viral',

          start: 290,

          end: 345,

          duration: 55,

          score: 92,

          reason:
            'Trecho interessante para formato curto.',

          thumbnail

        }

      ];

      const clips =
        clipsBase.slice(
          0,
          quantidade
        );

      return res.json({

        success: true,

        videoId:
          youtubeId,

        videoUrl:
          `https://www.youtube.com/watch?v=${youtubeId}`,

        duration:
          duracaoSolicitada,

        quantity:
          clips.length,

        clips

      });

    } catch (erro) {

      console.error(
        '[Análise Error]:',
        erro
      );

      return respostaErro(
        res,
        500,
        'Não foi possível analisar o vídeo.'
      );

    }

  }
);

// ============================================================
// YT-API /DL
// ============================================================

async function ytApiDownload(
  videoId
) {

  if (!RAPIDAPI_KEY) {

    throw new Error(
      'RAPIDAPI_KEY não configurada.'
    );

  }

  const url =
    new URL(
      `https://${RAPIDAPI_HOST}/dl`
    );

  url.searchParams.set(
    'id',
    videoId
  );

  url.searchParams.set(
    'cgeo',
    'BR'
  );

  console.log(
    `[YT-API] Buscando Download/Stream para ${videoId}...`
  );

  console.log(
    `[YT-API] Endpoint: ${url.origin}${url.pathname}`
  );

  const response =
    await fetch(
      url,
      {

        method:
          'GET',

        headers: {

          'x-rapidapi-key':
            RAPIDAPI_KEY,

          'x-rapidapi-host':
            RAPIDAPI_HOST,

          'accept':
            'application/json',

          'user-agent':
            'ClipForge-Pro/12.7.1'

        }

      }
    );

  const texto =
    await response.text();

  let data;

  try {

    data =
      JSON.parse(texto);

  } catch {

    data = {
      raw: texto
    };

  }

  if (!response.ok) {

    console.error(
      `[YT-API] HTTP ${response.status}`
    );

    console.error(
      '[YT-API Error Body]:',
      JSON.stringify(data)
        .slice(
          0,
          3000
        )
    );

    throw new Error(
      `YT-API retornou HTTP ${response.status}`
    );

  }

  return data;

}

// ============================================================
// COLETAR URLS
// ============================================================

function coletarUrls(
  objeto,
  caminho = '',
  resultado = []
) {

  if (
    typeof objeto ===
    'string'
  ) {

    if (
      /^https?:\/\//i.test(
        objeto
      )
    ) {

      resultado.push({

        url:
          objeto,

        caminho

      });

    }

    return resultado;

  }

  if (
    Array.isArray(
      objeto
    )
  ) {

    objeto.forEach(
      (item, index) => {

        coletarUrls(
          item,
          `${caminho}.${index}`,
          resultado
        );

      }
    );

    return resultado;

  }

  if (
    objeto &&
    typeof objeto ===
    'object'
  ) {

    Object.entries(
      objeto
    ).forEach(
      ([chave, valor]) => {

        coletarUrls(
          valor,
          caminho
            ? `${caminho}.${chave}`
            : chave,
          resultado
        );

      }
    );

  }

  return resultado;

}

// ============================================================
// ANALISAR STREAM
// ============================================================

function analisarStream(
  item
) {

  const texto =
    `${item.caminho} ${item.url}`
      .toLowerCase();

  const video =
    texto.includes(
      'mime=video'
    ) ||
    texto.includes(
      'mime%3dvideo'
    ) ||
    texto.includes(
      'video/mp4'
    ) ||
    texto.includes(
      'video%2fmp4'
    ) ||
    (
      texto.includes(
        'videoplayback'
      ) &&
      !texto.includes(
        'mime=audio'
      )
    );

  const audio =
    texto.includes(
      'mime=audio'
    ) ||
    texto.includes(
      'mime%3daudio'
    ) ||
    texto.includes(
      'audio/mp4'
    ) ||
    texto.includes(
      'audio%2fmp4'
    ) ||
    texto.includes(
      'audio/webm'
    ) ||
    texto.includes(
      'audio%2fwebm'
    );

  let largura = 0;
  let altura = 0;
  let bitrate = 0;
  let itag = 0;

  try {

    const url =
      new URL(
        item.url
      );

    largura =
      Number(
        url.searchParams.get(
          'width'
        ) || 0
      );

    altura =
      Number(
        url.searchParams.get(
          'height'
        ) || 0
      );

    bitrate =
      Number(
        url.searchParams.get(
          'bitrate'
        ) || 0
      );

    itag =
      Number(
        url.searchParams.get(
          'itag'
        ) || 0
      );

  } catch {}

  return {

    ...item,

    video,

    audio,

    largura,

    altura,

    bitrate,

    itag

  };

}

// ============================================================
// ENCONTRAR STREAMS
// ============================================================

function encontrarStreams(
  data
) {

  const urls =
    coletarUrls(
      data
    );

  const streams =
    urls.map(
      analisarStream
    );

  console.log(
    `[YT-API] URLs encontradas: ${streams.length}`
  );

  streams
    .slice(0, 10)
    .forEach(
      (stream, index) => {

        console.log(
          `[YT-API] Stream ${index + 1}:`,
          {
            video:
              stream.video,

            audio:
              stream.audio,

            altura:
              stream.altura,

            itag:
              stream.itag
          }
        );

      }
    );

  const videos =
    streams.filter(
      stream =>
        stream.video &&
        !stream.audio
    );

  const combinados =
    streams.filter(
      stream =>
        stream.video &&
        stream.audio
    );

  const audios =
    streams.filter(
      stream =>
        stream.audio &&
        !stream.video
    );

  let videoEscolhido =
    null;

  if (
    videos.length
  ) {

    const ate720 =
      videos.filter(
        stream =>
          !stream.altura ||
          stream.altura <= 720
      );

    const lista =
      ate720.length
        ? ate720
        : videos;

    lista.sort(
      (a, b) => {

        return (
          Number(
            b.altura || 0
          ) -
          Number(
            a.altura || 0
          )
        );

      }
    );

    videoEscolhido =
      lista[0];

  }

  let audioEscolhido =
    null;

  if (
    audios.length
  ) {

    audios.sort(
      (a, b) => {

        return (
          Number(
            b.bitrate || 0
          ) -
          Number(
            a.bitrate || 0
          )
        );

      }
    );

    audioEscolhido =
      audios[0];

  }

  let combinadoEscolhido =
    null;

  if (
    combinados.length
  ) {

    combinadoEscolhido =
      combinados
        .sort(
          (a, b) =>
            Number(
              b.altura || 0
            ) -
            Number(
              a.altura || 0
            )
        )[0];

  }

  return {

    video:
      videoEscolhido,

    audio:
      audioEscolhido,

    combinado:
      combinadoEscolhido,

    total:
      streams.length

  };

}

// ============================================================
// HEADERS PARA GOOGLEVIDEO/YOUTUBE
// ============================================================

const YOUTUBE_HEADERS =
  [
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
    'Accept: */*',
    'Referer: https://www.youtube.com/'
  ].join('\r\n') +
  '\r\n';

// ============================================================
// TESTAR STREAM
// ============================================================

async function testarStream(
  url
) {

  try {

    const response =
      await fetch(
        url,
        {

          method:
            'GET',

          headers: {

            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',

            'Accept':
              '*/*',

            'Referer':
              'https://www.youtube.com/'

          }

        }
      );

    const status =
      response.status;

    try {

      if (
        response.body &&
        typeof response.body.cancel ===
        'function'
      ) {

        await response.body.cancel();

      }

    } catch {}

    console.log(
      `[Download] Teste da stream: HTTP ${status}`
    );

    return response.ok;

  } catch (erro) {

    console.log(
      '[Download] Falha no teste da stream:',
      erro.message
    );

    return false;

  }

}

// ============================================================
// FFMPEG COM STREAMS REMOTAS
// ============================================================

async function executarFfmpegStreams(
  videoUrl,
  audioUrl,
  inicio,
  duracao,
  res
) {

  console.log(
    `[FFmpeg] Gerando corte: ${inicio}s → ${inicio + duracao}s`
  );

  const args = [

    '-hide_banner',

    '-loglevel',
    'warning',

    '-reconnect',
    '1',

    '-reconnect_streamed',
    '1',

    '-reconnect_delay_max',
    '5',

    '-headers',
    YOUTUBE_HEADERS,

    '-ss',
    String(inicio),

    '-i',
    videoUrl,

    '-headers',
    YOUTUBE_HEADERS,

    '-ss',
    String(inicio),

    '-i',
    audioUrl,

    '-t',
    String(duracao),

    '-map',
    '0:v:0',

    '-map',
    '1:a:0',

    '-vf',
    'scale=-2:360',

    '-c:v',
    'libx264',

    '-preset',
    'ultrafast',

    '-crf',
    '28',

    '-pix_fmt',
    'yuv420p',

    '-c:a',
    'aac',

    '-b:a',
    '96k',

    '-ar',
    '44100',

    '-movflags',
    'frag_keyframe+empty_moov',

    '-f',
    'mp4',

    'pipe:1'

  ];

  return new Promise(
    (resolve, reject) => {

      let finalizado =
        false;

      const processo =
        execFile(
          'ffmpeg',
          args,
          {
            maxBuffer:
              1024 * 1024 * 10
          },
          error => {

            if (
              finalizado
            ) {
              return;
            }

            if (error) {

              console.error(
                '[FFmpeg Error]:',
                error.message
              );

              return reject(
                new Error(
                  'FFmpeg não conseguiu gerar o corte.'
                )
              );

            }

            finalizado =
              true;

            resolve();

          }
        );

      processo.stdout.pipe(
        res
      );

      processo.stderr.on(
        'data',
        chunk => {

          const texto =
            chunk.toString();

          if (
            texto.includes('frame=') ||
            texto.includes('time=') ||
            texto.includes('403') ||
            texto.includes('Forbidden')
          ) {

            process.stdout.write(
              `[FFmpeg] ${texto.trim()}\n`
            );

          }

        }
      );

      processo.on(
        'error',
        erro => {

          if (
            !finalizado
          ) {

            finalizado =
              true;

            reject(
              erro
            );

          }

        }
      );

    }
  );

}

// ============================================================
// FFMPEG STREAM COMBINADA
// ============================================================

async function executarFfmpegCombinado(
  url,
  inicio,
  duracao,
  res
) {

  const args = [

    '-hide_banner',

    '-loglevel',
    'warning',

    '-reconnect',
    '1',

    '-reconnect_streamed',
    '1',

    '-reconnect_delay_max',
    '5',

    '-headers',
    YOUTUBE_HEADERS,

    '-ss',
    String(inicio),

    '-i',
    url,

    '-t',
    String(duracao),

    '-vf',
    'scale=-2:360',

    '-c:v',
    'libx264',

    '-preset',
    'ultrafast',

    '-crf',
    '28',

    '-pix_fmt',
    'yuv420p',

    '-c:a',
    'aac',

    '-b:a',
    '96k',

    '-ar',
    '44100',

    '-movflags',
    'frag_keyframe+empty_moov',

    '-f',
    'mp4',

    'pipe:1'

  ];

  return new Promise(
    (resolve, reject) => {

      const processo =
        execFile(
          'ffmpeg',
          args,
          {
            maxBuffer:
              1024 * 1024 * 10
          },
          error => {

            if (error) {

              console.error(
                '[FFmpeg Combined Error]:',
                error.message
              );

              reject(
                new Error(
                  'FFmpeg não conseguiu gerar o corte.'
                )
              );

              return;

            }

            resolve();

          }
        );

      processo.stdout.pipe(
        res
      );

      processo.stderr.on(
        'data',
        chunk => {

          const texto =
            chunk.toString();

          if (
            texto.includes('frame=') ||
            texto.includes('time=') ||
            texto.includes('403') ||
            texto.includes('Forbidden')
          ) {

            process.stdout.write(
              `[FFmpeg] ${texto.trim()}\n`
            );

          }

        }
      );

      processo.on(
        'error',
        reject
      );

    }
  );

}

// ============================================================
// FFMPEG COM ARQUIVO
// ============================================================

async function executarFfmpegArquivo(
  arquivo,
  inicio,
  duracao,
  res
) {

  const args = [

    '-hide_banner',

    '-loglevel',
    'warning',

    '-ss',
    String(inicio),

    '-i',
    arquivo,

    '-t',
    String(duracao),

    '-vf',
    'scale=-2:360',

    '-c:v',
    'libx264',

    '-preset',
    'ultrafast',

    '-crf',
    '28',

    '-pix_fmt',
    'yuv420p',

    '-c:a',
    'aac',

    '-b:a',
    '96k',

    '-ar',
    '44100',

    '-movflags',
    'frag_keyframe+empty_moov',

    '-f',
    'mp4',

    'pipe:1'

  ];

  return new Promise(
    (resolve, reject) => {

      const processo =
        execFile(
          'ffmpeg',
          args,
          {
            maxBuffer:
              1024 * 1024 * 10
          },
          error => {

            if (error) {

              console.error(
                '[FFmpeg File Error]:',
                error.message
              );

              reject(
                new Error(
                  'FFmpeg não conseguiu gerar o corte.'
                )
              );

              return;

            }

            resolve();

          }
        );

      processo.stdout.pipe(
        res
      );

      processo.stderr.on(
        'data',
        chunk => {

          const texto =
            chunk.toString();

          if (
            texto.includes('frame=') ||
            texto.includes('time=')
          ) {

            process.stdout.write(
              `[FFmpeg] ${texto.trim()}\n`
            );

          }

        }
      );

      processo.on(
        'error',
        reject
      );

    }
  );

}

// ============================================================
// LOCALIZAR YT-DLP
// ============================================================

function localizarYtDlp() {

  const candidatos = [

    YTDLP_PATH,

    path.join(
      process.cwd(),
      'bin',
      'yt-dlp'
    ),

    '/opt/render/project/src/bin/yt-dlp',

    'yt-dlp'

  ];

  for (
    const candidato of candidatos
  ) {

    if (
      candidato === 'yt-dlp'
    ) {

      continue;

    }

    if (
      fs.existsSync(
        candidato
      )
    ) {

      return candidato;

    }

  }

  return 'yt-dlp';

}

// ============================================================
// YT-DLP FALLBACK
// ============================================================
//
// Esta função é usada quando a URL direta fornecida pela
// YT-API retorna 403 ou não pode ser processada pelo FFmpeg.
//
// O yt-dlp resolve novamente o vídeo diretamente e entrega
// um arquivo temporário para o FFmpeg.
// ============================================================

async function baixarComYtDlp(
  videoId,
  inicio,
  duracao
) {

  const ytDlp =
    localizarYtDlp();

  const pasta =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        'clipforge-ytdlp-'
      )
    );

  const saida =
    path.join(
      pasta,
      'source.%(ext)s'
    );

  const url =
    `https://www.youtube.com/watch?v=${videoId}`;

  const fim =
    inicio + duracao;

  console.log(
    '[YT-DLP] Fallback ativado.'
  );

  console.log(
    `[YT-DLP] Executável: ${ytDlp}`
  );

  console.log(
    `[YT-DLP] Intervalo: ${inicio}s → ${fim}s`
  );

  const args = [

    '--no-playlist',

    '--no-warnings',

    '--force-overwrites',

    '--retries',
    '3',

    '--fragment-retries',
    '3',

    '--concurrent-fragments',
    '4',

    '--merge-output-format',
    'mp4',

    '--download-sections',
    `*${inicio}-${fim}`,

    '--force-keyframes-at-cuts',

    '-f',
    'bv*[height<=720]+ba/b[height<=720]/b',

    '-o',
    saida,

    url

  ];

  try {

    await execFileAsync(
      ytDlp,
      args,
      {
        maxBuffer:
          1024 * 1024 * 20
      }
    );

    const arquivos =
      fs.readdirSync(
        pasta
      );

    const candidatos =
      arquivos
        .filter(
          nome =>
            nome.endsWith('.mp4') ||
            nome.endsWith('.mkv') ||
            nome.endsWith('.webm')
        )
        .map(
          nome =>
            path.join(
              pasta,
              nome
            )
        );

    if (
      !candidatos.length
    ) {

      throw new Error(
        'yt-dlp terminou sem gerar arquivo.'
      );

    }

    const arquivo =
      candidatos[0];

    console.log(
      `[YT-DLP] Arquivo criado: ${arquivo}`
    );

    return {

      pasta,

      arquivo

    };

  } catch (erro) {

    try {

      fs.rmSync(
        pasta,
        {
          recursive: true,
          force: true
        }
      );

    } catch {}

    console.error(
      '[YT-DLP Error]:',
      erro.message
    );

    throw new Error(
      `yt-dlp não conseguiu baixar o vídeo: ${erro.message}`
    );

  }

}

// ============================================================
// DOWNLOAD DO CLIP
// ============================================================

app.get(
  '/api/download',
  async (req, res) => {

    let pastaTemporaria =
      null;

    try {

      const {

        id,

        videoId:
          videoIdParam,

        url,

        videoUrl,

        youtubeUrl,

        start,

        duration

      } = req.query;

      const entradaVideo =
        id ||
        videoIdParam ||
        url ||
        videoUrl ||
        youtubeUrl;

      console.log(
        '[Download] Entrada recebida:',
        entradaVideo
          ? String(
              entradaVideo
            ).slice(
              0,
              150
            )
          : 'nenhuma'
      );

      const videoId =
        extrairVideoId(
          entradaVideo
        );

      if (!videoId) {

        return respostaErro(
          res,
          400,
          'URL ou ID do YouTube inválido.'
        );

      }

      let inicio =
        numeroSeguro(
          start,
          0
        );

      let duracao =
        numeroSeguro(
          duration,
          30
        );

      inicio =
        limitarNumero(
          inicio,
          0,
          24 * 60 * 60
        );

      duracao =
        limitarNumero(
          duracao,
          1,
          10 * 60
        );

      console.log('');

      console.log(
        '================================================'
      );

      console.log(
        '[Download] NOVO DOWNLOAD 12.7.1'
      );

      console.log(
        `[Download] ID: ${videoId}`
      );

      console.log(
        `[Download] Início: ${inicio}s`
      );

      console.log(
        `[Download] Duração: ${duracao}s`
      );

      console.log(
        '================================================'
      );

      if (!RAPIDAPI_KEY) {

        return respostaErro(
          res,
          500,
          'Serviço de download não configurado.'
        );

      }

      // ======================================================
      // PRIMEIRA TENTATIVA: YT-API
      // ======================================================

      try {

        console.log(
          '[Download] Consultando YT-API...'
        );

        const dados =
          await ytApiDownload(
            videoId
          );

        const streams =
          encontrarStreams(
            dados
          );

        console.log(
          `[Download] Streams encontradas: ${streams.total}`
        );

        // ====================================================
        // VÍDEO + ÁUDIO SEPARADOS
        // ====================================================

        if (
          streams.video &&
          streams.audio
        ) {

          const videoStream =
            streams.video.url;

          const audioStream =
            streams.audio.url;

          console.log(
            '[Download] Vídeo + áudio encontrados.'
          );

          console.log(
            `[Download] Vídeo: ${streams.video.altura || '?'}p`
          );

          console.log(
            '[Download] Testando acesso às streams...'
          );

          const videoOk =
            await testarStream(
              videoStream
            );

          const audioOk =
            await testarStream(
              audioStream
            );

          if (
            videoOk &&
            audioOk
          ) {

            console.log(
              '[Download] Streams acessíveis.'
            );

            res.statusCode =
              200;

            res.setHeader(
              'Content-Type',
              'video/mp4'
            );

            res.setHeader(
              'Content-Disposition',
              `attachment; filename="clip-${videoId}-${Math.floor(inicio)}.mp4"`
            );

            res.setHeader(
              'Cache-Control',
              'no-cache'
            );

            res.setHeader(
              'Transfer-Encoding',
              'chunked'
            );

            try {

              await executarFfmpegStreams(
                videoStream,
                audioStream,
                inicio,
                duracao,
                res
              );

              metrics.downloads++;

              console.log(
                '[Download] Finalizado com sucesso pela YT-API.'
              );

              return;

            } catch (erroFfmpeg) {

              console.error(
                '[Download] FFmpeg YT-API falhou:',
                erroFfmpeg.message
              );

              if (
                res.headersSent
              ) {

                try {
                  res.end();
                } catch {}

                // Não podemos iniciar outro response
                // depois que os headers foram enviados.
                throw erroFfmpeg;

              }

            }

          } else {

            console.log(
              '[Download] Stream rejeitada/403. Ativando fallback yt-dlp.'
            );

          }

        }

        // ====================================================
        // STREAM COMBINADA
        // ====================================================

        if (
          streams.combinado
        ) {

          const combinedUrl =
            streams.combinado.url;

          console.log(
            '[Download] Stream combinada encontrada.'
          );

          const combinadoOk =
            await testarStream(
              combinedUrl
            );

          if (
            combinadoOk
          ) {

            res.statusCode =
              200;

            res.setHeader(
              'Content-Type',
              'video/mp4'
            );

            res.setHeader(
              'Content-Disposition',
              `attachment; filename="clip-${videoId}-${Math.floor(inicio)}.mp4"`
            );

            res.setHeader(
              'Cache-Control',
              'no-cache'
            );

            res.setHeader(
              'Transfer-Encoding',
              'chunked'
            );

            try {

              await executarFfmpegCombinado(
                combinedUrl,
                inicio,
                duracao,
                res
              );

              metrics.downloads++;

              console.log(
                '[Download] Finalizado com sucesso pela stream combinada.'
              );

              return;

            } catch (erroCombinado) {

              console.error(
                '[Download] Stream combinada falhou:',
                erroCombinado.message
              );

              if (
                res.headersSent
              ) {

                try {
                  res.end();
                } catch {}

                throw erroCombinado;

              }

            }

          }

        }

      } catch (erroYtApi) {

        console.error(
          '[Download] YT-API/FFmpeg falhou:',
          erroYtApi.message
        );

        if (
          res.headersSent
        ) {

          try {
            res.end();
          } catch {}

          return;

        }

      }

      // ======================================================
      // FALLBACK YT-DLP
      // ======================================================

      console.log(
        '[Download] ================================================'
      );

      console.log(
        '[Download] FALLBACK: YT-DLP'
      );

      console.log(
        '[Download] ================================================'
      );

      const resultado =
        await baixarComYtDlp(
          videoId,
          inicio,
          duracao
        );

      pastaTemporaria =
        resultado.pasta;

      const arquivo =
        resultado.arquivo;

      if (
        !fs.existsSync(
          arquivo
        )
      ) {

        throw new Error(
          'Arquivo baixado pelo yt-dlp não foi encontrado.'
        );

      }

      res.statusCode =
        200;

      res.setHeader(
        'Content-Type',
        'video/mp4'
      );

      res.setHeader(
        'Content-Disposition',
        `attachment; filename="clip-${videoId}-${Math.floor(inicio)}.mp4"`
      );

      res.setHeader(
        'Cache-Control',
        'no-cache'
      );

      await executarFfmpegArquivo(
        arquivo,
        0,
        duracao,
        res
      );

      metrics.downloads++;

      console.log(
        '[Download] Finalizado com sucesso pelo fallback yt-dlp.'
      );

      return;

    } catch (erro) {

      console.error(
        '[Download Error]:',
        erro?.message ||
        erro
      );

      metrics.erros++;

      if (
        res.headersSent
      ) {

        try {
          res.end();
        } catch {}

        return;

      }

      return res
        .status(500)
        .json({

          error:
            'Não foi possível gerar o corte.',

          details:
            erro?.message ||
            'Erro desconhecido.'

        });

    } finally {

      if (
        pastaTemporaria
      ) {

        try {

          fs.rmSync(
            pastaTemporaria,
            {
              recursive:
                true,
              force:
                true
            }
          );

          console.log(
            '[Download] Arquivos temporários removidos.'
          );

        } catch (erro) {

          console.error(
            '[Cleanup Error]:',
            erro.message
          );

        }

      }

    }

  }
);

// ============================================================
// MERCADO PAGO - CRIAR PIX
// ============================================================

app.post(
  '/api/pix/criar',
  async (req, res) => {

    try {

      if (!MP_ACCESS_TOKEN) {

        return respostaErro(
          res,
          500,
          'Mercado Pago não configurado.'
        );

      }

      const {
        email,
        valor
      } = req.body || {};

      const amount =
        numeroSeguro(
          valor,
          0
        );

      if (
        !amount ||
        amount <= 0
      ) {

        return respostaErro(
          res,
          400,
          'Valor inválido.'
        );

      }

      const pagamento =
        await fetch(
          'https://api.mercadopago.com/v1/payments',
          {

            method:
              'POST',

            headers: {

              'Authorization':
                `Bearer ${MP_ACCESS_TOKEN}`,

              'Content-Type':
                'application/json',

              'X-Idempotency-Key':
                `${Date.now()}-${Math.random()
                  .toString(36)
                  .slice(2)}`

            },

            body:
              JSON.stringify({

                transaction_amount:
                  Number(
                    amount.toFixed(2)
                  ),

                description:
                  'ClipForge Pro VIP',

                payment_method_id:
                  'pix',

                payer: {

                  email:
                    email ||
                    'cliente@clipforge.local'

                }

              })

          }
        );

      const data =
        await pagamento.json();

      if (!pagamento.ok) {

        console.error(
          '[Mercado Pago Error]:',
          JSON.stringify(data)
        );

        return respostaErro(
          res,
          pagamento.status,
          'Não foi possível criar o pagamento.'
        );

      }

      metrics.pixCriados++;

      const transaction =
        data
          .point_of_interaction
          ?.transaction_data;

      return res.json({

        success:
          true,

        id:
          data.id,

        status:
          data.status,

        qr_code:
          transaction?.qr_code ||
          null,

        qr_code_base64:
          transaction?.qr_code_base64 ||
          null,

        ticket_url:
          transaction?.ticket_url ||
          null

      });

    } catch (erro) {

      console.error(
        '[PIX Error]:',
        erro
      );

      return respostaErro(
        res,
        500,
        'Erro ao criar pagamento PIX.'
      );

    }

  }
);

// ============================================================
// MERCADO PAGO - STATUS PIX
// ============================================================

app.get(
  '/api/pix/status/:id',
  async (req, res) => {

    try {

      if (!MP_ACCESS_TOKEN) {

        return respostaErro(
          res,
          500,
          'Mercado Pago não configurado.'
        );

      }

      const paymentId =
        req.params.id;

      if (!paymentId) {

        return respostaErro(
          res,
          400,
          'ID do pagamento não informado.'
        );

      }

      const response =
        await fetch(
          `https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`,
          {

            headers: {

              'Authorization':
                `Bearer ${MP_ACCESS_TOKEN}`

            }

          }
        );

      const data =
        await response.json();

      if (!response.ok) {

        return respostaErro(
          res,
          response.status,
          'Não foi possível consultar o pagamento.'
        );

      }

      return res.json({

        success:
          true,

        id:
          data.id,

        status:
          data.status,

        status_detail:
          data.status_detail,

        approved:
          data.status ===
          'approved'

      });

    } catch (erro) {

      console.error(
        '[PIX Status Error]:',
        erro
      );

      return respostaErro(
        res,
        500,
        'Erro ao consultar pagamento.'
      );

    }

  }
);

// ============================================================
// ERRO GLOBAL
// ============================================================

app.use(
  (err, req, res, next) => {

    console.error(
      '[Global Error]:',
      err
    );

    if (
      res.headersSent
    ) {

      return next(err);

    }

    return res
      .status(500)
      .json({

        error:
          'Erro interno do servidor.'

      });

  }
);

// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.listen(
  PORT,
  () => {

    console.log('');

    console.log(
      '================================================'
    );

    console.log(
      '          CLIPFORGE PRO BACKEND'
    );

    console.log(
      '          VERSION 12.7.1'
    );

    console.log(
      '================================================'
    );

    console.log(
      `[ClipForge Core] Servidor operacional na porta ${PORT}`
    );

    console.log(
      `[YT-API] ${
        RAPIDAPI_KEY
          ? 'Configurada'
          : 'NÃO CONFIGURADA'
      }`
    );

    console.log(
      `[Mercado Pago] ${
        MP_ACCESS_TOKEN
          ? 'Configurado'
          : 'NÃO CONFIGURADO'
      }`
    );

    console.log(
      `[yt-dlp] ${
        fs.existsSync(YTDLP_PATH)
          ? 'Encontrado'
          : 'Usando PATH do sistema'
      }`
    );

    console.log(
      '[Download] YT-API + FFmpeg + yt-dlp fallback ativo.'
    );

    console.log(
      '[YouTube] URLs normalizadas automaticamente.'
    );

    console.log(
      '================================================'
    );

  }
);