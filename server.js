// ============================================================
// CLIPFORGE PRO - BACKEND
// VERSION 12.6.1
// RAPIDAPI VIDEO + AUDIO + FFMPEG
// ============================================================

const express = require('express');
const cors = require('cors');

const { execFile } = require('child_process');
const util = require('util');

const app = express();
const PORT = process.env.PORT || 10000;

const execFileAsync = util.promisify(execFile);

// ============================================================
// CONFIGURAÇÕES
// ============================================================

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST ||
  'youtube-video-and-audio-downloader.p.rapidapi.com';

const MP_ACCESS_TOKEN =
  process.env.MP_ACCESS_TOKEN;

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD;

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({
  limit: '2mb'
}));

app.use(express.urlencoded({
  extended: true,
  limit: '2mb'
}));

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

  let valor = String(input).trim();

  // Remove aspas caso o frontend envie
  valor = valor.replace(/^["']|["']$/g, '');

  // ----------------------------------------------------------
  // ID DIRETO
  // ----------------------------------------------------------

  if (/^[a-zA-Z0-9_-]{11}$/.test(valor)) {
    return valor;
  }

  // ----------------------------------------------------------
  // URL
  // ----------------------------------------------------------

  try {

    const url = new URL(valor);

    const hostname =
      url.hostname.toLowerCase();

    // --------------------------------------------------------
    // YOUTUBE.COM
    // --------------------------------------------------------

    if (
      hostname.includes('youtube.com') ||
      hostname.includes('youtube-nocookie.com')
    ) {

      // youtube.com/watch?v=ID

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

      // /shorts/ID

      if (
        partes[0] === 'shorts' &&
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

      // /embed/ID

      if (
        partes[0] === 'embed' &&
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

      // /live/ID

      if (
        partes[0] === 'live' &&
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

    // --------------------------------------------------------
    // YOUTU.BE
    // --------------------------------------------------------

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

  // ----------------------------------------------------------
  // ÚLTIMA TENTATIVA
  // ----------------------------------------------------------

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

function numeroSeguro(valor, padrao = 0) {

  const n = Number(valor);

  if (!Number.isFinite(n)) {
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
    Math.min(maximo, valor)
  );
}

function respostaErro(
  res,
  status,
  mensagem
) {

  metrics.erros++;

  return res.status(status).json({
    error: mensagem
  });
}

// ============================================================
// STATUS
// ============================================================

app.get('/', (req, res) => {

  res.json({
    name: 'ClipForge Pro API',
    version: '12.6.1',
    status: 'online',
    download:
      'RapidAPI Video + Audio + FFmpeg'
  });

});

app.get('/api/status', (req, res) => {

  res.json({

    online: true,

    version: '12.6.1',

    rapidapi:
      Boolean(RAPIDAPI_KEY),

    mercadopago:
      Boolean(MP_ACCESS_TOKEN),

    ffmpeg: true

  });

});

// ============================================================
// ADMIN LOGIN
// ============================================================

app.post('/api/admin/login', (req, res) => {

  const { password } =
    req.body || {};

  if (
    !ADMIN_PASSWORD ||
    !password ||
    password !== ADMIN_PASSWORD
  ) {

    return res.status(401).json({
      error: 'Credencial inválida.'
    });

  }

  return res.json({
    success: true
  });

});

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

      system: {

        version:
          '12.6.1',

        rapidapi:
          Boolean(RAPIDAPI_KEY),

        mercadopago:
          Boolean(MP_ACCESS_TOKEN)

      }

    });

  }
);

// ============================================================
// ANÁLISE
// ============================================================

app.post('/api/analisar', async (req, res) => {

  try {

    const {
      url,
      videoUrl,
      videoId,
      id
    } = req.body || {};

    const entrada =
      id ||
      videoId ||
      url ||
      videoUrl;

    const youtubeId =
      extrairVideoId(entrada);

    if (!youtubeId) {

      return respostaErro(
        res,
        400,
        'URL ou ID do YouTube inválido.'
      );

    }

    metrics.analises++;

    // --------------------------------------------------------
    // CLIPS ATUAIS
    // --------------------------------------------------------

    const clips = [

      {
        id: 1,
        title:
          'Melhor momento',

        start: 35,

        end: 90,

        duration: 55,

        score: 98,

        thumbnail:
          `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`
      },

      {
        id: 2,

        title:
          'Momento de destaque',

        start: 145,

        end: 200,

        duration: 55,

        score: 95,

        thumbnail:
          `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`
      },

      {
        id: 3,

        title:
          'Trecho viral',

        start: 290,

        end: 345,

        duration: 55,

        score: 92,

        thumbnail:
          `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`
      }

    ];

    return res.json({

      success: true,

      videoId:
        youtubeId,

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

});

// ============================================================
// RAPIDAPI DOWNLOAD
// ============================================================

async function rapidApiDownload(
  videoId,
  quality,
  filter
) {

  if (!RAPIDAPI_KEY) {

    throw new Error(
      'RAPIDAPI_KEY não configurada.'
    );

  }

  const url =
    `https://${RAPIDAPI_HOST}/download` +
    `?id=${encodeURIComponent(videoId)}` +
    `&quality=${encodeURIComponent(quality)}` +
    `&filter=${encodeURIComponent(filter)}`;

  console.log(
    `[RapidAPI] Buscando ${filter} para ${videoId}...`
  );

  const response =
    await fetch(url, {

      method: 'GET',

      headers: {

        'x-rapidapi-key':
          RAPIDAPI_KEY,

        'x-rapidapi-host':
          RAPIDAPI_HOST,

        'accept':
          'application/json'

      }

    });

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
      `[RapidAPI ${filter}] HTTP ${response.status}`
    );

    console.error(
      '[RapidAPI Error Body]:',
      JSON.stringify(data)
        .slice(0, 2000)
    );

    throw new Error(
      `RapidAPI retornou HTTP ${response.status}`
    );

  }

  if (
    data?.error ||
    data?.status === 'error'
  ) {

    console.error(
      `[RapidAPI ${filter} Error]:`,
      JSON.stringify(data)
        .slice(0, 2000)
    );

    throw new Error(

      data?.message ||

      data?.error?.message ||

      `Erro ao obter ${filter}`

    );

  }

  return data;
}

// ============================================================
// FORMATOS
// ============================================================

function obterFormatos(data) {

  if (!data) {
    return [];
  }

  if (
    Array.isArray(data.formats)
  ) {
    return data.formats;
  }

  if (
    Array.isArray(data.data)
  ) {
    return data.data;
  }

  if (
    Array.isArray(data.result)
  ) {
    return data.result;
  }

  if (
    Array.isArray(data.links)
  ) {
    return data.links;
  }

  if (
    Array.isArray(data.results)
  ) {
    return data.results;
  }

  if (
    data.url ||
    data.download_url ||
    data.downloadUrl
  ) {
    return [data];
  }

  if (
    data.result &&
    typeof data.result === 'object'
  ) {
    return [data.result];
  }

  if (
    data.data &&
    typeof data.data === 'object'
  ) {
    return [data.data];
  }

  return [];
}

// ============================================================
// URL DO FORMATO
// ============================================================

function obterUrlFormato(item) {

  if (
    !item ||
    typeof item !== 'object'
  ) {
    return null;
  }

  const possiveis = [

    item.url,

    item.download_url,

    item.downloadUrl,

    item.direct_url,

    item.directUrl,

    item.link

  ];

  for (
    const url of possiveis
  ) {

    if (
      typeof url === 'string' &&
      /^https?:\/\//i.test(url)
    ) {

      return url;

    }

  }

  return null;
}

// ============================================================
// TEM VÍDEO
// ============================================================

function formatoTemVideo(item) {

  if (!item) {
    return false;
  }

  if (
    item.hasVideo === true
  ) {
    return true;
  }

  if (
    item.hasVideo === false
  ) {
    return false;
  }

  const texto = [

    item.vcodec,

    item.videoCodec,

    item.video_ext,

    item.videoExt,

    item.mimeType,

    item.mime,

    item.type

  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (

    texto.includes('video') ||

    texto.includes('avc') ||

    texto.includes('av01') ||

    texto.includes('vp9') ||

    texto.includes('h264') ||

    texto.includes('mp4')

  ) {

    return true;

  }

  return (

    Number(item.height) > 0 ||

    Number(item.width) > 0 ||

    Number(item.fps) > 0

  );

}

// ============================================================
// TEM ÁUDIO
// ============================================================

function formatoTemAudio(item) {

  if (!item) {
    return false;
  }

  if (
    item.hasAudio === true
  ) {
    return true;
  }

  if (
    item.hasAudio === false
  ) {
    return false;
  }

  const texto = [

    item.acodec,

    item.audioCodec,

    item.audio_ext,

    item.audioExt,

    item.mimeType,

    item.mime,

    item.type

  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (

    texto.includes('audio') ||

    texto.includes('mp4a') ||

    texto.includes('aac') ||

    texto.includes('opus') ||

    texto.includes('vorbis') ||

    texto.includes('m4a')

  ) {

    return true;

  }

  return (

    Number(item.abr) > 0 &&

    !Number(item.height)

  );

}

// ============================================================
// ESCOLHER VÍDEO
// ============================================================

function escolherVideo(data) {

  const formatos =
    obterFormatos(data);

  const candidatos =
    formatos

      .map(item => ({

        item,

        url:
          obterUrlFormato(item)

      }))

      .filter(x => {

        if (!x.url) {
          return false;
        }

        return formatoTemVideo(
          x.item
        );

      });

  if (!candidatos.length) {

    throw new Error(
      'A RapidAPI não retornou nenhum formato de vídeo.'
    );

  }

  // Preferir vídeo sem áudio

  const videoOnly =
    candidatos.filter(x => {

      return (

        x.item.hasAudio === false ||

        x.item.acodec === 'none' ||

        x.item.audio_ext === 'none'

      );

    });

  const lista =
    videoOnly.length
      ? videoOnly
      : candidatos;

  // Preferir até 720p

  const ate720 =
    lista.filter(x => {

      const altura =
        Number(
          x.item.height || 0
        );

      return (
        altura > 0 &&
        altura <= 720
      );

    });

  const finalistas =
    ate720.length
      ? ate720
      : lista;

  finalistas.sort((a, b) => {

    const alturaA =
      Number(
        a.item.height || 0
      );

    const alturaB =
      Number(
        b.item.height || 0
      );

    if (
      alturaA !== alturaB
    ) {

      return alturaB - alturaA;

    }

    return (

      Number(
        b.item.width || 0
      ) -

      Number(
        a.item.width || 0
      )

    );

  });

  const escolhido =
    finalistas[0];

  console.log(

    `[Download] Vídeo escolhido: ` +

    `${escolhido.item.height || '?'}p ` +

    `${escolhido.item.ext || 'unknown'}`

  );

  return escolhido.url;
}

// ============================================================
// ESCOLHER ÁUDIO
// ============================================================

function escolherAudio(data) {

  const formatos =
    obterFormatos(data);

  const candidatos =
    formatos

      .map(item => ({

        item,

        url:
          obterUrlFormato(item)

      }))

      .filter(x => {

        if (!x.url) {
          return false;
        }

        return formatoTemAudio(
          x.item
        );

      });

  if (!candidatos.length) {

    throw new Error(
      'A RapidAPI não retornou nenhum formato de áudio.'
    );

  }

  // Preferir áudio sem vídeo

  const audioOnly =
    candidatos.filter(x => {

      return (

        x.item.hasVideo === false ||

        x.item.vcodec === 'none' ||

        x.item.video_ext === 'none'

      );

    });

  const lista =
    audioOnly.length
      ? audioOnly
      : candidatos;

  // Preferência por M4A / AAC

  lista.sort((a, b) => {

    function pontuacao(x) {

      let pontos = 0;

      const ext =
        String(
          x.item.ext ||
          x.item.audio_ext ||
          ''
        ).toLowerCase();

      const codec =
        String(
          x.item.acodec ||
          x.item.audioCodec ||
          ''
        ).toLowerCase();

      if (
        ext === 'm4a'
      ) {
        pontos += 1000;
      }

      if (
        codec.includes('mp4a')
      ) {
        pontos += 500;
      }

      if (
        codec.includes('aac')
      ) {
        pontos += 400;
      }

      pontos += Number(
        x.item.abr ||
        x.item.audioBitrate ||
        0
      );

      return pontos;
    }

    return (
      pontuacao(b) -
      pontuacao(a)
    );

  });

  const escolhido =
    lista[0];

  console.log(

    `[Download] Áudio escolhido: ` +

    `${escolhido.item.ext || 'unknown'} ` +

    `${escolhido.item.acodec || ''} ` +

    `${escolhido.item.abr || ''}kbps`

  );

  return escolhido.url;
}

// ============================================================
// FFMPEG
// ============================================================

function executarFfmpeg(
  videoUrl,
  audioUrl,
  inicio,
  duracao,
  res
) {

  console.log(

    `[FFmpeg] Gerando corte: ` +

    `${inicio}s → ${inicio + duracao}s`

  );

  const args = [

    // --------------------------------------------------------
    // VÍDEO
    // --------------------------------------------------------

    '-ss',
    String(inicio),

    '-i',
    videoUrl,

    // --------------------------------------------------------
    // ÁUDIO
    // --------------------------------------------------------

    '-ss',
    String(inicio),

    '-i',
    audioUrl,

    // --------------------------------------------------------
    // DURAÇÃO
    // --------------------------------------------------------

    '-t',
    String(duracao),

    // --------------------------------------------------------
    // MAPAS
    // --------------------------------------------------------

    '-map',
    '0:v:0',

    '-map',
    '1:a:0',

    // --------------------------------------------------------
    // VÍDEO
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // ÁUDIO
    // --------------------------------------------------------

    '-c:a',
    'aac',

    '-b:a',
    '96k',

    '-ar',
    '44100',

    // --------------------------------------------------------
    // MP4
    // --------------------------------------------------------

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

      // Envia o MP4 direto para o usuário

      processo.stdout.pipe(res);

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
        erro => {

          reject(erro);

        }
      );

    }
  );

}

// ============================================================
// DOWNLOAD DO CLIP
// ============================================================

app.get(
  '/api/download',
  async (req, res) => {

    try {

      // ------------------------------------------------------
      // ACEITA TODOS OS NOMES POSSÍVEIS DO FRONTEND
      // ------------------------------------------------------

      const {

        id,

        videoId: videoIdParam,

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
          ? String(entradaVideo).slice(0, 150)
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

      // ------------------------------------------------------
      // TEMPO
      // ------------------------------------------------------

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

      // Limites

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

      // ------------------------------------------------------
      // RAPIDAPI CONFIGURADA?
      // ------------------------------------------------------

      if (!RAPIDAPI_KEY) {

        return respostaErro(

          res,

          500,

          'Serviço de download não configurado.'

        );

      }

      // ------------------------------------------------------
      // BUSCAR VÍDEO + ÁUDIO
      // ------------------------------------------------------

      console.log(
        '[Download] Buscando vídeo e áudio...'
      );

      const [

        videoData,

        audioData

      ] = await Promise.all([

        rapidApiDownload(
          videoId,
          'lowest',
          'video'
        ),

        rapidApiDownload(
          videoId,
          'lowestaudio',
          'audio'
        )

      ]);

      // ------------------------------------------------------
      // ESCOLHER STREAMS
      // ------------------------------------------------------

      const videoStream =
        escolherVideo(
          videoData
        );

      const audioStream =
        escolherAudio(
          audioData
        );

      if (!videoStream) {

        throw new Error(
          'Stream de vídeo não encontrado.'
        );

      }

      if (!audioStream) {

        throw new Error(
          'Stream de áudio não encontrado.'
        );

      }

      console.log(
        '[Download] Vídeo + áudio encontrados.'
      );

      // ------------------------------------------------------
      // HEADERS
      // ------------------------------------------------------

      res.statusCode = 200;

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

      metrics.downloads++;

      // ------------------------------------------------------
      // FFMPEG
      // ------------------------------------------------------

      await executarFfmpeg(

        videoStream,

        audioStream,

        inicio,

        duracao,

        res

      );

      console.log(
        '[Download] Finalizado com sucesso.'
      );

    } catch (erro) {

      console.error(
        '[Download Error]:',
        erro?.message || erro
      );

      metrics.erros++;

      // Se já começou o MP4
      if (res.headersSent) {

        try {
          res.end();
        } catch {}

        return;
      }

      return res.status(500).json({

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

            method: 'POST',

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

        success: true,

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

        success: true,

        id:
          data.id,

        status:
          data.status,

        status_detail:
          data.status_detail,

        approved:
          data.status === 'approved'

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

    if (res.headersSent) {
      return next(err);
    }

    return res.status(500).json({

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
      '          VERSION 12.6.1'
    );
    console.log(
      '================================================'
    );

    console.log(
      `[ClipForge Core] Servidor operacional na porta ${PORT}`
    );

    console.log(
      `[RapidAPI] ${
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
      '[Download] RapidAPI Video + Audio + FFmpeg ativo.'
    );

    console.log(
      '[YouTube] URLs normalizadas automaticamente.'
    );

    console.log(
      '================================================'
    );

  }
);