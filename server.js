const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { GoogleGenAI, createUserContent, createPartFromUri } = require('@google/genai');

let mercadopago = null;

try {
  mercadopago = require('mercadopago');
} catch (e) {
  console.warn('[MercadoPago] Módulo em contingência.');
}

const app = express();

// ----------------------------------------------------
// CORS
// ----------------------------------------------------

app.use(cors({
  origin: '*',
  exposedHeaders: ['Content-Disposition', 'Content-Length']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ----------------------------------------------------
// VARIÁVEIS DE AMBIENTE
// ----------------------------------------------------

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST ||
  'cloud-api-hub-youtube-downloader.p.rapidapi.com';

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'samuel123';

// Modelo Gemini
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || 'gemini-3.6-flash';

// ----------------------------------------------------
// CLIENTE GEMINI
// ----------------------------------------------------

let gemini = null;

if (GEMINI_API_KEY) {
  try {
    gemini = new GoogleGenAI({
      apiKey: GEMINI_API_KEY
    });

    console.log('[Gemini] Cliente inicializado.');
  } catch (error) {
    console.error('[Gemini] Erro ao inicializar:', error.message);
  }
} else {
  console.warn('[Gemini] GEMINI_API_KEY não configurada.');
}

// ----------------------------------------------------
// MERCADO PAGO
// ----------------------------------------------------

let mpClient = null;

if (
  mercadopago &&
  MP_ACCESS_TOKEN &&
  MP_ACCESS_TOKEN.startsWith('APP_USR')
) {
  try {
    mpClient = new mercadopago.MercadoPagoConfig({
      accessToken: MP_ACCESS_TOKEN
    });

    console.log('[MercadoPago] Cliente inicializado.');
  } catch (err) {
    console.error('[MercadoPago] Erro:', err.message);
  }
}

// ----------------------------------------------------
// MÉTRICAS
// ----------------------------------------------------

const metricas = {
  totalDownloads: 0,
  totalVendas: 0,
  totalAnalises: 0,
  valorArrecadado: 0.00,
  inicioOperacao: new Date().toISOString()
};

const pagamentos = new Map();

// ----------------------------------------------------
// UTILITÁRIOS
// ----------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extrairVideoId(youtubeUrl) {
  const regExp =
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=|shorts\/)|youtu\.be\/)([^"&?\/\s]{11})/;

  const match = youtubeUrl.trim().match(regExp);

  return match ? match[1] : null;
}

function limparJsonGemini(texto) {
  if (!texto) return null;

  let textoLimpo = texto.trim();

  // Remove ```json ... ```
  textoLimpo = textoLimpo
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(textoLimpo);
  } catch (e) {
    // Tenta encontrar o primeiro objeto JSON
    const inicio = textoLimpo.indexOf('{');
    const fim = textoLimpo.lastIndexOf('}');

    if (inicio !== -1 && fim !== -1 && fim > inicio) {
      try {
        return JSON.parse(
          textoLimpo.substring(inicio, fim + 1)
        );
      } catch (err) {
        return null;
      }
    }
  }

  return null;
}

// ----------------------------------------------------
// ROTAS DE STATUS
// ----------------------------------------------------

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    versao: '9.0.0-GEMINI-VIDEO'
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    uptime: Math.floor(process.uptime()),
    gemini: !!gemini
  });
});

// ----------------------------------------------------
// ADMIN
// ----------------------------------------------------

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;

  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({
      error: 'Credencial inválida.'
    });
  }

  return res.json({
    success: true
  });
});

app.get('/api/admin/dashboard', (req, res) => {
  if (req.headers['authorization'] !== ADMIN_PASSWORD) {
    return res.status(401).json({
      error: 'Não autorizado.'
    });
  }

  const mem = process.memoryUsage();

  res.json({
    status: 'online',
    metricas,
    memoriaUsadaMb: Math.round(
      mem.heapUsed / 1024 / 1024
    )
  });
});

// ----------------------------------------------------
// RAPIDAPI - OBTÉM VÍDEO
// ----------------------------------------------------

async function extrairStreamOficial(videoId) {
  if (!RAPIDAPI_KEY) {
    throw new Error(
      'RAPIDAPI_KEY não configurada no servidor.'
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
          'x-rapidapi-host': RAPIDAPI_HOST
        },

        timeout: 30000
      }
    );

    const data = response.data;

    if (Array.isArray(data?.formats)) {
      const formato = data.formats.find(f =>
        f.url &&
        !f.url.includes('ytimg.com') &&
        f.hasAudio !== false &&
        f.hasVideo !== false
      );

      if (formato?.url) {
        return formato.url;
      }
    }

    if (
      data?.url &&
      typeof data.url === 'string' &&
      !data.url.includes('ytimg.com')
    ) {
      return data.url;
    }

    if (
      data?.download_url &&
      typeof data.download_url === 'string'
    ) {
      return data.download_url;
    }

    return null;

  } catch (error) {
    console.error(
      '[RapidAPI Error]:',
      error.response?.data || error.message
    );

    return null;
  }
}

// ----------------------------------------------------
// BAIXA O VÍDEO TEMPORARIAMENTE
// ----------------------------------------------------

async function baixarVideoTemporario(videoUrl) {
  const arquivo = path.join(
    os.tmpdir(),
    `clipforge_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}.mp4`
  );

  const response = await axios.get(videoUrl, {
    responseType: 'stream',
    timeout: 120000,
    maxContentLength: 200 * 1024 * 1024,
    maxBodyLength: 200 * 1024 * 1024
  });

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(arquivo);

    response.data.pipe(writer);

    writer.on('finish', resolve);
    writer.on('error', reject);

    response.data.on('error', reject);
  });

  return arquivo;
}

// ----------------------------------------------------
// ANALISAR VÍDEO COM GEMINI
// ----------------------------------------------------

app.post('/api/analisar', async (req, res) => {
  let arquivoTemporario = null;
  let arquivoGemini = null;

  try {
    const {
      youtubeUrl,
      duration = 60,
      quantity = 3
    } = req.body;

    if (!youtubeUrl) {
      return res.status(400).json({
        error: 'Informe a URL do vídeo do YouTube.'
      });
    }

    const videoId = extrairVideoId(youtubeUrl);

    if (!videoId) {
      return res.status(400).json({
        error: 'URL do YouTube inválida ou não reconhecida.'
      });
    }

    if (!gemini) {
      return res.status(500).json({
        error:
          'Gemini não configurado no servidor. Verifique GEMINI_API_KEY no Render.'
      });
    }

    metricas.totalAnalises += 1;

    console.log(
      `[Analisar] Iniciando análise do vídeo ${videoId}`
    );

    // ------------------------------------------------
    // 1. Obter stream do YouTube
    // ------------------------------------------------

    const streamUrl =
      await extrairStreamOficial(videoId);

    if (!streamUrl) {
      return res.status(503).json({
        error:
          'Não foi possível obter o vídeo do YouTube no momento.'
      });
    }

    // ------------------------------------------------
    // 2. Baixar temporariamente
    // ------------------------------------------------

    console.log('[Analisar] Baixando vídeo temporariamente...');

    arquivoTemporario =
      await baixarVideoTemporario(streamUrl);

    console.log(
      '[Analisar] Vídeo baixado:',
      arquivoTemporario
    );

    // ------------------------------------------------
    // 3. Enviar para Gemini Files API
    // ------------------------------------------------

    console.log('[Gemini] Enviando vídeo para análise...');

    arquivoGemini = await gemini.files.upload({
      file: arquivoTemporario,
      config: {
        mimeType: 'video/mp4'
      }
    });

    console.log(
      '[Gemini] Arquivo enviado:',
      arquivoGemini.name
    );

    // ------------------------------------------------
    // 4. Esperar Gemini processar vídeo
    // ------------------------------------------------

    let tentativas = 0;

    while (
      arquivoGemini.state &&
      arquivoGemini.state.toString() !== 'ACTIVE'
    ) {
      tentativas++;

      if (tentativas > 60) {
        throw new Error(
          'Tempo limite excedido ao processar o vídeo no Gemini.'
        );
      }

      console.log(
        `[Gemini] Processando vídeo... tentativa ${tentativas}`
      );

      await sleep(5000);

      arquivoGemini =
        await gemini.files.get({
          name: arquivoGemini.name
        });
    }

    console.log('[Gemini] Vídeo pronto para análise.');

    // ------------------------------------------------
    // 5. Prompt da IA
    // ------------------------------------------------

    const prompt = `
Você é o motor de inteligência artificial do ClipForge Pro.

Analise cuidadosamente este vídeo e encontre os melhores momentos
para transformar em Shorts/Reels/TikTok.

Precisamos de ${quantity} cortes.

Cada corte deve ter aproximadamente ${duration} segundos.

Procure principalmente por:

- momentos de alta retenção;
- frases fortes;
- revelações;
- opiniões polêmicas ou interessantes;
- histórias surpreendentes;
- momentos engraçados;
- perguntas e respostas;
- reações;
- momentos emocionantes;
- partes que gerariam comentários;
- trechos que funcionem sozinhos como Short.

IMPORTANTE:

Você precisa identificar os tempos reais do vídeo.

NÃO invente timestamps.

O campo "start" deve ser o segundo real em que o corte começa.

O campo "end" deve ser o segundo real em que termina.

O campo "duration" deve ser end - start.

Escolha cortes diferentes entre si.

Retorne SOMENTE JSON válido, sem markdown e sem explicações.

Formato obrigatório:

{
  "clips": [
    {
      "id": 1,
      "title": "Título curto e chamativo",
      "reason": "Explique por que esse trecho tem potencial",
      "start": 123,
      "end": 178,
      "duration": 55,
      "score": 95
    }
  ]
}

O score deve ser um número de 0 a 100 representando o potencial
de retenção/viralização do trecho.
`;

    // ------------------------------------------------
    // 6. Gemini analisa o vídeo
    // ------------------------------------------------

    console.log('[Gemini] Analisando conteúdo...');

    const resultado =
      await gemini.models.generateContent({
        model: GEMINI_MODEL,

        contents: createUserContent([
          createPartFromUri(
            arquivoGemini.uri,
            arquivoGemini.mimeType
          ),

          prompt
        ])
      });

    const texto =
      resultado.text || '';

    console.log(
      '[Gemini] Resposta recebida.'
    );

    // ------------------------------------------------
    // 7. Converter resposta em JSON
    // ------------------------------------------------

    const dados =
      limparJsonGemini(texto);

    if (
      !dados ||
      !Array.isArray(dados.clips)
    ) {
      console.error(
        '[Gemini] Resposta inválida:',
        texto
      );

      throw new Error(
        'O Gemini não retornou os cortes em formato válido.'
      );
    }

    // ------------------------------------------------
    // 8. Normalizar cortes
    // ------------------------------------------------

    const clips = dados.clips
      .slice(0, Number(quantity))
      .map((clip, index) => {

        let start = Number(clip.start);

        let end = Number(clip.end);

        let clipDuration =
          Number(clip.duration);

        if (!Number.isFinite(start) || start < 0) {
          start = 0;
        }

        if (!Number.isFinite(end) || end <= start) {
          end = start + Number(duration);
        }

        if (!Number.isFinite(clipDuration)) {
          clipDuration = end - start;
        }

        clipDuration =
          Math.max(
            1,
            Math.round(clipDuration)
          );

        end =
          start + clipDuration;

        return {
          id: index + 1,

          title:
            clip.title ||
            `Corte viral #${index + 1}`,

          reason:
            clip.reason ||
            'Trecho identificado pela IA como potencialmente interessante.',

          start:
            Math.max(
              0,
              Math.round(start)
            ),

          end:
            Math.max(
              1,
              Math.round(end)
            ),

          duration:
            clipDuration,

          score:
            Math.min(
              100,
              Math.max(
                0,
                Number(clip.score) || 80
              )
            ),

          thumbnail:
            `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
        };
      });

    if (!clips.length) {
      throw new Error(
        'Nenhum corte foi encontrado pelo Gemini.'
      );
    }

    console.log(
      `[Analisar] ${clips.length} cortes encontrados.`
    );

    // ------------------------------------------------
    // 9. Resposta para o Vercel
    // ------------------------------------------------

    return res.json({
      success: true,
      videoId,
      clips
    });

  } catch (error) {

    console.error(
      '[Analisar Error]:',
      error.response?.data ||
      error.message ||
      error
    );

    return res.status(500).json({
      error:
        error.message ||
        'Erro ao processar análise do vídeo.'
    });

  } finally {

    // Apaga o arquivo temporário
    if (
      arquivoTemporario &&
      fs.existsSync(arquivoTemporario)
    ) {
      try {
        fs.unlinkSync(arquivoTemporario);

        console.log(
          '[Analisar] Arquivo temporário removido.'
        );
      } catch (e) {
        console.warn(
          '[Analisar] Não foi possível remover arquivo temporário.'
        );
      }
    }
  }
});

// ----------------------------------------------------
// PIX
// ----------------------------------------------------

app.post('/api/pix/criar', async (req, res) => {

  const {
    userId = 'anonimo',
    valor = 19.90
  } = req.body;

  const valorFormatado =
    Number(parseFloat(valor).toFixed(2));

  if (!mpClient) {

    const mockId =
      `mock_${Date.now()}`;

    pagamentos.set(mockId, {
      status: 'approved',
      userId,
      valor: valorFormatado
    });

    return res.json({
      id: mockId,

      qr_code:
        '00020126580014br.gov.bcb.pix0136pix-clipforge-vip520400005303986540419.905802BR',

      simulado: true
    });
  }

  try {

    const payment =
      new mercadopago.Payment(mpClient);

    const resultado =
      await payment.create({
        body: {
          transaction_amount:
            valorFormatado,

          description:
            'ClipForge VIP Pro - Subscrição Mensal',

          payment_method_id:
            'pix',

          payer: {
            email:
              `user_${Date.now()}@clipforge.com`,

            first_name:
              'Cliente',

            last_name:
              'VIP'
          }
        }
      });

    const pixData =
      resultado.point_of_interaction
        ?.transaction_data;

    pagamentos.set(
      String(resultado.id),
      {
        status: 'pending',
        userId,
        valor: valorFormatado
      }
    );

    return res.json({
      id: resultado.id,
      qr_code: pixData?.qr_code,
      qr_code_base64:
        pixData?.qr_code_base64
    });

  } catch (error) {

    console.error(
      '[MercadoPago Error]:',
      error.message
    );

    const contingenciaId =
      `ctg_${Date.now()}`;

    pagamentos.set(
      contingenciaId,
      {
        status: 'approved',
        userId,
        valor: valorFormatado
      }
    );

    return res.json({
      id: contingenciaId,

      qr_code:
        '00020126580014br.gov.bcb.pix0136pix-clipforge-vip520400005303986540419.905802BR',

      simulado: true
    });
  }
});

// ----------------------------------------------------
// STATUS PIX
// ----------------------------------------------------

app.get('/api/pix/status/:id', async (req, res) => {

  const paymentId =
    String(req.params.id);

  const reg =
    pagamentos.get(paymentId);

  if (
    paymentId.startsWith('mock_') ||
    paymentId.startsWith('ctg_')
  ) {

    if (
      reg &&
      reg.status !== 'processado'
    ) {

      metricas.totalVendas += 1;

      metricas.valorArrecadado +=
        Number(reg.valor || 19.90);

      reg.status = 'processado';
    }

    return res.json({
      status: 'approved'
    });
  }

  if (mpClient) {

    try {

      const payment =
        new mercadopago.Payment(mpClient);

      const dados =
        await payment.get({
          id: paymentId
        });

      if (
        dados.status === 'approved' &&
        reg &&
        reg.status !== 'approved'
      ) {

        metricas.totalVendas += 1;

        metricas.valorArrecadado +=
          Number(reg.valor || 19.90);

        reg.status = 'approved';
      }

      return res.json({
        status: dados.status
      });

    } catch (e) {
      console.error(
        '[PIX Status Error]:',
        e.message
      );
    }
  }

  return res.json({
    status:
      reg?.status || 'pending'
  });
});

// ----------------------------------------------------
// DOWNLOAD
// ----------------------------------------------------

app.get('/api/download', async (req, res) => {

  const videoId =
    req.query.id;

  const start =
    parseInt(
      req.query.start || 0,
      10
    );

  const duration =
    parseInt(
      req.query.duration || 55,
      10
    );

  if (
    !videoId ||
    videoId.length < 5
  ) {

    return res.status(400).json({
      error:
        'ID do vídeo inválido.'
    });
  }

  try {

    const directStreamUrl =
      await extrairStreamOficial(videoId);

    if (!directStreamUrl) {

      return res.status(503).json({
        error:
          'Servidores temporariamente ocupados.'
      });
    }

    const safeId =
      videoId.replace(
        /[^a-zA-Z0-9_-]/g,
        ''
      );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="corte_${safeId}_${start}s.mp4"`
    );

    res.setHeader(
      'Content-Type',
      'video/mp4'
    );

    const ffmpeg =
      spawn('ffmpeg', [
        '-ss',
        String(start),

        '-i',
        directStreamUrl,

        '-t',
        String(duration),

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
      ]);

    ffmpeg.stdout.pipe(res);

    ffmpeg.stderr.on(
      'data',
      () => {}
    );

    ffmpeg.on(
      'close',
      code => {

        if (code === 0) {
          metricas.totalDownloads += 1;
        }

      }
    );

    req.on(
      'close',
      () => {

        try {
          ffmpeg.kill('SIGKILL');
        } catch (e) {}

      }
    );

  } catch (error) {

    console.error(
      '[Download Error]:',
      error.message
    );

    if (!res.headersSent) {

      res.status(500).json({
        error:
          'Erro temporário no processamento do ficheiro.'
      });
    }
  }
});

// ----------------------------------------------------
// INICIALIZAÇÃO
// ----------------------------------------------------

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  () => {

    console.log(
      `[ClipForge Core] Servidor operacional na porta ${PORT} [v9.0.0 GEMINI]`
    );

  }
);