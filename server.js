const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const {
  GoogleGenAI,
  createUserContent,
  createPartFromUri
} = require('@google/genai');

const app = express();

/* ============================================================
   CONFIGURAÇÃO
============================================================ */

const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST ||
  'cloud-api-hub-youtube-downloader.p.rapidapi.com';

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || 'samuel123';


/* ============================================================
   MIDDLEWARE
============================================================ */

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));


/* ============================================================
   CLIENTE GEMINI
============================================================ */

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


/* ============================================================
   MÉTRICAS
============================================================ */

const metricas = {
  totalDownloads: 0,
  totalVendas: 0,
  totalAnalises: 0,
  valorArrecadado: 0,
  inicioOperacao: new Date().toISOString()
};


/* ============================================================
   PAGAMENTOS
============================================================ */

const pagamentos = new Map();


/* ============================================================
   FUNÇÕES AUXILIARES
============================================================ */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


function extrairVideoId(url) {
  if (!url) return null;

  const texto = String(url).trim();

  const padroes = [
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];

  for (const regex of padroes) {
    const match = texto.match(regex);

    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}


function limitarNumero(valor, minimo, maximo, padrao) {
  const numero = Number(valor);

  if (!Number.isFinite(numero)) {
    return padrao;
  }

  return Math.min(
    maximo,
    Math.max(minimo, numero)
  );
}


function apagarArquivo(arquivo) {
  if (!arquivo) return;

  try {
    if (fs.existsSync(arquivo)) {
      fs.unlinkSync(arquivo);
    }
  } catch (error) {
    console.warn(
      '[Arquivo] Não foi possível apagar:',
      error.message
    );
  }
}


function limparJsonGemini(texto) {
  if (!texto) return '';

  let textoLimpo = String(texto).trim();

  textoLimpo = textoLimpo
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const primeiro = textoLimpo.indexOf('{');
  const ultimo = textoLimpo.lastIndexOf('}');

  if (
    primeiro !== -1 &&
    ultimo !== -1 &&
    ultimo > primeiro
  ) {
    textoLimpo = textoLimpo.slice(
      primeiro,
      ultimo + 1
    );
  }

  return textoLimpo;
}


/* ============================================================
   ROTA PRINCIPAL
============================================================ */

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    nome: 'ClipForge Pro',
    versao: '10.2.0-GEMINI-AI',
    mensagem: 'Servidor ClipForge funcionando.'
  });
});


/* ============================================================
   STATUS
============================================================ */

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    uptime: process.uptime(),

    gemini: Boolean(gemini),
    modelo: GEMINI_MODEL,

    rapidapi: Boolean(RAPIDAPI_KEY),

    mercadoPago: Boolean(MP_ACCESS_TOKEN),

    timestamp: new Date().toISOString()
  });
});


/* ============================================================
   ADMIN LOGIN
============================================================ */

app.post('/api/admin/login', (req, res) => {
  try {
    const { password } = req.body || {};

    if (
      !password ||
      password !== ADMIN_PASSWORD
    ) {
      return res.status(401).json({
        success: false,
        error: 'Credencial inválida.'
      });
    }

    return res.json({
      success: true,
      message: 'Login autorizado.'
    });

  } catch (error) {
    console.error(
      '[Admin Login]',
      error.message
    );

    return res.status(500).json({
      success: false,
      error: 'Erro interno no login.'
    });
  }
});


/* ============================================================
   ADMIN DASHBOARD
============================================================ */

app.get('/api/admin/dashboard', (req, res) => {
  try {
    const autorizacao =
      req.headers.authorization || '';

    if (autorizacao !== ADMIN_PASSWORD) {
      return res.status(401).json({
        success: false,
        error: 'Não autorizado.'
      });
    }

    const memoria =
      process.memoryUsage();

    return res.json({
      success: true,

      metricas: {
        totalDownloads:
          metricas.totalDownloads,

        totalVendas:
          metricas.totalVendas,

        totalAnalises:
          metricas.totalAnalises,

        valorArrecadado:
          Number(
            metricas.valorArrecadado.toFixed(2)
          ),

        inicioOperacao:
          metricas.inicioOperacao
      },

      servidor: {
        uptime:
          process.uptime(),

        memoriaMB:
          Number(
            (
              memoria.heapUsed /
              1024 /
              1024
            ).toFixed(2)
          ),

        node:
          process.version,

        modeloGemini:
          GEMINI_MODEL
      }
    });

  } catch (error) {
    console.error(
      '[Admin Dashboard]',
      error.message
    );

    return res.status(500).json({
      success: false,
      error: 'Erro ao carregar dashboard.'
    });
  }
});


/* ============================================================
   RAPIDAPI - PEGAR STREAM
============================================================ */

async function extrairStreamOficial(videoId) {
  if (!RAPIDAPI_KEY) {
    throw new Error(
      'RAPIDAPI_KEY não configurada no Render.'
    );
  }

  try {
    console.log(
      `[RapidAPI] Buscando stream para ${videoId}...`
    );

    const response = await axios.get(
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

          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',

          'Accept':
            'application/json,text/plain,*/*'
        },

        timeout: 30000,

        validateStatus: status =>
          status >= 200 &&
          status < 300
      }
    );

    const data = response.data;

    console.log(
      '[RapidAPI] Resposta recebida.'
    );

    /* -----------------------------------------
       FORMATS
    ----------------------------------------- */

    if (Array.isArray(data?.formats)) {
      const formatos =
        data.formats.filter(item => {
          return (
            item &&
            item.url &&
            !String(item.url).includes(
              'ytimg.com'
            );
        });

      const formatoCompleto =
        formatos.find(item => {
          return (
            item.hasAudio !== false &&
            item.hasVideo !== false
          );
        });

      if (formatoCompleto?.url) {
        console.log(
          '[RapidAPI] Stream encontrado em formats.'
        );

        return formatoCompleto.url;
      }

      if (formatos[0]?.url) {
        console.log(
          '[RapidAPI] Usando primeiro formato disponível.'
        );

        return formatos[0].url;
      }
    }


    /* -----------------------------------------
       URL DIRETA
    ----------------------------------------- */

    if (
      typeof data?.url === 'string' &&
      data.url.length > 20 &&
      !data.url.includes('ytimg.com')
    ) {
      return data.url;
    }


    /* -----------------------------------------
       DOWNLOAD URL
    ----------------------------------------- */

    if (
      typeof data?.download_url === 'string' &&
      data.download_url.length > 20
    ) {
      return data.download_url;
    }


    /* -----------------------------------------
       RESULTADOS ANINHADOS
    ----------------------------------------- */

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


    console.error(
      '[RapidAPI] Nenhum stream encontrado.'
    );

    return null;

  } catch (error) {
    console.error(
      '[RapidAPI Error]',
      error.response?.data ||
      error.message
    );

    return null;
  }
}


/* ============================================================
   DOWNLOAD TEMPORÁRIO
   TENTA AXIOS E DEPOIS FFMPEG
============================================================ */

async function baixarVideoTemporario(videoUrl) {
  const arquivo =
    path.join(
      os.tmpdir(),
      `clipforge_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2)}.mp4`
    );

  console.log(
    '[Download] Baixando vídeo para análise...'
  );

  /* ==========================================================
     TENTATIVA 1 - AXIOS
  ========================================================== */

  try {
    console.log(
      '[Download] Tentativa 1: Axios...'
    );

    const response =
      await axios.get(
        videoUrl,
        {
          responseType: 'stream',

          timeout: 180000,

          maxContentLength:
            500 * 1024 * 1024,

          maxBodyLength:
            500 * 1024 * 1024,

          maxRedirects: 15,

          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',

            'Accept':
              'video/mp4,video/*,*/*;q=0.8',

            'Accept-Language':
              'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',

            'Referer':
              'https://www.youtube.com/',

            'Origin':
              'https://www.youtube.com'
          },

          validateStatus:
            status =>
              status >= 200 &&
              status < 300
        }
      );


    await new Promise(
      (resolve, reject) => {
        const writer =
          fs.createWriteStream(
            arquivo
          );

        response.data.pipe(
          writer
        );

        writer.on(
          'finish',
          resolve
        );

        writer.on(
          'error',
          reject
        );

        response.data.on(
          'error',
          reject
        );
      }
    );


    const stats =
      fs.statSync(arquivo);

    if (
      !stats.size ||
      stats.size < 1000
    ) {
      throw new Error(
        'O vídeo baixado está vazio ou inválido.'
      );
    }

    console.log(
      `[Download] Vídeo salvo: ${(
        stats.size /
        1024 /
        1024
      ).toFixed(2)} MB`
    );

    return arquivo;

  } catch (error) {
    apagarArquivo(arquivo);

    const status =
      error?.response?.status;

    console.warn(
      '[Download] Axios falhou:',
      status
        ? `HTTP ${status}`
        : error.message
    );
  }


  /* ==========================================================
     TENTATIVA 2 - FFMPEG
  ========================================================== */

  console.log(
    '[Download] Tentativa 2: FFmpeg direto...'
  );

  try {
    await executarFfmpegDownload(
      videoUrl,
      arquivo
    );

    const stats =
      fs.statSync(arquivo);

    if (
      !stats.size ||
      stats.size < 1000
    ) {
      throw new Error(
        'FFmpeg gerou um arquivo inválido.'
      );
    }

    console.log(
      `[Download] FFmpeg salvou: ${(
        stats.size /
        1024 /
        1024
      ).toFixed(2)} MB`
    );

    return arquivo;

  } catch (error) {
    apagarArquivo(arquivo);

    console.error(
      '[Download] FFmpeg falhou:',
      error.message
    );

    throw new Error(
      `Falha ao baixar o vídeo: ${error.message}`
    );
  }
}


/* ============================================================
   FFMPEG DOWNLOAD
============================================================ */

function executarFfmpegDownload(
  videoUrl,
  arquivo
) {
  return new Promise(
    (resolve, reject) => {

      const headers =
        [
          'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
          'Accept: video/mp4,video/*,*/*;q=0.8',
          'Referer: https://www.youtube.com/',
          'Origin: https://www.youtube.com'
        ].join('\r\n') +
        '\r\n';


      const args = [
        '-y',

        '-hide_banner',

        '-loglevel',
        'error',

        '-headers',
        headers,

        '-i',
        videoUrl,

        '-c',
        'copy',

        '-movflags',
        '+faststart',

        arquivo
      ];


      const processo =
        spawn(
          'ffmpeg',
          args
        );


      let stderr = '';

      processo.stderr.on(
        'data',
        data => {
          stderr += data.toString();
        }
      );


      processo.on(
        'error',
        error => {
          reject(
            new Error(
              `FFmpeg não pôde ser iniciado: ${error.message}`
            )
          );
        }
      );


      processo.on(
        'close',
        codigo => {

          if (codigo === 0) {
            resolve();
            return;
          }

          reject(
            new Error(
              stderr.trim() ||
              `FFmpeg encerrou com código ${codigo}.`
            )
          );
        }
      );
    }
  );
}


/* ============================================================
   GEMINI - ESPERAR ARQUIVO
============================================================ */

async function esperarArquivoGemini(
  arquivo
) {
  let atual = arquivo;
  let tentativa = 0;

  while (true) {

    const estado =
      String(
        atual?.state || ''
      ).toUpperCase();


    if (
      estado === 'ACTIVE'
    ) {
      console.log(
        '[Gemini] Vídeo pronto para análise.'
      );

      return atual;
    }


    if (
      estado === 'FAILED' ||
      estado === 'ERROR'
    ) {
      throw new Error(
        'O Gemini não conseguiu processar o vídeo.'
      );
    }


    tentativa++;


    if (tentativa > 60) {
      throw new Error(
        'Tempo limite excedido no processamento do vídeo pelo Gemini.'
      );
    }


    console.log(
      `[Gemini] Processando vídeo... tentativa ${tentativa}/60`
    );


    await sleep(5000);


    atual =
      await gemini.files.get({
        name: atual.name
      });
  }
}


/* ============================================================
   NORMALIZAR CORTES
============================================================ */

function normalizarClips(
  clips,
  duracaoVideo,
  quantidade,
  duracaoSolicitada
) {
  if (!Array.isArray(clips)) {
    return [];
  }

  const resultado = [];

  for (
    const clip of clips
  ) {

    if (
      !clip ||
      typeof clip !== 'object'
    ) {
      continue;
    }


    let inicio =
      Number(
        clip.start ??
        clip.inicio ??
        clip.startTime ??
        0
      );


    let fim =
      Number(
        clip.end ??
        clip.fim ??
        clip.endTime ??
        (inicio + duracaoSolicitada)
      );


    if (!Number.isFinite(inicio)) {
      inicio = 0;
    }

    if (!Number.isFinite(fim)) {
      fim =
        inicio +
        duracaoSolicitada;
    }


    inicio =
      Math.max(
        0,
        Math.floor(inicio)
      );


    fim =
      Math.max(
        inicio + 5,
        Math.floor(fim)
      );


    if (
      Number.isFinite(duracaoVideo) &&
      duracaoVideo > 0
    ) {
      inicio =
        Math.min(
          inicio,
          Math.max(
            0,
            duracaoVideo - 5
          )
        );

      fim =
        Math.min(
          fim,
          duracaoVideo
        );
    }


    const duracao =
      Math.max(
        5,
        fim - inicio
      );


    let score =
      Number(
        clip.score ??
        clip.pontuacao ??
        clip.viralScore ??
        80
      );


    if (!Number.isFinite(score)) {
      score = 80;
    }


    score =
      Math.max(
        0,
        Math.min(
          100,
          Math.round(score)
        )
      );


    const titulo =
      String(
        clip.title ??
        clip.titulo ??
        `Corte ${resultado.length + 1}`
      ).trim();


    const motivo =
      String(
        clip.reason ??
        clip.motivo ??
        clip.description ??
        'Momento relevante identificado pela IA.'
      ).trim();


    resultado.push({
      id:
        resultado.length + 1,

      title:
        titulo || `Corte ${resultado.length + 1}`,

      description:
        motivo,

      start:
        inicio,

      end:
        fim,

      duration:
        duracao,

      score,

      thumbnail:
        clip.thumbnail ||
        clip.thumb ||
        null
    });


    if (
      resultado.length >= quantidade
    ) {
      break;
    }
  }


  return resultado;
}


/* ============================================================
   ANALISAR VÍDEO COM GEMINI
============================================================ */

app.post(
  '/api/analisar',
  async (req, res) => {

    let arquivoTemporario = null;

    try {

      const {
        youtubeUrl,
        duration = 60,
        quantity = 3
      } = req.body || {};


      /* -----------------------------------------
         VALIDAÇÃO
      ----------------------------------------- */

      if (!youtubeUrl) {
        return res.status(400).json({
          success: false,
          error:
            'Informe o link do vídeo do YouTube.'
        });
      }


      const videoId =
        extrairVideoId(
          youtubeUrl
        );


      if (!videoId) {
        return res.status(400).json({
          success: false,
          error:
            'Link do YouTube inválido.'
        });
      }


      if (!gemini) {
        return res.status(503).json({
          success: false,
          error:
            'Gemini não está configurado no servidor.'
        });
      }


      if (!RAPIDAPI_KEY) {
        return res.status(503).json({
          success: false,
          error:
            'RapidAPI não está configurada no servidor.'
        });
      }


      const duracaoSolicitada =
        limitarNumero(
          duration,
          15,
          120,
          60
        );


      const quantidade =
        Math.round(
          limitarNumero(
            quantity,
            1,
            5,
            3
          )
        );


      metricas.totalAnalises++;


      console.log('');
      console.log(
        '============================================'
      );
      console.log(
        '[ANÁLISE] Nova análise solicitada'
      );
      console.log(
        `[ANÁLISE] Vídeo: ${videoId}`
      );
      console.log(
        `[ANÁLISE] Cortes: ${quantidade}`
      );
      console.log(
        `[ANÁLISE] Duração: ${duracaoSolicitada}s`
      );
      console.log(
        '============================================'
      );


      /* -----------------------------------------
         STREAM RAPIDAPI
      ----------------------------------------- */

      let streamUrl =
        await extrairStreamOficial(
          videoId
        );


      if (!streamUrl) {
        return res.status(503).json({
          success: false,
          error:
            'Não foi possível obter o stream do vídeo pela RapidAPI.'
        });
      }


      /* -----------------------------------------
         DOWNLOAD LOCAL
      ----------------------------------------- */

      try {

        arquivoTemporario =
          await baixarVideoTemporario(
            streamUrl
          );

      } catch (primeiroErro) {

        console.warn(
          '[ANÁLISE] Primeiro download falhou.'
        );

        console.warn(
          primeiroErro.message
        );


        /* ---------------------------------------
           TENTA PEGAR STREAM NOVAMENTE
        --------------------------------------- */

        console.log(
          '[ANÁLISE] Buscando novo stream...'
        );


        streamUrl =
          await extrairStreamOficial(
            videoId
          );


        if (!streamUrl) {
          throw primeiroErro;
        }


        arquivoTemporario =
          await baixarVideoTemporario(
            streamUrl
          );
      }


      /* -----------------------------------------
         UPLOAD GEMINI
      ----------------------------------------- */

      console.log(
        '[Gemini] Enviando vídeo para análise...'
      );


      const arquivoGemini =
        await gemini.files.upload({
          file: arquivoTemporario,

          config: {
            mimeType: 'video/mp4'
          }
        });


      console.log(
        `[Gemini] Arquivo enviado: ${arquivoGemini.name}`
      );


      /* -----------------------------------------
         ESPERAR PROCESSAMENTO
      ----------------------------------------- */

      const arquivoPronto =
        await esperarArquivoGemini(
          arquivoGemini
        );


      /* -----------------------------------------
         PROMPT
      ----------------------------------------- */

      const prompt = `
Você é o sistema de análise de vídeos do ClipForge Pro.

Analise o vídeo inteiro.

Encontre os momentos com maior potencial para virar cortes curtos para redes sociais.

Procure principalmente por:

- frases fortes
- momentos engraçados
- opiniões polêmicas
- histórias interessantes
- reações
- informações surpreendentes
- momentos emocionantes
- frases que gerem curiosidade
- trechos com começo, desenvolvimento e conclusão
- momentos que funcionem sozinhos fora do contexto

IMPORTANTE:

1. Analise o vídeo inteiro antes de escolher os cortes.
2. Não invente acontecimentos.
3. Os timestamps precisam existir realmente no vídeo.
4. Cada corte deve ter aproximadamente ${duracaoSolicitada} segundos.
5. Gere no máximo ${quantidade} cortes.
6. Evite escolher vários cortes praticamente iguais.
7. Os cortes devem ser independentes sempre que possível.
8. O score deve representar o potencial do trecho para redes sociais.
9. Use score de 0 a 100.
10. Retorne SOMENTE JSON válido.

Formato obrigatório:

{
  "clips": [
    {
      "title": "Título curto",
      "description": "Por que esse momento é interessante",
      "start": 120,
      "end": 180,
      "score": 94
    }
  ]
}
`;


      /* -----------------------------------------
         GERAR RESPOSTA
      ----------------------------------------- */

      console.log(
        '[Gemini] Analisando vídeo...'
      );


      const resultado =
        await gemini.models.generateContent({
          model:
            GEMINI_MODEL,

          contents:
            createUserContent([
              createPartFromUri(
                arquivoPronto.uri,
                arquivoPronto.mimeType ||
                  'video/mp4'
              ),

              prompt
            ]),

          config: {
            responseMimeType:
              'application/json'
          }
        });


      const texto =
        resultado?.text ||
        resultado?.response?.text ||
        '';


      if (!texto) {
        throw new Error(
          'O Gemini não retornou uma resposta.'
        );
      }


      console.log(
        '[Gemini] Resposta recebida.'
      );


      /* -----------------------------------------
         PARSE JSON
      ----------------------------------------- */

      const jsonLimpo =
        limparJsonGemini(
          texto
        );


      let dados;

      try {

        dados =
          JSON.parse(
            jsonLimpo
          );

      } catch (error) {

        console.error(
          '[Gemini] JSON inválido:',
          jsonLimpo
        );

        throw new Error(
          'A IA retornou uma resposta inválida.'
        );
      }


      const clips =
        normalizarClips(
          dados?.clips,
          null,
          quantidade,
          duracaoSolicitada
        );


      if (
        !clips.length
      ) {
        throw new Error(
          'A IA não encontrou cortes neste vídeo.'
        );
      }


      console.log(
        `[Gemini] ${clips.length} cortes encontrados.`
      );


      /* -----------------------------------------
         RESPOSTA
      ----------------------------------------- */

      return res.json({
        success: true,

        videoId,

        clips
      });


    } catch (error) {

      console.error('');
      console.error(
        '============================================'
      );
      console.error(
        '[ANÁLISE] ERRO'
      );
      console.error(
        error?.response?.data ||
        error?.message ||
        error
      );
      console.error(
        '============================================'
      );
      console.error('');


      const mensagem =
        String(
          error?.message ||
          ''
        );


      if (
        mensagem.includes(
          'API key'
        ) ||
        mensagem.includes(
          'API_KEY'
        ) ||
        mensagem.includes(
          'authentication'
        ) ||
        mensagem.includes(
          '401'
        )
      ) {
        return res.status(500).json({
          success: false,
          error:
            'A chave da IA não foi aceita pelo Gemini.'
        });
      }


      if (
        mensagem.includes(
          'quota'
        ) ||
        mensagem.includes(
          'RESOURCE_EXHAUSTED'
        ) ||
        mensagem.includes(
          '429'
        )
      ) {
        return res.status(429).json({
          success: false,
          error:
            'O limite de uso da IA foi atingido. Tente novamente mais tarde.'
        });
      }


      return res.status(500).json({
        success: false,

        error:
          mensagem ||
          'Não foi possível analisar o vídeo.'
      });


    } finally {

      if (
        arquivoTemporario
      ) {
        apagarArquivo(
          arquivoTemporario
        );
      }
    }
  }
);


/* ============================================================
   DOWNLOAD DE CORTE
============================================================ */

app.get(
  '/api/download',
  async (req, res) => {

    let processo = null;

    try {

      const {
        id,
        start = 0,
        duration = 60
      } = req.query;


      if (!id) {
        return res.status(400).json({
          success: false,
          error:
            'ID do vídeo não informado.'
        });
      }


      const videoId =
        extrairVideoId(id) ||
        id;


      const inicio =
        Math.max(
          0,
          Number(start) || 0
        );


      const duracao =
        limitarNumero(
          duration,
          5,
          120,
          60
        );


      console.log(
        `[Download] Preparando corte ${videoId} | início ${inicio}s | duração ${duracao}s`
      );


      const streamUrl =
        await extrairStreamOficial(
          videoId
        );


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
        `attachment; filename="clipforge-${videoId}-${Math.floor(inicio)}s.mp4"`
      );

      res.setHeader(
        'Cache-Control',
        'no-store'
      );


      /* -----------------------------------------
         FFMPEG
      ----------------------------------------- */

      const headers =
        [
          'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
          'Accept: video/mp4,video/*,*/*;q=0.8',
          'Referer: https://www.youtube.com/',
          'Origin: https://www.youtube.com'
        ].join('\r\n') +
        '\r\n';


      const args = [
        '-hide_banner',
        '-loglevel',
        'error',

        '-ss',
        String(inicio),

        '-headers',
        headers,

        '-i',
        streamUrl,

        '-t',
        String(duracao),

        '-vf',
        'scale=-2:360',

        '-c:v',
        'libx264',

        '-preset',
        'ultrafast',

        '-tune',
        'zerolatency',

        '-crf',
        '32',

        '-pix_fmt',
        'yuv420p',

        '-g',
        '15',

        '-keyint_min',
        '15',

        '-c:a',
        'aac',

        '-b:a',
        '96k',

        '-ac',
        '2',

        '-ar',
        '44100',

        '-movflags',
        'frag_keyframe+empty_moov+default_base_moof',

        '-f',
        'mp4',

        'pipe:1'
      ];


      processo =
        spawn(
          'ffmpeg',
          args
        );


      let erroFfmpeg =
        '';


      processo.stderr.on(
        'data',
        data => {
          erroFfmpeg +=
            data.toString();
        }
      );


      processo.stdout.pipe(
        res
      );


      processo.on(
        'error',
        error => {

          console.error(
            '[FFmpeg Download]',
            error.message
          );

          if (
            !res.headersSent
          ) {
            res.status(500).json({
              success: false,
              error:
                'Erro ao iniciar FFmpeg.'
            });
          } else {
            res.destroy(
              error
            );
          }
        }
      );


      processo.on(
        'close',
        codigo => {

          if (
            codigo === 0
          ) {

            metricas.totalDownloads++;

            console.log(
              '[Download] Corte concluído.'
            );

            return;
          }


          console.error(
            '[FFmpeg] Código:',
            codigo
          );

          console.error(
            '[FFmpeg]',
            erroFfmpeg
          );


          if (
            !res.destroyed
          ) {
            res.destroy();
          }
        }
      );


      req.on(
        'close',
        () => {

          if (
            processo &&
            !processo.killed
          ) {
            processo.kill(
              'SIGKILL'
            );
          }
        }
      );


    } catch (error) {

      console.error(
        '[Download Error]',
        error.message
      );


      if (
        !res.headersSent
      ) {
        return res.status(500).json({
          success: false,
          error:
            error.message ||
            'Falha ao gerar o corte.'
        });
      }


      if (
        !res.destroyed
      ) {
        res.destroy();
      }
    }
  }
);


/* ============================================================
   PIX - CRIAR PAGAMENTO
============================================================ */

app.post(
  '/api/pix/criar',
  async (req, res) => {

    try {

      const {
        userId = 'anonimo',
        valor = 19.90
      } = req.body || {};


      const valorFormatado =
        Number(
          parseFloat(
            valor
          ).toFixed(2)
        );


      if (
        !Number.isFinite(
          valorFormatado
        ) ||
        valorFormatado <= 0
      ) {
        return res.status(400).json({
          success: false,
          error:
            'Valor do pagamento inválido.'
        });
      }


      /* -----------------------------------------
         MERCADO PAGO NÃO CONFIGURADO
      ----------------------------------------- */

      if (!MP_ACCESS_TOKEN) {

        console.warn(
          '[PIX] MP_ACCESS_TOKEN não configurado.'
        );


        const mockId =
          `mock_${Date.now()}`;


        pagamentos.set(
          mockId,
          {
            id: mockId,

            status:
              'approved',

            userId,

            valor:
              valorFormatado,

            criadoEm:
              new Date().toISOString(),

            mock:
              true
          }
        );


        return res.json({
          success: true,

          id:
            mockId,

          status:
            'approved',

          qr_code:
            'PIX indisponível: Mercado Pago não configurado.',

          qr_code_base64:
            null,

          mock:
            true
        });
      }


      /* -----------------------------------------
         MERCADO PAGO
      ----------------------------------------- */

      console.log(
        '[PIX] Criando pagamento...'
      );


      const resposta =
        await axios.post(
          'https://api.mercadopago.com/v1/payments',

          {
            transaction_amount:
              valorFormatado,

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
                `clipforge-${Date.now()}-${Math.random()
                  .toString(36)
                  .slice(2)}`
            },

            timeout:
              30000
          }
        );


      const pagamento =
        resposta.data;


      const id =
        String(
          pagamento.id
        );


      const transacao =
        pagamento
          ?.point_of_interaction
          ?.transaction_data;


      const qrCode =
        transacao?.qr_code ||
        null;


      const qrCodeBase64 =
        transacao?.qr_code_base64 ||
        null;


      pagamentos.set(
        id,
        {
          id,

          userId,

          valor:
            valorFormatado,

          status:
            pagamento.status ||
            'pending',

          criadoEm:
            new Date().toISOString()
        }
      );


      console.log(
        `[PIX] Pagamento criado: ${id}`
      );


      return res.json({
        success: true,

        id,

        status:
          pagamento.status ||
          'pending',

        qr_code:
          qrCode,

        qr_code_base64:
          qrCodeBase64
      });


    } catch (error) {

      console.error(
        '[PIX Criar]',
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
          error.message ||
          'Não foi possível criar o pagamento PIX.'
      });
    }
  }
);


/* ============================================================
   PIX - STATUS
============================================================ */

app.get(
  '/api/pix/status/:id',
  async (req, res) => {

    try {

      const id =
        String(
          req.params.id
        );


      if (
        !id
      ) {
        return res.status(400).json({
          success: false,
          error:
            'ID do pagamento não informado.'
        });
      }


      /* -----------------------------------------
         MOCK
      ----------------------------------------- */

      if (
        id.startsWith(
          'mock_'
        )
      ) {

        const pagamento =
          pagamentos.get(
            id
          );


        return res.json({
          success: true,

          id,

          status:
            pagamento?.status ||
            'approved'
        });
      }


      /* -----------------------------------------
         MERCADO PAGO
      ----------------------------------------- */

      if (!MP_ACCESS_TOKEN) {
        return res.status(503).json({
          success: false,
          error:
            'Mercado Pago não configurado.'
        });
      }


      const resposta =
        await axios.get(
          `https://api.mercadopago.com/v1/payments/${encodeURIComponent(id)}`,

          {
            headers: {
              Authorization:
                `Bearer ${MP_ACCESS_TOKEN}`
            },

            timeout:
              30000
          }
        );


      const pagamento =
        resposta.data;


      const status =
        pagamento.status ||
        'pending';


      const anterior =
        pagamentos.get(
          id
        );


      pagamentos.set(
        id,
        {
          ...(anterior || {}),

          id,

          status,

          valor:
            Number(
              pagamento.transaction_amount ||
              anterior?.valor ||
              0
            ),

          atualizadoEm:
            new Date().toISOString()
        }
      );


      /* -----------------------------------------
         APROVADO
      ----------------------------------------- */

      if (
        status === 'approved' &&
        !(anterior?.contabilizado)
      ) {

        metricas.totalVendas++;

        metricas.valorArrecadado +=
          Number(
            pagamento.transaction_amount ||
            anterior?.valor ||
            0
          );


        pagamentos.set(
          id,
          {
            ...(pagamentos.get(id) || {}),

            contabilizado:
              true
          }
        );
      }


      return res.json({
        success: true,

        id,

        status
      });


    } catch (error) {

      console.error(
        '[PIX Status]',
        error.response?.data ||
        error.message
      );


      return res.status(
        error.response?.status || 500
      ).json({
        success: false,

        error:
          error.response?.data?.message ||
          error.message ||
          'Não foi possível consultar o pagamento.'
      });
    }
  }
);


/* ============================================================
   404
============================================================ */

app.use(
  (req, res) => {

    res.status(404).json({
      success: false,

      error:
        'Rota não encontrada.',

      path:
        req.path
    });
  }
);


/* ============================================================
   ERRO GLOBAL
============================================================ */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      '[ERRO GLOBAL]',
      error
    );


    if (
      res.headersSent
    ) {
      return next(
        error
      );
    }


    return res.status(500).json({
      success: false,

      error:
        'Erro interno do servidor.'
    });
  }
);


/* ============================================================
   INICIAR SERVIDOR
============================================================ */

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log('');
    console.log(
      '============================================'
    );

    console.log(
      '        CLIPFORGE PRO SERVER'
    );

    console.log(
      '============================================'
    );

    console.log(
      `Porta: ${PORT}`
    );

    console.log(
      `Gemini: ${
        gemini
          ? 'CONFIGURADO'
          : 'NÃO CONFIGURADO'
      }`
    );

    console.log(
      `Modelo: ${GEMINI_MODEL}`
    );

    console.log(
      `RapidAPI: ${
        RAPIDAPI_KEY
          ? 'CONFIGURADA'
          : 'NÃO CONFIGURADA'
      }`
    );

    console.log(
      `Mercado Pago: ${
        MP_ACCESS_TOKEN
          ? 'CONFIGURADO'
          : 'NÃO CONFIGURADO'
      }`
    );

    console.log(
      '============================================'
    );

    console.log('');
  }
);