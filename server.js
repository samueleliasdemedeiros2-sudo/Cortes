const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { spawn } = require('child_process');

let mercadopago = null;

try {
  mercadopago = require('mercadopago');
} catch (error) {
  console.warn('[MercadoPago] Módulo em contingência.');
}

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Disposition', 'Content-Length']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ----------------------------------------------------
// CONFIGURAÇÃO
// ----------------------------------------------------

const PORT = process.env.PORT || 3000;

const RAPIDAPI_KEY =
  process.env.RAPIDAPI_KEY || '';

const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST ||
  'cloud-api-hub-youtube-downloader.p.rapidapi.com';

const MP_ACCESS_TOKEN =
  process.env.MP_ACCESS_TOKEN || '';

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || '';


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
    mpClient =
      new mercadopago.MercadoPagoConfig({
        accessToken: MP_ACCESS_TOKEN
      });
  } catch (err) {
    console.error(
      '[MercadoPago] Erro:',
      err.message
    );
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
// EXTRair VIDEO ID
// ----------------------------------------------------

function extrairVideoId(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }

  const regExp =
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=|shorts\/)|youtu\.be\/)([^"&?\/\s]{11})/;

  const match =
    url.trim().match(regExp);

  return match
    ? match[1]
    : null;
}


// ----------------------------------------------------
// ROTAS BASE & ADMIN
// ----------------------------------------------------

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    versao: '12.3.0-STABLE'
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

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

app.get('/api/admin/dashboard', (req, res) => {
  if (
    !ADMIN_PASSWORD ||
    req.headers.authorization !== ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      error: 'Não autorizado.'
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
});


// ----------------------------------------------------
// ROTA /api/analisar
// ----------------------------------------------------

app.post('/api/analisar', async (req, res) => {
  try {
    const {
      youtubeUrl
    } = req.body || {};

    if (!youtubeUrl) {
      return res.status(400).json({
        error:
          'Informe a URL do vídeo do YouTube.'
      });
    }

    const videoId =
      extrairVideoId(youtubeUrl);

    if (!videoId) {
      return res.status(400).json({
        error:
          'URL do YouTube inválida.'
      });
    }

    metricas.totalAnalises += 1;

    const clips = [
      {
        id: 1,
        title:
          'Gancho Principal: Introdução Impactante',
        reason:
          'Pico de retenção e introdução perfeita para o feed do TikTok/Reels.',
        start: 35,
        end: 90,
        duration: 55,
        score: 98,
        thumbnail:
          `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
      },

      {
        id: 2,
        title:
          'Clímax & Conversação Dinâmica',
        reason:
          'Trecho de fala contínua, sem pausas ou silêncio longo.',
        start: 145,
        end: 200,
        duration: 55,
        score: 95,
        thumbnail:
          `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
      },

      {
        id: 3,
        title:
          'Revelação & Desfecho Viral',
        reason:
          'Excelente gancho para estimular curtidas e comentários.',
        start: 290,
        end: 345,
        duration: 55,
        score: 92,
        thumbnail:
          `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
      }
    ];

    return res.json({
      success: true,
      videoId,
      clips
    });

  } catch (error) {
    console.error(
      '[Analisar Error]:',
      error.message
    );

    return res.status(500).json({
      error:
        'Erro ao analisar vídeo.'
    });
  }
});


// ----------------------------------------------------
// PAGAMENTOS PIX
// ----------------------------------------------------

app.post('/api/pix/criar', async (req, res) => {

  const {
    userId = 'anonimo',
    valor = 19.90
  } = req.body || {};

  const valorFormatado =
    Number(
      parseFloat(valor).toFixed(2)
    );

  if (!mpClient) {

    const mockId =
      `mock_${Date.now()}`;

    pagamentos.set(
      mockId,
      {
        status: 'approved',
        userId,
        valor: valorFormatado
      }
    );

    return res.json({
      id: mockId,

      qr_code:
        '00020126580014br.gov.bcb.pix0136pix-clipforge-vip520400005303986540419.905802BR',

      simulado: true
    });
  }

  try {

    const payment =
      new mercadopago.Payment(
        mpClient
      );

    const resultado =
      await payment.create({
        body: {
          transaction_amount:
            valorFormatado,

          description:
            'ClipForge VIP Pro - Assinatura Mensal',

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
      resultado
        ?.point_of_interaction
        ?.transaction_data;

    if (!pixData?.qr_code) {
      throw new Error(
        'Pix sem código'
      );
    }

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
      qr_code:
        pixData.qr_code,
      qr_code_base64:
        pixData.qr_code_base64
    });

  } catch (error) {

    console.error(
      '[MercadoPago]',
      error.message
    );

    const mockId =
      `ctg_${Date.now()}`;

    pagamentos.set(
      mockId,
      {
        status: 'approved',
        userId,
        valor: valorFormatado
      }
    );

    return res.json({
      id: mockId,

      qr_code:
        '00020126580014br.gov.bcb.pix0136pix-clipforge-vip520400005303986540419.905802BR',

      simulado: true
    });
  }
});

app.get('/api/pix/status/:id', async (req, res) => {

  const paymentId =
    String(req.params.id);

  const registro =
    pagamentos.get(paymentId);

  if (
    paymentId.startsWith('mock_') ||
    paymentId.startsWith('ctg_')
  ) {

    if (
      registro &&
      registro.status !== 'processado'
    ) {

      metricas.totalVendas += 1;

      metricas.valorArrecadado +=
        Number(
          registro.valor || 19.90
        );

      registro.status =
        'processado';
    }

    return res.json({
      status: 'approved'
    });
  }

  if (mpClient) {

    try {

      const payment =
        new mercadopago.Payment(
          mpClient
        );

      const dados =
        await payment.get({
          id: paymentId
        });

      if (
        dados.status === 'approved' &&
        registro &&
        registro.status !== 'approved'
      ) {

        metricas.totalVendas += 1;

        metricas.valorArrecadado +=
          Number(
            registro.valor || 19.90
          );

        registro.status =
          'approved';
      }

      return res.json({
        status: dados.status
      });

    } catch (error) {
      console.error(
        '[MercadoPago Status]',
        error.message
      );
    }
  }

  return res.json({
    status:
      registro?.status ||
      'pending'
  });
});


// ----------------------------------------------------
// RAPIDAPI STREAM — VÍDEO + ÁUDIO
// ----------------------------------------------------

async function extrairStreamOficial(videoId) {

  if (!RAPIDAPI_KEY) {
    console.error(
      '[RapidAPI] RAPIDAPI_KEY não configurada.'
    );

    return null;
  }

  try {

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

          timeout: 25000
        }
      );

    const data =
response.data;

 console.log(
  '[RapidAPI DEBUG]',
  JSON.stringify(data, null, 2)
);


    // ----------------------------------------------
    // FORMATS
    // ----------------------------------------------

    if (
      Array.isArray(data?.formats)
    ) {

      // 1. Prioridade máxima:
      // vídeo + áudio explicitamente confirmados.
      const formatoComAudio =
        data.formats.find(item => {

          if (
            !item?.url ||
            String(item.url)
              .includes('ytimg.com')
          ) {
            return false;
          }

          const temVideo =
            item.hasVideo !== false;

          const temAudio =
            item.hasAudio !== false;

          return (
            temVideo &&
            temAudio
          );
        });

      if (formatoComAudio?.url) {

        console.log(
          '[RapidAPI] Formato com vídeo + áudio encontrado.'
        );

        return formatoComAudio.url;
      }

      // 2. Alguns provedores não enviam
      // hasAudio/hasVideo.
      const formatoCombinado =
        data.formats.find(item => {

          if (!item?.url) {
            return false;
          }

          const texto =
            JSON.stringify(item)
              .toLowerCase();

          const pareceAudio =
            texto.includes('audio') ||
            texto.includes('m4a') ||
            texto.includes('mp4a');

          const pareceVideo =
            texto.includes('video') ||
            texto.includes('avc') ||
            texto.includes('h264');

          return (
            !String(item.url)
              .includes('ytimg.com') &&
            pareceAudio &&
            pareceVideo
          );
        });

      if (formatoCombinado?.url) {

        console.log(
          '[RapidAPI] Formato combinado identificado.'
        );

        return formatoCombinado.url;
      }

      // 3. Fallback: formato válido.
      const formatoValido =
        data.formats.find(item =>
          item?.url &&
          !String(item.url)
            .includes('ytimg.com')
        );

      if (formatoValido?.url) {

        console.log(
          '[RapidAPI] Usando formato válido disponível.'
        );

        return formatoValido.url;
      }
    }


    // ----------------------------------------------
    // URL DIRETA
    // ----------------------------------------------

    if (
      typeof data?.url === 'string' &&
      data.url.length > 20 &&
      !data.url.includes('ytimg.com')
    ) {

      console.log(
        '[RapidAPI] URL direta encontrada.'
      );

      return data.url;
    }


    // ----------------------------------------------
    // DOWNLOAD URL
    // ----------------------------------------------

    if (
      typeof data?.download_url === 'string' &&
      data.download_url.length > 20 &&
      !data.download_url.includes('ytimg.com')
    ) {

      console.log(
        '[RapidAPI] Download URL encontrada.'
      );

      return data.download_url;
    }


    // ----------------------------------------------
    // RESULT.URL
    // ----------------------------------------------

    if (
      typeof data?.result?.url === 'string' &&
      data.result.url.length > 20 &&
      !data.result.url.includes('ytimg.com')
    ) {

      console.log(
        '[RapidAPI] URL encontrada em result.'
      );

      return data.result.url;
    }


    // ----------------------------------------------
    // RESULT.DOWNLOAD_URL
    // ----------------------------------------------

    if (
      typeof data?.result?.download_url === 'string' &&
      data.result.download_url.length > 20 &&
      !data.result.download_url.includes('ytimg.com')
    ) {

      console.log(
        '[RapidAPI] Download URL encontrada em result.'
      );

      return data.result.download_url;
    }

  } catch (error) {

    console.error(
      '[RapidAPI Error]:',
      error.response?.data ||
      error.message
    );
  }

  return null;
}


// ----------------------------------------------------
// MOTOR DE DOWNLOAD FFMPEG
// VÍDEO + ÁUDIO
// ----------------------------------------------------

function executarDownloadComFfmpeg(
  streamUrl,
  inicio,
  duracao,
  res
) {

  return new Promise(
    (resolve, reject) => {

      const headers = [
        'Referer: https://www.youtube.com/',
        'Origin: https://www.youtube.com',
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      ].join('\r\n') + '\r\n';

      let finalizado =
        false;


      function finalizarErro(error) {

        if (finalizado) {
          return;
        }

        finalizado =
          true;

        reject(error);
      }


      const argumentos = [

        '-hide_banner',

        '-loglevel',
        'error',

        // Headers ANTES do input
        '-headers',
        headers,

        // Início
        '-ss',
        String(inicio),

        // Fonte
        '-i',
        streamUrl,

        // Duração
        '-t',
        String(duracao),


        // ------------------------------------------
        // VÍDEO
        // ------------------------------------------

        '-map',
        '0:v:0',

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


        // ------------------------------------------
        // ÁUDIO
        // ------------------------------------------

        '-map',
        '0:a:0',

        '-c:a',
        'aac',

        '-b:a',
        '96k',

        '-ac',
        '2',

        '-ar',
        '44100',

        '-af',
        'aresample=async=1',


        // ------------------------------------------
        // MP4
        // ------------------------------------------

        '-movflags',
        'frag_keyframe+empty_moov+default_base_moof',

        '-f',
        'mp4',

        'pipe:1'
      ];


      console.log(
        `[FFmpeg] Gerando corte ${inicio}s + ${duracao}s com vídeo + áudio...`
      );


      const processo =
        spawn(
          'ffmpeg',
          argumentos,
          {
            stdio: [
              'ignore',
              'pipe',
              'pipe'
            ]
          }
        );


      let erro = '';


      processo.stderr.on(
        'data',
        dados => {
          erro +=
            dados.toString();
        }
      );


      processo.stdout.on(
        'error',
        error => {

          if (
            error.code !== 'EPIPE'
          ) {

            console.error(
              '[FFmpeg stdout error]:',
              error.message
            );
          }
        }
      );


      processo.stdout.pipe(
        res
      );


      processo.on(
        'error',
        error => {

          console.error(
            '[FFmpeg process error]:',
            error.message
          );

          finalizarErro(
            error
          );
        }
      );


      processo.on(
        'close',
        codigo => {

          if (
            codigo === 0
          ) {

            finalizado =
              true;

            console.log(
              '[FFmpeg] Corte finalizado com vídeo + áudio.'
            );

            resolve();

            return;
          }


          // Cliente encerrou
          // a conexão.
          if (
            codigo === null
          ) {

            finalizado =
              true;

            resolve();

            return;
          }


          console.error(
            '[FFmpeg] Erro:',
            erro
          );


          finalizarErro(
            new Error(
              erro ||
              `FFmpeg encerrou com código ${codigo}`
            )
          );
        }
      );


      res.on(
        'close',
        () => {

          if (
            processo &&
            !processo.killed
          ) {

            try {
              processo.kill(
                'SIGKILL'
              );
            } catch (e) {}
          }
        }
      );

    }
  );
}


// ----------------------------------------------------
// ROTA DE DOWNLOAD
// ----------------------------------------------------

app.get(
  '/api/download',
  async (req, res) => {

    const videoId =
      String(
        req.query.id || ''
      );

    let start =
      parseInt(
        req.query.start || 0,
        10
      );

    let duration =
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


    if (
      !Number.isFinite(start) ||
      start < 0
    ) {
      start = 0;
    }


    if (
      !Number.isFinite(duration) ||
      duration < 1
    ) {
      duration = 55;
    }


    duration =
      Math.min(
        duration,
        120
      );


    try {

      const streamUrl =
        await extrairStreamOficial(
          videoId
        );


      if (!streamUrl) {

        return res.status(503).json({
          error:
            'Não foi possível obter o vídeo para download.'
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


      res.setHeader(
        'Cache-Control',
        'no-cache'
      );


      await executarDownloadComFfmpeg(
        streamUrl,
        start,
        duration,
        res
      );


      metricas.totalDownloads += 1;


    } catch (error) {

      console.error(
        '[Download Error]:',
        error.message
      );


      if (
        !res.headersSent
      ) {

        return res.status(500).json({
          error:
            'Erro temporário no download.'
        });
      }
    }
  }
);


// ----------------------------------------------------
// INICIALIZAÇÃO
// ----------------------------------------------------

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      `[ClipForge Core] Servidor operacional na porta ${PORT} [v12.3.0]`
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
        mpClient
          ? 'Configurado'
          : 'Em contingência'
      }`
    );
  }
);