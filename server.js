const express = require('express');
const cors = require('cors');
const axios = require('axios');
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

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ==========================================================
// CONFIGURAÇÕES
// ==========================================================

const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST ||
  'cloud-api-hub-youtube-downloader.p.rapidapi.com';

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'samuel123';

// ==========================================================
// GEMINI
// ==========================================================

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

// ==========================================================
// MÉTRICAS
// ==========================================================

const metricas = {
  totalDownloads: 0,
  totalVendas: 0,
  totalAnalises: 0,
  valorArrecadado: 0,
  inicioOperacao: new Date().toISOString()
};

const pagamentos = new Map();

// ==========================================================
// UTILITÁRIOS
// ==========================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function extrairVideoId(url) {
  if (!url) return null;

  const texto = String(url).trim();

  const match = texto.match(
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=|shorts\/)|youtu\.be\/)([^"&?\/\s]{11})/
  );

  return match && match[1]
    ? match[1]
    : null;
}

async function apagarArquivo(arquivo) {
  if (!arquivo) return;

  try {
    await fs.promises.unlink(arquivo);
  } catch (_) {}
}

function limparJsonGemini(texto) {
  if (!texto) return '';

  let resultado = String(texto).trim();

  resultado = resultado
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const inicioObjeto = resultado.indexOf('{');
  const fimObjeto = resultado.lastIndexOf('}');

  if (
    inicioObjeto >= 0 &&
    fimObjeto > inicioObjeto
  ) {
    return resultado.slice(
      inicioObjeto,
      fimObjeto + 1
    );
  }

  const inicioArray = resultado.indexOf('[');
  const fimArray = resultado.lastIndexOf(']');

  if (
    inicioArray >= 0 &&
    fimArray > inicioArray
  ) {
    return resultado.slice(
      inicioArray,
      fimArray + 1
    );
  }

  return resultado;
}

// ==========================================================
// NORMALIZAÇÃO DOS CORTES
// ==========================================================

function normalizarClips(clips, quantidade, duracaoSolicitada, videoId) {
  if (!Array.isArray(clips)) {
    return [];
  }

  const resultado = [];

  for (
    let i = 0;
    i < clips.length && resultado.length < quantidade;
    i++
  ) {
    const clip = clips[i] || {};

    let inicio = Number(
      clip.start ??
      clip.inicio ??
      clip.startTime ??
      0
    );

    let fim = Number(
      clip.end ??
      clip.fim ??
      clip.endTime ??
      0
    );

    let duracao = Number(
      clip.duration ??
      clip.duracao ??
      0
    );

    if (!Number.isFinite(inicio) || inicio < 0) {
      inicio = 0;
    }

    if (!Number.isFinite(duracao) || duracao <= 0) {
      duracao = duracaoSolicitada;
    }

    if (
      !Number.isFinite(fim) ||
      fim <= inicio
    ) {
      fim = inicio + duracao;
    }

    duracao = Math.max(
      5,
      Math.min(180, fim - inicio)
    );

    fim = inicio + duracao;

    let score = Number(
      clip.score ??
      clip.pontuacao ??
      clip.viralScore ??
      80
    );

    if (!Number.isFinite(score)) {
      score = 80;
    }

    score = Math.max(
      0,
      Math.min(100, score)
    );

    resultado.push({
      id: clip.id || i + 1,

      title:
        clip.title ||
        clip.titulo ||
        `Corte Viral #${i + 1}`,

      reason:
        clip.reason ||
        clip.description ||
        clip.motivo ||
        'Trecho identificado pela IA como potencialmente interessante.',

      start: Number(inicio.toFixed(2)),

      end: Number(fim.toFixed(2)),

      duration: Number(duracao.toFixed(2)),

      score: Math.round(score),

      thumbnail:
        clip.thumbnail ||
        `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
    });
  }

  return resultado;
}

// ==========================================================
// RAPIDAPI - OBTER STREAM DO YOUTUBE
// ==========================================================

async function extrairStreamOficial(videoId) {
  if (!RAPIDAPI_KEY) {
    throw new Error(
      'RAPIDAPI_KEY não configurada no Render.'
    );
  }

  try {
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
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
          'Accept':
            'application/json,text/plain,*/*'
        },

        timeout: 30000,

        maxRedirects: 10,

        validateStatus: status =>
          status >= 200 && status < 300
      }
    );

    const data = response.data;

    // ------------------------------------------
    // formats[]
    // ------------------------------------------

    if (Array.isArray(data?.formats)) {
      const formatos = data.formats.filter(
        item =>
          item &&
          typeof item.url === 'string' &&
          item.url.length > 20 &&
          !item.url.includes('ytimg.com')
      );

      const formatoCompleto =
        formatos.find(
          item =>
            item.hasAudio !== false &&
            item.hasVideo !== false
        );

      if (formatoCompleto?.url) {
        return formatoCompleto.url;
      }

      if (formatos[0]?.url) {
        return formatos[0].url;
      }
    }

    // ------------------------------------------
    // possíveis formatos de resposta
    // ------------------------------------------

    const possiveisUrls = [
      data?.url,
      data?.download_url,
      data?.downloadUrl,
      data?.result?.url,
      data?.result?.download_url,
      data?.result?.downloadUrl,
      data?.data?.url,
      data?.data?.download_url
    ];

    for (const url of possiveisUrls) {
      if (
        typeof url === 'string' &&
        url.length > 20 &&
        !url.includes('ytimg.com')
      ) {
        return url;
      }
    }

    console.error(
      '[RapidAPI] Nenhum stream encontrado. Resposta:',
      JSON.stringify(data).slice(0, 3000)
    );

    return null;

  } catch (error) {
    console.error(
      '[RapidAPI Error]',
      error.response?.status,
      error.response?.data ||
      error.message
    );

    return null;
  }
}

// ==========================================================
// DOWNLOAD TEMPORÁRIO DO VÍDEO
// ==========================================================

function executarFfmpegDownload(videoUrl, arquivo) {
  return new Promise((resolve, reject) => {
    const headers =
      [
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
        'Accept: */*',
        'Referer: https://www.youtube.com/',
        'Origin: https://www.youtube.com'
      ].join('\r\n') + '\r\n';

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

    console.log('[FFmpeg] Iniciando download...');

    const processo = spawn(
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
        reject(error);
      }
    );

    processo.on(
      'close',
      codigo => {
        if (codigo === 0) {
          resolve(arquivo);
        } else {
          reject(
            new Error(
              `FFmpeg falhou (${codigo}): ${stderr.slice(-2000)}`
            )
          );
        }
      }
    );
  });
}

async function baixarVideoTemporario(videoUrl) {
  const nomeArquivo =
    `clipforge-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.mp4`;

  const arquivo = path.join(
    os.tmpdir(),
    nomeArquivo
  );

  try {
    console.log(
      '[Download] Tentando Axios...'
    );

    const response = await axios.get(
      videoUrl,
      {
        responseType: 'stream',

        timeout: 180000,

        maxRedirects: 15,

        maxContentLength:
          500 * 1024 * 1024,

        maxBodyLength:
          500 * 1024 * 1024,

        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
          'Accept':
            'video/mp4,video/*;q=0.9,*/*;q=0.8',
          'Referer':
            'https://www.youtube.com/',
          'Origin':
            'https://www.youtube.com'
        },

        validateStatus: status =>
          status >= 200 && status < 300
      }
    );

    await new Promise(
      (resolve, reject) => {
        const writer =
          fs.createWriteStream(arquivo);

        response.data.pipe(writer);

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
      await fs.promises.stat(arquivo);

    if (!stats.size) {
      throw new Error(
        'O arquivo baixado está vazio.'
      );
    }

    console.log(
      `[Download] Axios OK: ${Math.round(stats.size / 1024 / 1024)} MB`
    );

    return arquivo;

  } catch (axiosError) {

    console.warn(
      '[Download] Axios falhou:',
      axiosError.response?.status ||
      axiosError.message
    );

    await apagarArquivo(arquivo);

    console.log(
      '[Download] Tentando FFmpeg...'
    );

    try {
      await executarFfmpegDownload(
        videoUrl,
        arquivo
      );

      const stats =
        await fs.promises.stat(arquivo);

      if (!stats.size) {
        throw new Error(
          'FFmpeg gerou um arquivo vazio.'
        );
      }

      console.log(
        `[Download] FFmpeg OK: ${Math.round(stats.size / 1024 / 1024)} MB`
      );

      return arquivo;

    } catch (ffmpegError) {

      await apagarArquivo(arquivo);

      throw new Error(
        `Não foi possível baixar o vídeo. Axios: ${
          axiosError.response?.status ||
          axiosError.message
        }. FFmpeg: ${
          ffmpegError.message
        }`
      );
    }
  }
}

// ==========================================================
// GEMINI - ESPERAR ARQUIVO
// ==========================================================

async function esperarArquivoGemini(arquivo) {
  let atual = arquivo;

  for (let tentativa = 1; tentativa <= 60; tentativa++) {

    const estado =
      String(
        atual?.state ||
        atual?.status ||
        ''
      ).toUpperCase();

    console.log(
      `[Gemini] Estado do arquivo: ${estado || 'desconhecido'} (${tentativa}/60)`
    );

    if (
      estado === 'ACTIVE' ||
      estado === 'READY'
    ) {
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

    await sleep(5000);

    atual =
      await gemini.files.get({
        name: atual.name
      });
  }

  throw new Error(
    'Tempo limite excedido no processamento do vídeo pelo Gemini.'
  );
}

// ==========================================================
// API - STATUS
// ==========================================================

app.get('/', (req, res) => {
  res.json({
    online: true,
    service: 'ClipForge Pro Server',
    version: '1.0.3',
    gemini: Boolean(GEMINI_API_KEY),
    rapidapi: Boolean(RAPIDAPI_KEY),
    mercadoPago: Boolean(MP_ACCESS_TOKEN),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    online: true,
    version: '1.0.3',
    gemini: Boolean(GEMINI_API_KEY),
    rapidapi: Boolean(RAPIDAPI_KEY),
    mercadoPago: Boolean(MP_ACCESS_TOKEN)
  });
});

// ==========================================================
// API - ANÁLISE COM GEMINI
// ==========================================================

app.post('/api/analisar', async (req, res) => {
  let arquivoTemporario = null;

  try {
    const {
      youtubeUrl,
      duration = 60,
      quantity = 3
    } = req.body || {};

    const videoId =
      extrairVideoId(youtubeUrl);

    if (!videoId) {
      return res.status(400).json({
        success: false,
        error:
          'Link do YouTube inválido.'
      });
    }

    if (!GEMINI_API_KEY || !gemini) {
      return res.status(500).json({
        success: false,
        error:
          'GEMINI_API_KEY não está configurada no servidor.'
      });
    }

    if (!RAPIDAPI_KEY) {
      return res.status(500).json({
        success: false,
        error:
          'RAPIDAPI_KEY não está configurada no servidor.'
      });
    }

    const duracaoSolicitada =
      limitarNumero(
        duration,
        15,
        180,
        60
      );

    const quantidade =
      limitarNumero(
        quantity,
        1,
        5,
        3
      );

    metricas.totalAnalises++;

    console.log(
      `[Análise] Iniciando vídeo ${videoId}`
    );

    // ------------------------------------------
    // 1. Pegar URL do vídeo
    // ------------------------------------------

    let streamUrl =
      await extrairStreamOficial(
        videoId
      );

    if (!streamUrl) {
      return res.status(503).json({
        success: false,
        error:
          'A API de download do YouTube não retornou um vídeo disponível.'
      });
    }

    // ------------------------------------------
    // 2. Baixar temporariamente
    // ------------------------------------------

    try {
      arquivoTemporario =
        await baixarVideoTemporario(
          streamUrl
        );

    } catch (primeiroErro) {

      console.warn(
        '[Análise] Primeiro download falhou. Obtendo novo stream...'
      );

      // Tenta obter URL nova porque
      // URLs do YouTube podem expirar.

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

    console.log(
      '[Análise] Vídeo baixado. Enviando para Gemini...'
    );

    // ------------------------------------------
    // 3. Upload para Gemini
    // ------------------------------------------

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

    // ------------------------------------------
    // 4. Esperar processamento
    // ------------------------------------------

    const arquivoPronto =
      await esperarArquivoGemini(
        arquivoGemini
      );

    console.log(
      '[Gemini] Vídeo pronto para análise.'
    );

    // ------------------------------------------
    // 5. Prompt
    // ------------------------------------------

    const prompt = `
Você é o sistema de análise de vídeos do ClipForge Pro.

Analise o VÍDEO COMPLETO enviado nesta requisição.

Não invente acontecimentos.
Não crie timestamps aleatórios.
Os timestamps precisam corresponder a trechos que realmente aparecem no vídeo.

Objetivo:
Encontrar ${quantidade} cortes curtos com potencial de retenção para redes sociais.

Para cada corte, procure principalmente:
- frases fortes;
- momentos surpreendentes;
- opiniões;
- histórias interessantes;
- conflitos;
- revelações;
- perguntas e respostas;
- momentos engraçados;
- informações úteis;
- mudanças emocionais;
- momentos que funcionem mesmo fora do contexto completo.

Cada corte deve ter aproximadamente ${duracaoSolicitada} segundos.

REGRAS:
- start deve ser o segundo real em que o trecho começa.
- end deve ser o segundo real em que termina.
- duration deve ser end - start.
- Não use timestamps negativos.
- Não invente títulos genéricos quando for possível descrever o conteúdo real.
- O score deve ser um número de 0 a 100.
- Retorne no máximo ${quantidade} cortes.
- Priorize trechos diferentes entre si.
- Evite cortes quase iguais.

Responda SOMENTE com JSON válido neste formato:

{
  "clips": [
    {
      "id": 1,
      "title": "Título curto do corte",
      "reason": "Por que esse trecho pode funcionar bem como corte",
      "start": 120,
      "end": 175,
      "duration": 55,
      "score": 94
    }
  ]
}
`;

    // ------------------------------------------
    // 6. Gemini analisa o vídeo
    // ------------------------------------------

    console.log(
      '[Gemini] Analisando conteúdo...'
    );

    const resultado =
      await gemini.models.generateContent({
        model: GEMINI_MODEL,

        contents: createUserContent([
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

    // ------------------------------------------
    // 7. Obter resposta
    // ------------------------------------------

    const texto =
      resultado?.text ||
      resultado?.response?.text?.() ||
      '';

    if (!texto) {
      throw new Error(
        'O Gemini não retornou uma análise.'
      );
    }

    console.log(
      '[Gemini] Resposta recebida.'
    );

    // ------------------------------------------
    // 8. Parse JSON
    // ------------------------------------------

    const jsonLimpo =
      limparJsonGemini(texto);

    let dados;

    try {
      dados =
        JSON.parse(jsonLimpo);
    } catch (parseError) {
      console.error(
        '[Gemini] JSON inválido:',
        texto.slice(0, 3000)
      );

      throw new Error(
        'A IA retornou uma resposta inválida. Tente analisar novamente.'
      );
    }

    const clipsBrutos =
      Array.isArray(dados)
        ? dados
        : dados?.clips;

    const clips =
      normalizarClips(
        clipsBrutos,
        quantidade,
        duracaoSolicitada,
        videoId
      );

    if (!clips.length) {
      throw new Error(
        'A IA não encontrou cortes válidos neste vídeo.'
      );
    }

    console.log(
      `[Análise] ${clips.length} cortes encontrados.`
    );

    return res.json({
      success: true,
      videoId,
      clips
    });

  } catch (error) {

    console.error(
      '[Análise] ERRO:',
      error?.response?.data ||
      error?.message ||
      error
    );

    let mensagem =
      error?.message ||
      'Não foi possível analisar o vídeo.';

    const textoErro =
      String(mensagem).toLowerCase();

    if (
      textoErro.includes('quota') ||
      textoErro.includes('429') ||
      textoErro.includes('resource exhausted')
    ) {
      mensagem =
        'O limite da API do Gemini foi atingido. Tente novamente mais tarde.';
    }

    if (
      textoErro.includes('api key') ||
      textoErro.includes('unauthorized') ||
      textoErro.includes('401')
    ) {
      mensagem =
        'A chave da API do Gemini não foi aceita pelo servidor.';
    }

    if (
      textoErro.includes('403')
    ) {
      mensagem =
        'O servidor de download recusou o acesso ao vídeo (403).';
    }

    return res.status(500).json({
      success: false,
      error: mensagem
    });

  } finally {

    if (arquivoTemporario) {
      await apagarArquivo(
        arquivoTemporario
      );
    }
  }
});

// ==========================================================
// API - DOWNLOAD DO CORTE
// ==========================================================

app.get('/api/download', async (req, res) => {
  let processo = null;

  try {
    const {
      id,
      start,
      duration
    } = req.query;

    if (!id) {
      return res.status(400).json({
        success: false,
        error:
          'ID do vídeo não informado.'
      });
    }

    const videoId =
      extrairVideoId(id) || id;

    if (
      !/^[a-zA-Z0-9_-]{11}$/.test(
        videoId
      )
    ) {
      return res.status(400).json({
        success: false,
        error:
          'ID do vídeo inválido.'
      });
    }

    const inicio =
      Math.max(
        0,
        Number(start) || 0
      );

    const duracao =
      Math.max(
        1,
        Math.min(
          600,
          Number(duration) || 60
        )
      );

    console.log(
      `[Download] ${videoId} | início ${inicio}s | duração ${duracao}s`
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

    const headers =
      [
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
        'Accept: */*',
        'Referer: https://www.youtube.com/',
        'Origin: https://www.youtube.com'
      ].join('\r\n') + '\r\n';

    res.statusCode = 200;

    res.setHeader(
      'Content-Type',
      'video/mp4'
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="clipforge-${videoId}-${Math.floor(inicio)}.mp4"`
    );

    res.setHeader(
      'Cache-Control',
      'no-store'
    );

    processo = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',

        '-headers',
        headers,

        '-ss',
        String(inicio),

        '-i',
        streamUrl,

        '-t',
        String(duracao),

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

        'pipe:1'
      ]
    );

    let stderr = '';

    processo.stderr.on(
      'data',
      data => {
        stderr += data.toString();

        if (stderr.length > 5000) {
          stderr =
            stderr.slice(-5000);
        }
      }
    );

    processo.stdout.pipe(res);

    processo.on(
      'error',
      error => {
        console.error(
          '[Download FFmpeg Error]',
          error.message
        );

        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            error:
              'Erro ao iniciar o processamento do vídeo.'
          });
        } else {
          res.destroy(error);
        }
      }
    );

    processo.on(
      'close',
      codigo => {
        if (codigo === 0) {
          metricas.totalDownloads++;

          console.log(
            '[Download] Finalizado.'
          );
        } else {
          console.error(
            '[Download] FFmpeg código:',
            codigo,
            stderr
          );

          if (!res.writableEnded) {
            res.destroy(
              new Error(
                'Falha no processamento do vídeo.'
              )
            );
          }
        }
      }
    );

    req.on(
      'aborted',
      () => {
        if (
          processo &&
          !processo.killed
        ) {
          processo.kill('SIGKILL');
        }
      }
    );

  } catch (error) {

    console.error(
      '[Download] Erro:',
      error.message
    );

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error:
          error.message ||
          'Erro ao baixar o corte.'
      });
    }

    res.destroy(error);
  }
});

// ==========================================================
// MERCADO PAGO - CRIAR PIX
// ==========================================================

app.post('/api/pix/criar', async (req, res) => {
  try {
    const {
      userId = 'anonimo',
      valor = 19.90,
      plano = 'VIP'
    } = req.body || {};

    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({
        success: false,
        error:
          'MP_ACCESS_TOKEN não configurado no Render.'
      });
    }

    const valorNumerico =
      Number(valor);

    if (
      !Number.isFinite(valorNumerico) ||
      valorNumerico <= 0
    ) {
      return res.status(400).json({
        success: false,
        error:
          'Valor do pagamento inválido.'
      });
    }

    const idempotencyKey =
      `clipforge-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;

    const resposta =
      await axios.post(
        'https://api.mercadopago.com/v1/payments',

        {
          transaction_amount:
            Number(
              valorNumerico.toFixed(2)
            ),

          description:
            `ClipForge Pro ${plano}`,

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

    const pagamento =
      resposta.data;

    const pagamentoId =
      String(pagamento.id);

    pagamentos.set(
      pagamentoId,
      {
        status:
          pagamento.status ||
          'pending',

        userId,

        valor:
          Number(
            valorNumerico.toFixed(2)
          ),

        criadoEm:
          new Date().toISOString()
      }
    );

    const qrCode =
      pagamento.point_of_interaction
        ?.transaction_data
        ?.qr_code || '';

    const qrCodeBase64 =
      pagamento.point_of_interaction
        ?.transaction_data
        ?.qr_code_base64 || '';

    return res.json({
      success: true,

      id: pagamentoId,

      status:
        pagamento.status,

      qr_code:
        qrCode,

      qr_code_base64:
        qrCodeBase64,

      valor:
        valorNumerico
    });

  } catch (error) {

    console.error(
      '[Mercado Pago Criar]',
      error.response?.data ||
      error.message
    );

    return res.status(500).json({
      success: false,
      error:
        error.response?.data?.message ||
        error.response?.data?.error ||
        'Não foi possível criar o pagamento Pix.'
    });
  }
});

// ==========================================================
// MERCADO PAGO - CONSULTAR PIX
// ==========================================================

app.get(
  '/api/pix/status/:id',
  async (req, res) => {
    try {
      const id =
        String(
          req.params.id || ''
        ).trim();

      if (!id) {
        return res.status(400).json({
          success: false,
          error:
            'ID do pagamento não informado.'
        });
      }

      // --------------------------------------
      // Se estiver no cache local
      // --------------------------------------

      const pagamentoLocal =
        pagamentos.get(id);

      // --------------------------------------
      // Mercado Pago
      // --------------------------------------

      if (!MP_ACCESS_TOKEN) {
        return res.status(500).json({
          success: false,
          error:
            'MP_ACCESS_TOKEN não configurado.'
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

            timeout: 30000
          }
        );

      const pagamento =
        resposta.data;

      const status =
        pagamento.status ||
        pagamentoLocal?.status ||
        'pending';

      // --------------------------------------
      // Atualiza cache
      // --------------------------------------

      if (pagamentoLocal) {
        pagamentoLocal.status =
          status;
      } else {
        pagamentos.set(
          id,
          {
            status,
            userId:
              'anonimo',
            valor:
              Number(
                pagamento.transaction_amount ||
                0
              )
          }
        );
      }

      // --------------------------------------
      // Registrar venda somente uma vez
      // --------------------------------------

      if (
        status === 'approved' &&
        pagamentoLocal &&
        !pagamentoLocal.contabilizado
      ) {
        pagamentoLocal.contabilizado =
          true;

        metricas.totalVendas++;

        metricas.valorArrecadado +=
          Number(
            pagamento.transaction_amount ||
            pagamentoLocal.valor ||
            0
          );
      }

      return res.json({
        success: true,

        id,

        status,

        status_detail:
          pagamento.status_detail || null
      });

    } catch (error) {

      console.error(
        '[Mercado Pago Status]',
        error.response?.data ||
        error.message
      );

      return res.status(500).json({
        success: false,
        error:
          error.response?.data?.message ||
          'Não foi possível consultar o pagamento.'
      });
    }
  }
);

// ==========================================================
// ADMIN - LOGIN
// ==========================================================

app.post(
  '/api/admin/login',
  (req, res) => {
    const password =
      String(
        req.body?.password || ''
      );

    if (
      password &&
      password === ADMIN_PASSWORD
    ) {
      return res.json({
        success: true,
        authenticated: true
      });
    }

    return res.status(401).json({
      success: false,
      error:
        'Senha incorreta.'
    });
  }
);

// ==========================================================
// ADMIN - DASHBOARD
// ==========================================================

app.get(
  '/api/admin/dashboard',
  (req, res) => {
    const authorization =
      String(
        req.headers.authorization || ''
      );

    if (
      !authorization ||
      authorization !== ADMIN_PASSWORD
    ) {
      return res.status(401).json({
        success: false,
        error:
          'Não autorizado.'
      });
    }

    const memoria =
      process.memoryUsage();

    const memoriaMB =
      Math.round(
        memoria.rss / 1024 / 1024
      );

    return res.json({
      success: true,

      metricas: {
        ...metricas
      },

      servidor: {
        memoriaMB,

        uptime:
          Math.round(
            process.uptime()
          ),

        node:
          process.version,

        plataforma:
          process.platform
      },

      memoriaUsadaMb:
        memoriaMB
    });
  }
);

// ==========================================================
// 404
// ==========================================================

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,
      error:
        'Rota não encontrada.'
    });
  }
);

// ==========================================================
// ERRO GLOBAL
// ==========================================================

app.use(
  (error, req, res, next) => {
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
  }
);

// ==========================================================
// INICIAR SERVIDOR
// ==========================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      '=========================================='
    );

    console.log(
      '🚀 CLIPFORGE PRO SERVER'
    );

    console.log(
      `🌐 Porta: ${PORT}`
    );

    console.log(
      `🤖 Gemini: ${
        GEMINI_API_KEY
          ? 'CONFIGURADO'
          : 'NÃO CONFIGURADO'
      }`
    );

    console.log(
      `📦 RapidAPI: ${
        RAPIDAPI_KEY
          ? 'CONFIGURADA'
          : 'NÃO CONFIGURADA'
      }`
    );

    console.log(
      `💳 Mercado Pago: ${
        MP_ACCESS_TOKEN
          ? 'CONFIGURADO'
          : 'NÃO CONFIGURADO'
      }`
    );

    console.log(
      `🧠 Modelo Gemini: ${GEMINI_MODEL}`
    );

    console.log(
      '=========================================='
    );
  }
);