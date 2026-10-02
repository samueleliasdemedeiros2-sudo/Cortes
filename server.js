// ============================================================
// CLIPFORGE PRO - BACKEND
// VERSION 12.7.0
// BASE: VERSION 12.6.2
// DOWNLOAD: YT-API /dl + FFMPEG
// ============================================================

const express = require('express');
const cors = require('cors');

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

  // ID direto
  if (
    /^[a-zA-Z0-9_-]{11}$/.test(valor)
  ) {
    return valor;
  }

  try {

    let valorUrl = valor;

    // Aceita URL sem https
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

    // youtube.com
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

    // youtu.be
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
    // Continua para regex
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
        '12.7.0',

      status:
        'online',

      download:
        'YT-API Download/Stream + FFmpeg'

    });

  }
);

app.get(
  '/api/status',
  (req, res) => {

    res.json({

      online: true,

      version:
        '12.7.0',

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
        'yt-api.p.rapidapi.com'

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
          '12.7.0',

        rapidapi:
          Boolean(
            RAPIDAPI_KEY
          ),

        mercadopago:
          Boolean(
            MP_ACCESS_TOKEN
          ),

        ytapi:
          true

      },

      servidor: {

        version:
          '12.7.0',

        rapidapi:
          Boolean(
            RAPIDAPI_KEY
          ),

        mercadopago:
          Boolean(
            MP_ACCESS_TOKEN
          ),

        ytapi:
          true

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

      // Mantido exatamente como no 12.6.2
      // para não alterar o funcionamento atual
      // da análise.

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
// YT-API DOWNLOAD / STREAM
// ============================================================
//
// Endpoint utilizado:
//
// GET https://yt-api.p.rapidapi.com/dl
//
// Parâmetros:
// id    = ID do YouTube
// cgeo  = BR
//
// O retorno contém URLs diretas do GoogleVideo.
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
            'application/json'

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
// COLETAR TODAS AS URLS DO RETORNO
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
// ANALISAR TIPO DA URL
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
    texto.includes(
      'videoplayback'
    ) &&
    !texto.includes(
      'mime=audio'
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

  // ==========================================================
  // VÍDEO
  // ==========================================================

  const videos =
    streams.filter(
      stream =>
        stream.video &&
        !stream.audio
    );

  // Caso a API retorne uma URL combinada
  const combinados =
    streams.filter(
      stream =>
        stream.video &&
        stream.audio
    );

  // ==========================================================
  // ÁUDIO
  // ==========================================================

  const audios =
    streams.filter(
      stream =>
        stream.audio &&
        !stream.video
    );

  // ==========================================================
  // ESCOLHER VÍDEO
  // ==========================================================

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

        const alturaA =
          Number(
            a.altura || 0
          );

        const alturaB =
          Number(
            b.altura || 0
          );

        return (
          alturaB -
          alturaA
        );

      }
    );

    videoEscolhido =
      lista[0];

  }

  // ==========================================================
  // ESCOLHER ÁUDIO
  // ==========================================================

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

  // ==========================================================
  // FALLBACK COMBINADO
  // ==========================================================

  let combinadoEscolhido =
    null;

  if (
    combinados.length
  ) {

    combinadoEscolhido =
      combinados[0];

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
// DOWNLOAD DE STREAM REMOTA
// ============================================================

async function baixarStream(
  url
) {

  console.log(
    '[YT-API] Baixando stream remoto...'
  );

  const response =
    await fetch(
      url,
      {

        headers: {

          'User-Agent':
            'Mozilla/5.0 ClipForge/12.7',

          'Accept':
            '*/*'

        }

      }
    );

  if (
    !response.ok
  ) {

    throw new Error(
      `Falha ao acessar stream: HTTP ${response.status}`
    );

  }

  const arrayBuffer =
    await response.arrayBuffer();

  return Buffer.from(
    arrayBuffer
  );

}

// ============================================================
// FFMPEG COM STREAMS DIRETAS
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

    '-ss',
    String(inicio),

    '-i',
    videoUrl,

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

      const processo =
        execFile(
          'ffmpeg',
          args,
          {
            maxBuffer:
              1024 * 1024 * 10
          },
          (error) => {

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
            texto.includes(
              'frame='
            ) ||
            texto.includes(
              'time='
            )
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

          reject(
            erro
          );

        }
      );

    }
  );

}

// ============================================================
// FFMPEG USANDO ARQUIVOS TEMPORÁRIOS
// ============================================================

async function executarFfmpegArquivos(
  videoBuffer,
  audioBuffer,
  inicio,
  duracao,
  res
) {

  const os =
    require('os');

  const fs =
    require('fs');

  const path =
    require('path');

  const pasta =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        'clipforge-'
      )
    );

  const videoFile =
    path.join(
      pasta,
      'video'
    );

  const audioFile =
    path.join(
      pasta,
      'audio'
    );

  try {

    fs.writeFileSync(
      videoFile,
      videoBuffer
    );

    fs.writeFileSync(
      audioFile,
      audioBuffer
    );

    console.log(
      '[FFmpeg] Arquivos temporários criados.'
    );

    const args = [

      '-ss',
      String(inicio),

      '-i',
      videoFile,

      '-ss',
      String(inicio),

      '-i',
      audioFile,

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

    await new Promise(
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
                  '[FFmpeg Error]:',
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
              texto.includes(
                'frame='
              ) ||
              texto.includes(
                'time='
              )
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

  } finally {

    try {
      fs.rmSync(
        pasta,
        {
          recursive:
            true,
          force:
            true
        }
      );
    } catch {}

  }

}

// ============================================================
// DOWNLOAD DO CLIP
// ============================================================

app.get(
  '/api/download',
  async (req, res) => {

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
        '[Download] NOVO DOWNLOAD'
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

      // ========================================================
      // BUSCAR URLs REAIS NO YT-API
      // ========================================================

      console.log(
        '[Download] Consultando YT-API...'
      );

      const dados =
        await ytApiDownload(
          videoId
        );

      // ========================================================
      // LOCALIZAR STREAMS
      // ========================================================

      const streams =
        encontrarStreams(
          dados
        );

      console.log(
        `[Download] Streams encontradas: ${streams.total}`
      );

      // ========================================================
      // CASO TENHA VÍDEO + ÁUDIO SEPARADOS
      // ========================================================

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
          `[Download] Áudio encontrado.`
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

        await executarFfmpegStreams(
          videoStream,
          audioStream,
          inicio,
          duracao,
          res
        );

        metrics.downloads++;

        console.log(
          '[Download] Finalizado com sucesso.'
        );

        return;

      }

      // ========================================================
      // CASO TENHA STREAM COMBINADA
      // ========================================================

      if (
        streams.combinado
      ) {

        console.log(
          '[Download] Stream combinada encontrada.'
        );

        const combinedUrl =
          streams.combinado.url;

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

        const args = [

          '-ss',
          String(inicio),

          '-i',
          combinedUrl,

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

        await new Promise(
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
                  texto.includes(
                    'frame='
                  ) ||
                  texto.includes(
                    'time='
                  )
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

        metrics.downloads++;

        console.log(
          '[Download] Finalizado com sucesso.'
        );

        return;

      }

      throw new Error(
        'O YT-API não retornou um stream de vídeo e áudio utilizável.'
      );

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
      '          VERSION 12.7.0'
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
      '[Download] YT-API /dl + FFmpeg ativo.'
    );

    console.log(
      '[YouTube] URLs normalizadas automaticamente.'
    );

    console.log(
      '================================================'
    );

  }
);