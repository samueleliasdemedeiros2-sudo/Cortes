
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
    `https://${RAPIDAPI