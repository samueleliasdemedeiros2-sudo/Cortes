const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { spawn } = require('child_process');
const { GoogleGenAI } = require('@google/genai');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ======================================================
// CONFIGURAÇÃO
// ======================================================

const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST ||
  'cloud-api-hub-youtube-downloader.p.rapidapi.com';

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

let gemini = null;

if (GEMINI_API_KEY) {
  try {
    gemini = new GoogleGenAI({
      apiKey: GEMINI_API_KEY
    });

    console.log(`[Gemini] Cliente iniciado. Modelo: ${GEMINI_MODEL}`);
  } catch (error) {
    console.error('[Gemini] Erro ao iniciar:', error.message);
  }
} else {
  console.warn('[Gemini] GEMINI_API_KEY não configurada.');
}

// ======================================================
// MÉTRICAS
// ======================================================

const metricas = {
  totalDownloads: 0,
  totalVendas: 0,
  totalAnalises: 0,
  valorArrecadado: 0,
  inicioOperacao: new Date().toISOString()
};

const pagamentos = new Map();

// ======================================================
// HELPERS
// ======================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function limitarNumero(valor, minimo, maximo, padrao) {
  const numero = Number(valor);

  if (!Number.isFinite(numero)) {
    return padrao;
  }

  return Math.max(minimo, Math.min(maximo, numero));
}

function extrairVideoId(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }

  const texto = url.trim();

  // ID direto
  if (/^[a-zA-Z0-9_-]{11}$/.test(texto)) {
    return texto;
  }

  try {
    const parsed = new URL(texto);

    if (
      parsed.hostname.includes('youtube.com') ||
      parsed.hostname.includes('youtube-nocookie.com')
    ) {
      const v = parsed.searchParams.get('v');

      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) {
        return v;
      }

      const partes = parsed.pathname.split('/').filter(Boolean);

      if (
        ['shorts', 'embed', 'live'].includes(partes[0]) &&
        partes[1] &&
        /^[a-zA-Z0-9_-]{11}$/.test(partes[1])
      ) {
        return partes[1];
      }
    }

    if (parsed.hostname === 'youtu.be') {
      const id = parsed.pathname.replace('/', '').split('/')[0];

      if (/^[a-zA-Z0-9_-]{11}$/.test(id)) {
        return id;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function limparJsonGemini(texto) {
  if (!texto) {
    throw new Error('O Gemini não retornou conteúdo.');
  }

  let textoLimpo = String(texto).trim();

  textoLimpo = textoLimpo
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const primeiro = textoLimpo.indexOf('{');
  const ultimo = textoLimpo.lastIndexOf('}');

  if (primeiro !== -1 && ultimo !== -1 && ultimo > primeiro) {
    textoLimpo = textoLimpo.slice(primeiro, ultimo + 1);
  }

  return JSON.parse(textoLimpo);
}

function normalizarClips(clips, videoId, quantidade, duracaoDesejada) {
  if (!Array.isArray(clips)) {
    return [];
  }

  const resultado = [];

  for (let i = 0; i < clips.length && resultado.length < quantidade; i++) {
    const item = clips[i] || {};

    let inicio = Number(
      item.start ??
      item.startTime ??
      item.inicio ??
      0
    );

    let fim = Number(
      item.end ??
      item.endTime ??
      item.fim ??
      (inicio + duracaoDesejada)
    );

    if (!Number.isFinite(inicio)) {
      inicio = 0;
    }

    if (!Number.isFinite(fim)) {
      fim = inicio + duracaoDesejada;
    }

    inicio = Math.max(0, inicio);
    fim = Math.max(inicio + 1, fim);

    let duracao = fim - inicio;

    if (duracao > 180) {
      fim = inicio + 180;
      duracao = 180;
    }

    const score = Number(
      item.score ??
      item.pontuacao ??
      item.viralScore ??
      0
    );

    resultado.push({
      id: i + 1,

      title:
        item.title ||
        item.titulo ||
        `Corte ${i + 1}`,

      description:
        item.description ||
        item.descricao ||
        item.reason ||
        'Momento selecionado pela IA.',

      start: Math.round(inicio),

      end: Math.round(fim),

      duration: Math.round(duracao),

      score: Math.max(
        0,
        Math.min(
          100,
          Number.isFinite(score) ? score : 0
        )
      ),

      thumbnail:
        `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
    });
  }

  return resultado;
}

// ======================================================
// RAPIDAPI
// ======================================================

async function extrairStreamOficial(videoId) {
  if (!RAPIDAPI_KEY) {
    throw new Error(
      'RAPIDAPI_KEY não configurada no Render.'
    );
  }

  try {
    const resposta = await axios.get(
      `https://${RAPIDAPI_HOST}/download`,
      {
        params: {
          id: videoId,
          quality: 'lowest',
          filter: 'audioandvideo'
        },

        headers: {
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': RAPIDAPI_HOST,
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json,text/plain,*/*'
        },

        timeout: 30000,

        validateStatus: status =>
          status >= 200 && status < 300
      }
    );

    const data = resposta.data;

    if (Array.isArray(data?.formats)) {
      const formatos = data.formats.filter(item =>
        item?.url &&
        !String(item.url).includes('ytimg.com')
      );

      const completo = formatos.find(item =>
        item.hasAudio !== false &&
        item.hasVideo !== false
      );

      if (completo?.url) {
        return completo.url;
      }

      if (formatos[0]?.url) {
        return formatos[0].url;
      }
    }

    if (
      typeof data?.url === 'string' &&
      data.url.length > 20 &&
      !data.url.includes('ytimg.com')
    ) {
      return data.url;
    }

    if (
      typeof data?.download_url === 'string' &&
      data.download_url.length > 20
    ) {
      return data.download_url;
    }

    if (
      typeof data?.result?.url === 'string' &&
      data.result.url.length > 20
    ) {
      return data.result.url;
    }

    if (
      typeof data?.result?.download_url === 'string' &&
      data.result.download_url.length > 20
    ) {
      return data.result.download_url;
    }

    return null;

  } catch (error) {
    console.error(
      '[RapidAPI]',
      error.response?.data || error.message
    );

    return null;
  }
}

// ======================================================
// FFmpeg
// ======================================================

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

    const argumentos = [
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
      'veryfast',

      '-crf',
      '28',

      '-c:a',
      'aac',

      '-b:a',
      '96k',

      '-movflags',
      'frag_keyframe+empty_moov',

      '-f',
      'mp4',

      '-headers',
      headers,

      'pipe:1'
    ];

    const processo = spawn(
      'ffmpeg',
      argumentos,
      {
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    let erro = '';

    processo.stderr.on('data', dados => {
      erro += dados.toString();
    });

    processo.stdout.pipe(res);

    processo.on('error', error => {
      reject(error);
    });

    processo.on('close', codigo => {

      if (codigo === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          erro ||
          `FFmpeg terminou com código ${codigo}.`
        )
      );
    });

    res.on('close', () => {
      if (!processo.killed) {
        processo.kill('SIGKILL');
      }
    });
  });
}

// ======================================================
// GEMINI — ANÁLISE DIRETA DO YOUTUBE
// ======================================================

async function analisarComGemini(
  youtubeUrl,
  videoId,
  quantidade,
  duracaoDesejada
) {
  if (!gemini) {
    throw new Error(
      'Gemini não está configurado no Render.'
    );
  }

  const prompt = `
Você é o motor de seleção de cortes virais do ClipForge Pro.

Analise o vídeo completo do YouTube fornecido.

Encontre exatamente ${quantidade} momentos com maior potencial para Shorts, Reels ou TikTok.

Cada corte deve:
- ter começo e fim reais dentro do vídeo;
- ter entre ${Math.max(15, duracaoDesejada - 10)} e ${Math.min(180, duracaoDesejada + 20)} segundos quando possível;
- começar antes do momento principal para preservar contexto;
- terminar depois do momento principal;
- priorizar gancho forte;
- priorizar emoção, surpresa, humor, informação ou conflito;
- evitar introduções longas;
- evitar silêncio;
- evitar partes sem conteúdo;
- não inventar timestamps.

IMPORTANTE:
Os timestamps precisam corresponder a momentos reais encontrados no vídeo.

Retorne SOMENTE JSON válido neste formato:

{
  "clips": [
    {
      "title": "Título curto",
      "description": "Por que esse momento é interessante",
      "start": 0,
      "end": 60,
      "score": 95
    }
  ]
}

Não escreva Markdown.
Não use blocos de código.
Não coloque texto antes ou depois do JSON.
`;

  console.log(
    `[Gemini] Analisando YouTube diretamente: ${videoId}`
  );

  const resposta =
    await gemini.models.generateContent({

      model: GEMINI_MODEL,

      contents: [
        {
          role: 'user',

          parts: [
            {
              fileData: {
                fileUri: youtubeUrl,
                mimeType: 'video/*'
              }
            },

            {
              text: prompt
            }
          ]
        }
      ],

      config: {
        responseMimeType: 'application/json'
      }
    });

  const texto = resposta.text;

  console.log(
    '[Gemini] Resposta recebida.'
  );

  const dados = limparJsonGemini(texto);

  const clips = normalizarClips(
    dados.clips,
    videoId,
    quantidade,
    duracaoDesejada
  );

  if (!clips.length) {
    throw new Error(
      'O Gemini não encontrou cortes válidos neste vídeo.'
    );
  }

  return clips;
}

// ======================================================
// ROTAS BÁSICAS
// ======================================================

app.get('/', (req, res) => {
  res.json({
    success: true,
    name: 'ClipForge Server',
    version: '2.0.0',
    status: 'online'
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    status: 'online',
    gemini: Boolean(gemini),
    rapidapi: Boolean(RAPIDAPI_KEY),
    mercadopago: Boolean(MP_ACCESS_TOKEN),
    model: GEMINI_MODEL,
    uptime: process.uptime()
  });
});

// ======================================================
// ANALISAR VÍDEO
// ======================================================

app.post('/api/analisar', async (req, res) => {

  const inicio = Date.now();

  try {

    const {
      youtubeUrl,
      duration = 60,
      quantity = 3
    } = req.body || {};

    if (!youtubeUrl) {
      return res.status(400).json({
        success: false,
        error: 'Informe a URL do YouTube.'
      });
    }

    const videoId = extrairVideoId(youtubeUrl);

    if (!videoId) {
      return res.status(400).json({
        success: false,
        error: 'URL do YouTube inválida.'
      });
    }

    if (!GEMINI_API_KEY || !gemini) {
      return res.status(503).json({
        success: false,
        error: 'Gemini não configurado no servidor.'
      });
    }

    const quantidade = limitarNumero(
      quantity,
      1,
      5,
      3
    );

    const duracaoDesejada = limitarNumero(
      duration,
      15,
      180,
      60
    );

    console.log(
      `[Análise] Iniciando ${videoId} | ${quantidade} cortes | ${duracaoDesejada}s`
    );

    /*
      IMPORTANTE:

      NÃO baixamos o vídeo aqui.

      O Gemini recebe diretamente a URL pública do YouTube.
      Isso elimina o gargalo antigo de:
      YouTube -> Render -> MP4 -> Gemini.
    */

    const clips = await analisarComGemini(
      youtubeUrl,
      videoId,
      quantidade,
      duracaoDesejada
    );

    metricas.totalAnalises++;

    console.log(
      `[Análise] Finalizada em ${Date.now() - inicio}ms`
    );

    return res.json({
      success: true,
      videoId,
      clips,
      elapsedMs: Date.now() - inicio
    });

  } catch (error) {

    console.error(
      '[Análise Error]',
      error.response?.data ||
      error.message ||
      error
    );

    let mensagem =
      error.message ||
      'Não foi possível analisar o vídeo.';

    const textoErro = String(mensagem).toLowerCase();

    if (
      textoErro.includes('quota') ||
      textoErro.includes('rate limit') ||
      textoErro.includes('429')
    ) {
      mensagem =
        'Limite da API Gemini atingido. Tente novamente mais tarde.';
    }

    if (
      textoErro.includes('403') ||
      textoErro.includes('permission')
    ) {
      mensagem =
        'O Gemini não conseguiu acessar este vídeo. Verifique se o vídeo é público.';
    }

    if (
      textoErro.includes('youtube') &&
      textoErro.includes('access')
    ) {
      mensagem =
        'Não foi possível acessar este vídeo do YouTube.';
    }

    return res.status(500).json({
      success: false,
      error: mensagem
    });
  }
});

// ======================================================
// DOWNLOAD DE CORTE
// ======================================================

app.get('/api/download', async (req, res) => {

  try {

    const {
      id,
      start = 0,
      duration = 60
    } = req.query;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'ID do vídeo não informado.'
      });
    }

    if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) {
      return res.status(400).json({
        success: false,
        error: 'ID do YouTube inválido.'
      });
    }

    const inicio = limitarNumero(
      start,
      0,
      86400,
      0
    );

    const duracao = limitarNumero(
      duration,
      5,
      180,
      60
    );

    console.log(
      `[Download] ${id} | início=${inicio}s | duração=${duracao}s`
    );

    let streamUrl =
      await extrairStreamOficial(id);

    if (!streamUrl) {
      return res.status(503).json({
        success: false,
        error:
          'Não foi possível obter o vídeo para download.'
      });
    }

    res.statusCode = 200;

    res.setHeader(
      'Content-Type',
      'video/mp4'
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="clipforge-${id}-${inicio}.mp4"`
    );

    res.setHeader(
      'Cache-Control',
      'no-store'
    );

    await executarDownloadComFfmpeg(
      streamUrl,
      inicio,
      duracao,
      res
    );

    metricas.totalDownloads++;

    console.log(
      `[Download] Concluído: ${id}`
    );

  } catch (error) {

    console.error(
      '[Download Error]',
      error.message
    );

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error:
          'Não foi possível gerar o corte.'
      });
    }
  }
});

// ======================================================
// MERCADO PAGO — CRIAR PIX
// ======================================================

app.post('/api/pix/criar', async (req, res) => {

  try {

    if (!MP_ACCESS_TOKEN) {
      return res.status(503).json({
        success: false,
        error:
          'Mercado Pago não configurado no servidor.'
      });
    }

    const valor = Number(
      req.body?.valor || 19.90
    );

    if (
      !Number.isFinite(valor) ||
      valor <= 0
    ) {
      return res.status(400).json({
        success: false,
        error: 'Valor inválido.'
      });
    }

    const idempotencyKey =
      `clipforge-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;

    const resposta = await axios.post(
      'https://api.mercadopago.com/v1/payments',

      {
        transaction_amount:
          Number(valor.toFixed(2)),

        description:
          'ClipForge Pro VIP',

        payment_method_id:
          'pix',

        payer: {
          email:
            'cliente@clipforge.local'
        }
      },

      {
        headers: {
          Authorization:
            `Bearer ${MP_ACCESS_TOKEN}`,

          'Content-Type':
            'application/json',

          'X-Idempotency-Key':
            idempotencyKey
        },

        timeout: 30000
      }
    );

    const pagamento = resposta.data;

    pagamentos.set(
      String(pagamento.id),
      {
        id: pagamento.id,
        status: pagamento.status,
        valor,
        criadoEm: new Date().toISOString()
      }
    );

    return res.json({
      success: true,

      id: pagamento.id,

      status:
        pagamento.status,

      qr_code:
        pagamento.point_of_interaction
          ?.transaction_data
          ?.qr_code || null,

      qr_code_base64:
        pagamento.point_of_interaction
          ?.transaction_data
          ?.qr_code_base64 || null
    });

  } catch (error) {

    console.error(
      '[Mercado Pago]',
      error.response?.data ||
      error.message
    );

    return res.status(
      error.response?.status || 500
    ).json({
      success: false,
      error:
        error.response?.data?.message ||
        error.response?.data?.error ||
        'Não foi possível criar o pagamento Pix.'
    });
  }
});

// ======================================================
// MERCADO PAGO — STATUS PIX
// ======================================================

app.get('/api/pix/status/:id', async (req, res) => {

  try {

    if (!MP_ACCESS_TOKEN) {
      return res.status(503).json({
        success: false,
        error:
          'Mercado Pago não configurado.'
      });
    }

    const id = String(
      req.params.id || ''
    ).trim();

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'ID do pagamento inválido.'
      });
    }

    const resposta = await axios.get(
      `https://api.mercadopago.com/v1/payments/${encodeURIComponent(id)}`,

      {
        headers: {
          Authorization:
            `Bearer ${MP_ACCESS_TOKEN}`
        },

        timeout: 30000
      }
    );

    const pagamento =
      resposta.data;

    const status =
      pagamento.status;

    if (status === 'approved') {

      const registro =
        pagamentos.get(id);

      if (
        registro &&
        !registro.processado
      ) {

        registro.processado = true;

        metricas.totalVendas++;

        metricas.valorArrecadado +=
          Number(registro.valor || 0);
      }
    }

    return res.json({
      success: true,
      id,
      status,
      approved:
        status === 'approved'
    });

  } catch (error) {

    console.error(
      '[Mercado Pago Status]',
      error.response?.data ||
      error.message
    );

    return res.status(
      error.response?.status || 500
    ).json({
      success: false,
      error:
        error.response?.data?.message ||
        'Não foi possível consultar o pagamento.'
    });
  }
});

// ======================================================
// ADMIN LOGIN
// ======================================================

app.post('/api/admin/login', (req, res) => {

  const senha =
    req.body?.password || '';

  if (
    !ADMIN_PASSWORD ||
    senha !== ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      success: false,
      error: 'Senha incorreta.'
    });
  }

  return res.json({
    success: true,
    token: ADMIN_PASSWORD
  });
});

// ======================================================
// ADMIN DASHBOARD
// ======================================================

app.get('/api/admin/dashboard', (req, res) => {

  const autorizacao =
    req.headers.authorization || '';

  if (
    !ADMIN_PASSWORD ||
    autorizacao !== ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      success: false,
      error: 'Não autorizado.'
    });
  }

  return res.json({
    success: true,

    metricas: {
      ...metricas,

      uptime:
        process.uptime(),

      memoria:
        process.memoryUsage()
    }
  });
});

// ======================================================
// 404
// ======================================================

app.use((req, res) => {

  res.status(404).json({
    success: false,
    error: 'Rota não encontrada.'
  });
});

// ======================================================
// ERRO GLOBAL
// ======================================================

app.use((error, req, res, next) => {

  console.error(
    '[Erro Global]',
    error
  );

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    error:
      'Erro interno do servidor.'
  });
});

// ======================================================
// SERVIDOR
// ======================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log('');
    console.log('========================================');
    console.log('       CLIPFORGE SERVER 2.0');
    console.log('========================================');
    console.log(`Porta: ${PORT}`);
    console.log(`Gemini: ${gemini ? 'OK' : 'NÃO CONFIGURADO'}`);
    console.log(`RapidAPI: ${RAPIDAPI_KEY ? 'OK' : 'NÃO CONFIGURADA'}`);
    console.log(`Mercado Pago: ${MP_ACCESS_TOKEN ? 'OK' : 'NÃO CONFIGURADO'}`);
    console.log(`Modelo: ${GEMINI_MODEL}`);
    console.log('========================================');
    console.log('');
  }
);