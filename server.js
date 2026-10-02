const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  GoogleGenAI,
  createUserContent,
  createPartFromUri
} = require('@google/genai');

let mercadopago = null;

try {
  mercadopago = require('mercadopago');
} catch (error) {
  console.warn('[MercadoPago] Módulo não disponível.');
}

// ============================================================
// APP
// ============================================================

const app = express();

app.use(cors({
  origin: '*',
  exposedHeaders: [
    'Content-Disposition',
    'Content-Length'
  ]
}));

app.use(express.json({
  limit: '10mb'
}));

app.use(express.urlencoded({
  extended: true
}));

// ============================================================
// CONFIGURAÇÕES
// ============================================================

const PORT =
  process.env.PORT || 3000;

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || '';

const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  'gemini-3.6-flash';

const RAPIDAPI_KEY =
  process.env.RAPIDAPI_KEY || '';

const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST ||
  'cloud-api-hub-youtube-downloader.p.rapidapi.com';

const MP_ACCESS_TOKEN =
  process.env.MP_ACCESS_TOKEN || '';

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || 'samuel123';

// ============================================================
// GEMINI
// ============================================================

let gemini = null;

if (GEMINI_API_KEY) {
  try {
    gemini = new GoogleGenAI({
      apiKey: GEMINI_API_KEY
    });

    console.log(
      `[Gemini] Cliente iniciado. Modelo: ${GEMINI_MODEL}`
    );
  } catch (error) {
    console.error(
      '[Gemini] Erro ao iniciar:',
      error.message
    );
  }
} else {
  console.warn(
    '[Gemini] GEMINI_API_KEY não configurada.'
  );
}

// ============================================================
// MERCADO PAGO
// ============================================================

let mpClient = null;

if (
  mercadopago &&
  MP_ACCESS_TOKEN &&
  MP_ACCESS_TOKEN.startsWith('APP_USR')
) {
  try {
    mpClient =
      new mercadopago.MercadoPagoConfig({
        accessToken: MP_ACCESS_TOKEN
      });

    console.log(
      '[MercadoPago] Cliente iniciado.'
    );
  } catch (error) {
    console.error(
      '[MercadoPago] Erro:',
      error.message
    );
  }
} else {
  console.warn(
    '[MercadoPago] Cliente não configurado.'
  );
}

// ============================================================
// MÉTRICAS
// ============================================================

const metricas = {
  totalDownloads: 0,
  totalVendas: 0,
  totalAnalises: 0,
  valorArrecadado: 0,
  inicioOperacao: new Date().toISOString()
};

const pagamentos = new Map();

// ============================================================
// UTILITÁRIOS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

// ------------------------------------------------------------
// Extrair ID do YouTube
// ------------------------------------------------------------

function extrairVideoId(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }

  const regExp =
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=|shorts\/)|youtu\.be\/)([^"&?\/\s]{11})/;

  const match =
    url.trim().match(regExp);

  return match ? match[1] : null;
}

// ------------------------------------------------------------
// Limpar JSON retornado pelo Gemini
// ------------------------------------------------------------

function limparJsonGemini(texto) {
  if (!texto) {
    return null;
  }

  let textoLimpo =
    String(texto).trim();

  textoLimpo =
    textoLimpo
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

  try {
    return JSON.parse(textoLimpo);
  } catch (error) {}

  const inicio =
    textoLimpo.indexOf('{');

  const fim =
    textoLimpo.lastIndexOf('}');

  if (
    inicio !== -1 &&
    fim !== -1 &&
    fim > inicio
  ) {
    try {
      return JSON.parse(
        textoLimpo.substring(
          inicio,
          fim + 1
        )
      );
    } catch (error) {}
  }

  return null;
}

// ------------------------------------------------------------
// Limitar números
// ------------------------------------------------------------

function limitarNumero(
  valor,
  minimo,
  maximo,
  padrao
) {
  const numero =
    Number(valor);

  if (!Number.isFinite(numero)) {
    return padrao;
  }

  return Math.min(
    maximo,
    Math.max(
      minimo,
      numero
    )
  );
}

// ------------------------------------------------------------
// Remover arquivo temporário
// ------------------------------------------------------------

function apagarArquivo(arquivo) {
  if (
    arquivo &&
    fs.existsSync(arquivo)
  ) {
    try {
      fs.unlinkSync(arquivo);

      console.log(
        '[Arquivo] Temporário removido.'
      );
    } catch (error) {
      console.warn(
        '[Arquivo] Não foi possível remover:',
        error.message
      );
    }
  }
}

// ============================================================
// STATUS
// ============================================================

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    versao: '10.0.1-GEMINI-AI'
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    uptime: Math.floor(
      process.uptime()
    ),
    gemini: Boolean(gemini),
    modeloGemini: GEMINI_MODEL
  });
});

// ============================================================
// ADMIN
// ============================================================

app.post(
  '/api/admin/login',
  (req, res) => {

    const {
      password
    } = req.body;

    // CORRIGIDO:
    // antes estava comparando com "samuel123"
    // agora usa a variável do Render.

    if (
      !password ||
      password !== ADMIN_PASSWORD
    ) {
      return res.status(401).json({
        error:
          'Credencial inválida.'
      });
    }

    return res.json({
      success: true
    });
  }
);

app.get(
  '/api/admin/dashboard',
  (req, res) => {

    if (
      req.headers.authorization !==
      ADMIN_PASSWORD
    ) {
      return res.status(401).json({
        error:
          'Não autorizado.'
      });
    }

    const memoria =
      process.memoryUsage();

    return res.json({
      status: 'online',

      metricas,

      memoriaUsadaMb:
        Math.round(
          memoria.heapUsed /
          1024 /
          1024
        )
    });
  }
);

// ============================================================
// RAPIDAPI
// ============================================================

async function extrairStreamOficial(
  videoId
) {

  if (!RAPIDAPI_KEY) {
    throw new Error(
      'RAPIDAPI_KEY não configurada no Render.'
    );
  }

  try {

    console.log(
      `[RapidAPI] Obtendo vídeo ${videoId}...`
    );

    const response =
      await axios.get(
        `https://${RAPIDAPI_HOST}/download`,
        {
          params: {
            id: videoId,
            quality: 'lowest',
            filter: 'audioandvideo'
          },

          headers: {
            'x-rapidapi-key':
              RAPIDAPI_KEY,

            'x-rapidapi-host':
              RAPIDAPI_HOST,

            'User-Agent':
              'Mozilla/5.0'
          },

          timeout: 30000
        }
      );

    const data =
      response.data;

    // --------------------------------------------------------
    // formats[]
    // --------------------------------------------------------

    if (
      Array.isArray(
        data?.formats
      )
    ) {

      const formato =
        data.formats.find(
          item =>
            item?.url &&
            !item.url.includes(
              'ytimg.com'
            ) &&
            item.hasAudio !== false &&
            item.hasVideo !== false
        );

      if (formato?.url) {

        console.log(
          '[RapidAPI] Stream encontrado em formats[].'
        );

        return formato.url;
      }
    }

    // --------------------------------------------------------
    // url
    // --------------------------------------------------------

    if (
      typeof data?.url === 'string' &&
      data.url.length > 20 &&
      !data.url.includes(
        'ytimg.com'
      )
    ) {

      console.log(
        '[RapidAPI] Stream encontrado em url.'
      );

      return data.url;
    }

    // --------------------------------------------------------
    // download_url
    // --------------------------------------------------------

    if (
      typeof data?.download_url === 'string' &&
      data.download_url.length > 20
    ) {

      console.log(
        '[RapidAPI] Stream encontrado em download_url.'
      );

      return data.download_url;
   