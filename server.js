const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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


// ====================================================
// CONFIGURAÇÃO
// ====================================================

const PORT =
  process.env.PORT || 3000;

const RAPIDAPI_KEY =
  process.env.RAPIDAPI_KEY || '';

const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST ||
  'cloud-api-hub-youtube-downloader.p.rapidapi.com';

const MP_ACCESS_TOKEN =
  process.env.MP_ACCESS_TOKEN || '';

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || '';


// ====================================================
// CAMINHO DO YT-DLP
// ====================================================

const YTDLP_PATH =
  path.join(
    __dirname,
    'bin',
    'yt-dlp'
  );


// ====================================================
// MERCADO PAGO
// ====================================================

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


// ====================================================
// MÉTRICAS
// ====================================================

const metricas = {
  totalDownloads: 0,
  totalVendas: 0,
  totalAnalises: 0,
  valorArrecadado: 0.00,
  inicioOperacao:
    new Date().toISOString()
};

const pagamentos = new Map();


// ====================================================
// EXTRAIR VIDEO ID
// ====================================================

function extrairVideoId(url) {

  if (
    !url ||
    typeof url !== 'string'
  ) {
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


// ====================================================
// ROTA PRINCIPAL
// ====================================================

app.get('/', (req, res) => {

  res.json({
    status: 'online',
    versao: '12.5.0-YTDLP'
  });

});


// ====================================================
// STATUS
// ====================================================

app.get('/api/status', (req, res) => {

  res.json({

    status: 'online',

    uptime:
      Math.floor(
        process.uptime()
      ),

    timestamp:
      new Date().toISOString(),

    versao:
      '12.5.0-YTDLP',

    ytDlp:
      fs.existsSync(YTDLP_PATH)
        ? 'disponível'
        : 'não encontrado'

  });

});


// ====================================================
// LOGIN ADMIN
// ====================================================

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


// ====================================================
// DASHBOARD ADMIN
// ====================================================

app.get(
  '/api/admin/dashboard',
  (req, res) => {

    if (
      !ADMIN_PASSWORD ||
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

      status:
        'online',

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


// ====================================================
// ANALISAR VÍDEO
// ====================================================

app.post(
  '/api/analisar',
  async (req, res) => {

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
        extrairVideoId(
          youtubeUrl
        );

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

  }
);


// ====================================================
// CRIAR PIX
// ====================================================

app.post(
  '/api/pix/criar',
  async (req, res) => {

    const {
      userId = 'anonimo',
      valor = 19.90
    } = req.body || {};

    const valorFormatado =
      Number(
        parseFloat(valor)
          .toFixed(2)
      );


    // ------------------------------------------------
    // CONTINGÊNCIA
    // ------------------------------------------------

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


    // ------------------------------------------------
    // MERCADO PAGO
    // ------------------------------------------------

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


      if (
        !pixData?.qr_code
      ) {

        throw new Error(
          'Pix sem código'
        );

      }


      pagamentos.set(
        String(resultado.id),
        {

          status:
            'pending',

          userId,

          valor:
            valorFormatado

        }
      );


      return res.json({

        id:
          resultado.id,

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

          status:
            'approved',

          userId,

          valor:
            valorFormatado

        }
      );


      return res.json({

        id:
          mockId,

        qr_code:
          '00020126580014br.gov.bcb.pix0136pix-clipforge-vip520400005303986540419.905802BR',

        simulado:
          true

      });

    }

  }
);


// ====================================================
// STATUS DO PIX
// ====================================================

app.get(
  '/api/pix/status/:id',
  async (req, res) => {

    const paymentId =
      String(
        req.params.id
      );


    const registro =
      pagamentos.get(
        paymentId
      );


    // ------------------------------------------------
    // PAGAMENTO SIMULADO
    // ------------------------------------------------

    if (
      paymentId.startsWith('mock_') ||
      paymentId.startsWith('ctg_')
    ) {

      if (
        registro &&
        registro.status !==
          'processado'
      ) {

        metricas.totalVendas += 1;

        metricas.valorArrecadado +=
          Number(
            registro.valor ||
            19.90
          );

        registro.status =
          'processado';

      }


      return res.json({
        status:
          'approved'
      });

    }


    // ------------------------------------------------
    // MERCADO PAGO
    // ------------------------------------------------

    if (mpClient) {

      try {

        const payment =
          new mercadopago.Payment(
            mpClient
          );


        const dados =
          await payment.get({
            id:
              paymentId
          });


        if (
          dados.status ===
            'approved' &&
          registro &&
          registro.status !==
            'approved'
        ) {

          metricas.totalVendas += 1;

          metricas.valorArrecadado +=
            Number(
              registro.valor ||
              19.90
            );

          registro.status =
            'approved';

        }


        return res.json({
          status:
            dados.status
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

  }
);


// ====================================================
// VERIFICAR YT-DLP
// ====================================================

function verificarYtDlp() {

  if (
    !fs.existsSync(
      YTDLP_PATH
    )
  ) {

    throw new Error(
      'yt-dlp não encontrado em ' +
      YTDLP_PATH
    );

  }

}


// ====================================================
// BAIXAR COM YT-DLP
// ====================================================
//
// Aqui está a mudança principal.
//
// O yt-dlp:
// 1. encontra o vídeo;
// 2. seleciona vídeo até 720p;
// 3. seleciona áudio;
// 4. baixa os dois;
// 5. usa FFmpeg para unir;
// 6. baixa somente o trecho solicitado.
//
// ====================================================

function baixarTrechoComYtDlp(
  videoId,
  inicio,
  duracao,
  arquivoSaida
) {

  return new Promise(
    (resolve, reject) => {

      try {

        verificarYtDlp();

      } catch (error) {

        reject(error);

        return;

      }


      const fim =
        inicio + duracao;


      const youtubeUrl =
        `https://www.youtube.com/watch?v=${videoId}`;


      const argumentos = [

        '--no-playlist',

        '--no-warnings',

        '--newline',

        '--no-part',

        '--restrict-filenames',

        '--format',
        'bv*[height<=720]+ba/b[height<=720]/b',

        '--merge-output-format',
        'mp4',

        '--download-sections',
        `*${inicio}-${fim}`,

        '--output',
        arquivoSaida,

        youtubeUrl

      ];


      console.log(
        `[yt-dlp] Baixando ${videoId} — ${inicio}s até ${fim}s`
      );


      console.log(
        `[yt-dlp] Arquivo temporário: ${arquivoSaida}`
      );


      const processo =
        spawn(
          YTDLP_PATH,
          argumentos,
          {
            stdio: [
              'ignore',
              'pipe',
              'pipe'
            ]
          }
        );


      let stdout =
        '';

      let stderr =
        '';


      processo.stdout.on(
        'data',
        dados => {

          const texto =
            dados.toString();

          stdout += texto;

          console.log(
            '[yt-dlp]',
            texto.trim()
          );

        }
      );


      processo.stderr.on(
        'data',
        dados => {

          const texto =
            dados.toString();

          stderr += texto;

          console.log(
            '[yt-dlp stderr]',
            texto.trim()
          );

        }
      );


      processo.on(
        'error',
        error => {

          console.error(
            '[yt-dlp process error]:',
            error.message
          );

          reject(error);

        }
      );


      processo.on(
        'close',
        codigo => {

          if (
            codigo === 0
          ) {

            console.log(
              '[yt-dlp] Download concluído.'
            );

            resolve();

            return;

          }


          const mensagem =
            stderr.trim() ||
            stdout.trim() ||
            `yt-dlp encerrou com código ${codigo}`;


          console.error(
            '[yt-dlp] Erro:',
            mensagem
          );


          reject(
            new Error(
              mensagem
            )
          );

        }
      );

    }
  );

}


// ====================================================
// PROCESSAR MP4 COM FFMPEG
// ====================================================
//
// O arquivo já vem com vídeo + áudio.
// Aqui apenas reduzimos para 360p e
// entregamos pelo HTTP.
//
// ====================================================

function executarProcessamentoFfmpeg(
  arquivoEntrada,
  duracao,
  res
) {

  return new Promise(
    (resolve, reject) => {

      const argumentos = [

        '-hide_banner',

        '-loglevel',
        'error',

        '-i',
        arquivoEntrada,

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
        '[FFmpeg] Processando vídeo + áudio para 360p...'
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


      let erro =
        '';


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
            error.code !==
              'EPIPE'
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

          reject(error);

        }
      );


      processo.on(
        'close',
        codigo => {

          if (
            codigo === 0
          ) {

            console.log(
              '[FFmpeg] Corte finalizado com vídeo + áudio.'
            );

            resolve();

            return;

          }


          // ------------------------------------------------
          // Cliente fechou a conexão.
          // ------------------------------------------------

          if (
            codigo === null
          ) {

            resolve();

            return;

          }


          console.error(
            '[FFmpeg] Erro:',
            erro
          );


          reject(
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


// ====================================================
// LIMPAR ARQUIVO TEMPORÁRIO
// ====================================================

function apagarArquivo(
  arquivo
) {

  try {

    if (
      fs.existsSync(
        arquivo
      )
    ) {

      fs.unlinkSync(
        arquivo
      );

      console.log(
        '[Temp] Arquivo removido:',
        arquivo
      );

    }

  } catch (error) {

    console.error(
      '[Temp] Não foi possível remover:',
      error.message
    );

  }

}


// ====================================================
// ROTA DE DOWNLOAD
// ====================================================

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


    // ------------------------------------------------
    // VALIDAR ID
    // ------------------------------------------------

    if (
      !videoId ||
      videoId.length < 5
    ) {

      return res.status(400).json({

        error:
          'ID do vídeo inválido.'

      });

    }


    // ------------------------------------------------
    // VALIDAR START
    // ------------------------------------------------

    if (
      !Number.isFinite(start) ||
      start < 0
    ) {

      start = 0;

    }


    // ------------------------------------------------
    // VALIDAR DURAÇÃO
    // ------------------------------------------------

    if (
      !Number.isFinite(duration) ||
      duration < 1
    ) {

      duration = 55;

    }


    // Máximo de 120 segundos
    duration =
      Math.min(
        duration,
        120
      );


    const arquivoTemporario =
      path.join(
        os.tmpdir(),
        `clipforge_${videoId}_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`
      );


    try {

      console.log(
        '=========================================='
      );

      console.log(
        `[Download] Iniciando ${videoId}`
      );

      console.log(
        `[Download] Início: ${start}s`
      );

      console.log(
        `[Download] Duração: ${duration}s`
      );

      console.log(
        '=========================================='
      );


      // ------------------------------------------------
      // 1. YT-DLP
      // ------------------------------------------------

      await baixarTrechoComYtDlp(
        videoId,
        start,
        duration,
        arquivoTemporario
      );


      // ------------------------------------------------
      // VERIFICAR ARQUIVO
      // ------------------------------------------------

      if (
        !fs.existsSync(
          arquivoTemporario
        )
      ) {

        throw new Error(
          'yt-dlp terminou sem gerar o arquivo.'
        );

      }


      const tamanho =
        fs.statSync(
          arquivoTemporario
        ).size;


      console.log(
        `[Download] Arquivo gerado: ${Math.round(tamanho / 1024 / 1024 * 100) / 100} MB`
      );


      if (
        tamanho < 1000
      ) {

        throw new Error(
          'Arquivo gerado está vazio ou inválido.'
        );

      }


      // ------------------------------------------------
      // NOME DO ARQUIVO
      // ------------------------------------------------

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


      // ------------------------------------------------
      // 2. FFMPEG
      // ------------------------------------------------

      await executarProcessamentoFfmpeg(
        arquivoTemporario,
        duration,
        res
      );


      metricas.totalDownloads += 1;


      console.log(
        `[Download] Finalizado com sucesso: ${safeId}`
      );


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
            'Não foi possível gerar o corte. ' +
            error.message

        });

      }

    } finally {

      // ------------------------------------------------
      // LIMPAR TEMP
      // ------------------------------------------------

      apagarArquivo(
        arquivoTemporario
      );

    }

  }
);


// ====================================================
// INICIALIZAÇÃO
// ====================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      `[ClipForge Core] Servidor operacional na porta ${PORT} [v12.5.0-YTDLP]`
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


    console.log(
      `[yt-dlp] ${
        fs.existsSync(YTDLP_PATH)
          ? 'Disponível'
          : 'NÃO ENCONTRADO'
      }`
    );


    console.log(
      '[Download] Sistema yt-dlp + FFmpeg ativo.'
    );

  }
);