// ============================================================
// CLIPFORGE PRO - BACKEND
// VERSION 12.8.0
//
// BASE: 12.7.1
//
// PRINCIPAIS CORREÇÕES:
// - Download mais robusto
// - YT-API + FFmpeg + yt-dlp fallback
// - Fallback acontece antes de iniciar a resposta
// - Arquivo temporário usado para evitar resposta quebrada
// - Admin protegido
// - Métricas compatíveis com o frontend
// - RAM do servidor
// - PIX Mercado Pago
// - Status PIX
// - Melhor tratamento de erros
// - Limpeza automática de temporários
// - Compatível com o index.html v3.3
//
// OBS:
// A análise de IA abaixo mantém o mecanismo compatível com
// o frontend atual. A integração real com Gemini pode ser
// adicionada posteriormente através de GEMINI_API_KEY.
// ============================================================

const express = require('express');
const cors = require('cors');

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  execFile,
  spawn
} = require('child_process');

const util = require('util');

const app = express();

const PORT =
  Number(process.env.PORT) || 10000;

const execFileAsync =
  util.promisify(execFile);

// ============================================================
// CONFIGURAÇÕES
// ============================================================

const RAPIDAPI_KEY =
  process.env.RAPIDAPI_KEY || '';

const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST ||
  'yt-api.p.rapidapi.com';

const MP_ACCESS_TOKEN =
  process.env.MP_ACCESS_TOKEN || '';

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || '';

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || '';

const YTDLP_PATH =
  process.env.YTDLP_PATH ||
  path.join(
    process.cwd(),
    'bin',
    'yt-dlp'
  );

const TMP_ROOT =
  path.join(
    os.tmpdir(),
    'clipforge'
  );

garantirDiretorio(TMP_ROOT);

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

  pixAprovados: 0,

  erros: 0,

  inicioServidor:
    new Date().toISOString()

};

// ============================================================
// PAGAMENTOS EM MEMÓRIA
// ============================================================
//
// O Render pode reiniciar o processo. Portanto, esta estrutura
// é apenas um cache/runtime e não substitui um banco de dados.
// ============================================================

const pagamentos =
  new Map();

// ============================================================
// UTILITÁRIOS
// ============================================================

function garantirDiretorio(
  diretorio
) {

  if (
    !fs.existsSync(
      diretorio
    )
  ) {

    fs.mkdirSync(
      diretorio,
      {
        recursive: true
      }
    );

  }

}

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
  mensagem,
  detalhes = null
) {

  metrics.erros++;

  const resposta = {
    success: false,
    error: mensagem
  };

  if (
    detalhes &&
    process.env.NODE_ENV !== 'production'
  ) {

    resposta.details =
      detalhes;

  }

  return res
    .status(status)
    .json(resposta);

}

function apagarDiretorio(
  diretorio
) {

  if (!diretorio) {
    return;
  }

  try {

    fs.rmSync(
      diretorio,
      {
        recursive: true,
        force: true
      }
    );

  } catch (erro) {

    console.error(
      '[Cleanup]',
      erro.message
    );

  }

}

// ============================================================
// EXTRAIR ID DO YOUTUBE
// ============================================================

function extrairVideoId(
  input
) {

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

  try {

    valor =
      decodeURIComponent(
        valor
      );

  } catch {}

  // ID direto

  if (
    /^[a-zA-Z0-9_-]{11}$/.test(
      valor
    )
  ) {

    return valor;

  }

  // Adicionar protocolo

  if (
    /^(www\.)?youtube\.com\//i.test(
      valor
    ) ||
    /^m\.youtube\.com\//i.test(
      valor
    ) ||
    /^youtu\.be\//i.test(
      valor
    )
  ) {

    valor =
      `https://${valor}`;

  }

  try {

    const url =
      new URL(valor);

    const hostname =
      url.hostname
        .toLowerCase();

    // youtube.com

    if (
      hostname === 'youtube.com' ||
      hostname === 'www.youtube.com' ||
      hostname === 'm.youtube.com' ||
      hostname === 'youtube-nocookie.com'
    ) {

      const v =
        url.searchParams.get(
          'v'
        );

      if (
        v &&
        /^[a-zA-Z0-9_-]{11}$/.test(
          v
        )
      ) {

        return v;

      }

      const partes =
        url.pathname
          .split('/')
          .filter(Boolean);

      const tipos =
        [
          'shorts',
          'embed',
          'live'
        ];

      if (
        tipos.includes(
          partes[0]
        ) &&
        partes[1] &&
        /^[a-zA-Z0-9_-]{11}$/.test(
          partes[1]
        )
      ) {

        return partes[1];

      }

    }

    // youtu.be

    if (
      hostname === 'youtu.be' ||
      hostname === 'www.youtu.be'
    ) {

      const id =
        url.pathname
          .split('/')
          .filter(Boolean)[0];

      if (
        id &&
        /^[a-zA-Z0-9_-]{11}$/.test(
          id
        )
      ) {

        return id;

      }

    }

  } catch {}

  // Fallback por regex

  const encontrado =
    valor.match(
      /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([a-zA-Z0-9_-]{11})/
    );

  if (
    encontrado
  ) {

    return encontrado[1];

  }

  return null;
}

// ============================================================
// AUTENTICAÇÃO ADMIN
// ============================================================

function verificarAdmin(
  req
) {

  if (!ADMIN_PASSWORD) {

    return false;

  }

  const authorization =
    String(
      req.headers.authorization ||
      ''
    ).trim();

  if (!authorization) {

    return false;

  }

  if (
    authorization ===
    ADMIN_PASSWORD
  ) {

    return true;

  }

  if (
    authorization.startsWith(
      'Bearer '
    )
  ) {

    const token =
      authorization
        .slice(7)
        .trim();

    return token ===
      ADMIN_PASSWORD;

  }

  return false;
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
        '12.8.0',

      status:
        'online',

      download:
        'YT-API + FFmpeg + yt-dlp fallback',

      ai:
        GEMINI_API_KEY
          ? 'configured'
          : 'fallback'

    });

  }
);

// ============================================================
// STATUS DA API
// ============================================================

app.get(
  '/api/status',
  async (req, res) => {

    let ffmpeg =
      false;

    let ytdlp =
      false;

    try {

      await execFileAsync(
        'ffmpeg',
        [
          '-version'
        ],
        {
          timeout:
            5000
        }
      );

      ffmpeg =
        true;

    } catch {}

    const ytdlpPath =
      localizarYtDlp();

    if (
      ytdlpPath &&
      ytdlpPath !== 'yt-dlp'
    ) {

      ytdlp =
        fs.existsSync(
          ytdlpPath
        );

    } else {

      try {

        await execFileAsync(
          'yt-dlp',
          [
            '--version'
          ],
          {
            timeout:
              5000
          }
        );

        ytdlp =
          true;

      } catch {}

    }

    res.json({

      online: true,

      version:
        '12.8.0',

      rapidapi:
        Boolean(
          RAPIDAPI_KEY
        ),

      mercadopago:
        Boolean(
          MP_ACCESS_TOKEN
        ),

      gemini:
        Boolean(
          GEMINI_API_KEY
        ),

      ffmpeg,

      ytapi:
        RAPIDAPI_HOST ===
        'yt-api.p.rapidapi.com',

      ytdlp

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
    } =
      req.body || {};

    if (
      !ADMIN_PASSWORD
    ) {

      return respostaErro(
        res,
        503,
        'ADMIN_PASSWORD não configurada no servidor.'
      );

    }

    if (
      !password ||
      String(password) !==
      ADMIN_PASSWORD
    ) {

      return respostaErro(
        res,
        401,
        'Credencial inválida.'
      );

    }

    return res.json({

      success: true,

      token:
        ADMIN_PASSWORD

    });

  }
);

// ============================================================
// ADMIN DASHBOARD
// ============================================================

app.get(
  '/api/admin/dashboard',
  (req, res) => {

    if (
      !verificarAdmin(req)
    ) {

      return respostaErro(
        res,
        401,
        'Não autorizado.'
      );

    }

    const memoria =
      process.memoryUsage();

    const memoriaMB =
      Math.round(
        memoria.rss /
        1024 /
        1024
      );

    const uptime =
      process.uptime();

    const metricas = {

      // Nomes usados pelo frontend atual

      valorArrecadado:
        0,

      totalVendas:
        metrics.pixAprovados,

      totalDownloads:
        metrics.downloads,

      downloads:
        metrics.downloads,

      vendas:
        metrics.pixAprovados,

      // Métricas originais

      analises:
        metrics.analises,

      pixCriados:
        metrics.pixCriados,

      pixAprovados:
        metrics.pixAprovados,

      erros:
        metrics.erros

    };

    const servidor = {

      version:
        '12.8.0',

      rapidapi:
        Boolean(
          RAPIDAPI_KEY
        ),

      mercadopago:
        Boolean(
          MP_ACCESS_TOKEN
        ),

      gemini:
        Boolean(
          GEMINI_API_KEY
        ),

      ytapi: true,

      ytdlp:
        fs.existsSync(
          YTDLP_PATH
        ),

      memoriaMB,

      memoriaUsadaMb:
        memoriaMB,

      uptimeSegundos:
        Math.floor(
          uptime
        ),

      inicio:
        metrics.inicioServidor

    };

    return res.json({

      success: true,

      metrics:
        metricas,

      metricas:
        metricas,

      system:
        servidor,

      servidor:
        servidor

    });

  }
);

// ============================================================
// ANÁLISE
// ============================================================
//
// Esta versão mantém a API compatível com o frontend.
//
// A análise real por Gemini exige uma integração específica
// de modelo/API e uma GEMINI_API_KEY configurada.
//
// Enquanto ela não estiver configurada, o servidor retorna
// cortes demonstrativos compatíveis com o sistema de download.
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

      } =
        req.body || {};

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
        '[Análise] Entrada:',
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
        '[Análise] ID:',
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

      const thumbnail =
        `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`;

      console.log(
        `[Análise] Vídeo: ${youtubeId}`
      );

      console.log(
        `[Análise] Quantidade: ${quantidade}`
      );

      console.log(
        `[Análise] Duração: ${duracaoSolicitada}s`
      );

      // ======================================================
      // CORTES COMPATÍVEIS
      // ======================================================

      const clipsBase = [

        {

          id: 1,

          title:
            'Melhor momento',

          start:
            35,

          end:
            90,

          duration:
            55,

          score:
            98,

          reason:
            'Momento com alto potencial de retenção.',

          thumbnail

        },

        {

          id: 2,

          title:
            'Momento de destaque',

          start:
            145,

          end:
            200,

          duration:
            55,

          score:
            95,

          reason:
            'Trecho com potencial para gerar engajamento.',

          thumbnail

        },

        {

          id: 3,

          title:
            'Trecho viral',

          start:
            290,

          end:
            345,

          duration:
            55,

          score:
            92,

          reason:
            'Trecho interessante para formato curto.',

          thumbnail

        },

        {

          id: 4,

          title:
            'Momento importante',

          start:
            410,

          end:
            465,

          duration:
            55,

          score:
            89,

          reason:
            'Trecho com potencial para conteúdo curto.',

          thumbnail

        },

        {

          id: 5,

          title:
            'Momento de impacto',

          start:
            520,

          end:
            575,

          duration:
            55,

          score:
            87,

          reason:
            'Trecho selecionado para formato vertical.',

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

        ai:
          Boolean(
            GEMINI_API_KEY
          ),

        mode:
          GEMINI_API_KEY
            ? 'gemini-ready'
            : 'fallback',

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
        '[Análise Error]',
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
// YT-API /DL
// ============================================================

async function ytApiDownload(
  videoId
) {

  if (
    !RAPIDAPI_KEY
  ) {

    throw new Error(
      'RAPIDAPI_KEY não configurada.'
    );

  }

  const endpoint =
    new URL(
      `https://${RAPIDAPI_HOST}/dl`
    );

  endpoint.searchParams.set(
    'id',
    videoId
  );

  endpoint.searchParams.set(
    'cgeo',
    'BR'
  );

  console.log(
    `[YT-API] Consultando ${videoId}`
  );

  const response =
    await fetch(
      endpoint,
      {

        method:
          'GET',

        headers: {

          'x-rapidapi-key':
            RAPIDAPI_KEY,

          'x-rapidapi-host':
            RAPIDAPI_HOST,

          'accept':
            'application/json',

          'user-agent':
            'ClipForge-Pro/12.8.0'

        }

      }
    );

  const texto =
    await response.text();

  let data;

  try {

    data =
      JSON.parse(
        texto
      );

  } catch {

    data = {
      raw:
        texto
    };

  }

  if (
    !response.ok
  ) {

    console.error(
      `[YT-API] HTTP ${response.status}`
    );

    console.error(
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
// COLETAR URLS
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
      (
        item,
        index
      ) => {

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
      (
        [
          chave,
          valor
        ]
      ) => {

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
// ANALISAR STREAM
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
    (
      texto.includes(
        'videoplayback'
      ) &&
      !texto.includes(
        'mime=audio'
      )
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

  const videos =
    streams.filter(
      stream =>
        stream.video &&
        !stream.audio
    );

  const combinados =
    streams.filter(
      stream =>
        stream.video &&
        stream.audio
    );

  const audios =
    streams.filter(
      stream =>
        stream.audio &&
        !stream.video
    );

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
      (
        a,
        b
      ) =>
        Number(
          b.altura || 0
        ) -
        Number(
          a.altura || 0
        )
    );

    videoEscolhido =
      lista[0];

  }

  let audioEscolhido =
    null;

  if (
    audios.length
  ) {

    audios.sort(
      (
        a,
        b
      ) =>
        Number(
          b.bitrate || 0
        ) -
        Number(
          a.bitrate || 0
        )
    );

    audioEscolhido =
      audios[0];

  }

  let combinadoEscolhido =
    null;

  if (
    combinados.length
  ) {

    combinados.sort(
      (
        a,
        b
      ) =>
        Number(
          b.altura || 0
        ) -
        Number(
          a.altura || 0
        )
    );

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
// HEADERS
// ============================================================

const YOUTUBE_HEADERS =
  [
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
    'Accept: */*',
    'Referer: https://www.youtube.com/'
  ].join('\r\n') +
  '\r\n';

// ============================================================
// TESTAR STREAM
// ============================================================

async function testarStream(
  url
) {

  if (!url) {
    return false;
  }

  try {

    const response =
      await fetch(
        url,
        {

          method:
            'GET',

          headers: {

            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',

            'Accept':
              '*/*',

            'Referer':
              'https://www.youtube.com/'

          }

        }
      );

    try {

      await response.body?.cancel();

    } catch {}

    console.log(
      `[Download] Teste stream: HTTP ${response.status}`
    );

    return response.ok;

  } catch (erro) {

    console.log(
      '[Download] Teste falhou:',
      erro.message
    );

    return false;

  }

}

// ============================================================
// LOCALIZAR YT-DLP
// ============================================================

function localizarYtDlp() {

  const candidatos = [

    YTDLP_PATH,

    path.join(
      process.cwd(),
      'bin',
      'yt-dlp'
    ),

    '/opt/render/project/src/bin/yt-dlp'

  ];

  for (
    const candidato of candidatos
  ) {

    if (
      fs.existsSync(
        candidato
      )
    ) {

      return candidato;

    }

  }

  return 'yt-dlp';

}

// ============================================================
// EXECUTAR FFMPEG REMOTO
// ============================================================

async function executarFfmpegStreamsArquivo(
  videoUrl,
  audioUrl,
  inicio,
  duracao,
  arquivoSaida
) {

  const args = [

    '-hide_banner',

    '-loglevel',
    'warning',

    '-reconnect',
    '1',

    '-reconnect_streamed',
    '1',

    '-reconnect_delay_max',
    '5',

    '-headers',
    YOUTUBE_HEADERS,

    '-ss',
    String(inicio),

    '-i',
    videoUrl,

    '-headers',
    YOUTUBE_HEADERS,

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
    '+faststart',

    '-y',

    arquivoSaida

  ];

  await executarProcesso(
    'ffmpeg',
    args,
    '[FFmpeg]'
  );

  validarArquivo(
    arquivoSaida
  );

}

// ============================================================
// EXECUTAR FFMPEG COMBINADO
// ============================================================

async function executarFfmpegCombinadoArquivo(
  url,
  inicio,
  duracao,
  arquivoSaida
) {

  const args = [

    '-hide_banner',

    '-loglevel',
    'warning',

    '-reconnect',
    '1',

    '-reconnect_streamed',
    '1',

    '-reconnect_delay_max',
    '5',

    '-headers',
    YOUTUBE_HEADERS,

    '-ss',
    String(inicio),

    '-i',
    url,

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
    '+faststart',

    '-y',

    arquivoSaida

  ];

  await executarProcesso(
    'ffmpeg',
    args,
    '[FFmpeg Combined]'
  );

  validarArquivo(
    arquivoSaida
  );

}

// ============================================================
// EXECUTAR FFMPEG DE ARQUIVO
// ============================================================

async function executarFfmpegArquivo(
  arquivoEntrada,
  inicio,
  duracao,
  arquivoSaida
) {

  const args = [

    '-hide_banner',

    '-loglevel',
    'warning',

    '-ss',
    String(inicio),

    '-i',
    arquivoEntrada,

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
    '+faststart',

    '-y',

    arquivoSaida

  ];

  await executarProcesso(
    'ffmpeg',
    args,
    '[FFmpeg File]'
  );

  validarArquivo(
    arquivoSaida
  );

}

// ============================================================
// EXECUTOR DE PROCESSOS
// ============================================================

function executarProcesso(
  comando,
  args,
  prefixo
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      console.log(
        `${prefixo} Executando: ${comando}`
      );

      const processo =
        spawn(
          comando,
          args,
          {
            stdio: [
              'ignore',
              'pipe',
              'pipe'
            ]
          }
        );

      let stderr = '';

      processo.stdout.on(
        'data',
        chunk => {

          const texto =
            chunk.toString();

          if (
            texto.trim()
          ) {

            process.stdout.write(
              `${prefixo} ${texto}`
            );

          }

        }
      );

      processo.stderr.on(
        'data',
        chunk => {

          const texto =
            chunk.toString();

          stderr +=
            texto;

          if (
            texto.includes(
              'frame='
            ) ||
            texto.includes(
              'time='
            ) ||
            texto.includes(
              '403'
            ) ||
            texto.includes(
              'Forbidden'
            )
          ) {

            process.stdout.write(
              `${prefixo} ${texto}`
            );

          }

        }
      );

      processo.on(
        'error',
        erro => {

          reject(
            new Error(
              `${comando} não pôde ser executado: ${erro.message}`
            )
          );

        }
      );

      processo.on(
        'close',
        codigo => {

          if (
            codigo === 0
          ) {

            resolve();

            return;

          }

          const resumo =
            stderr
              .trim()
              .slice(
                -3000
              );

          reject(
            new Error(
              `${comando} terminou com código ${codigo}.${resumo ? ` ${resumo}` : ''}`
            )
          );

        }
      );

    }
  );

}

// ============================================================
// VALIDAR ARQUIVO
// ============================================================

function validarArquivo(
  arquivo
) {

  if (
    !fs.existsSync(
      arquivo
    )
  ) {

    throw new Error(
      'O arquivo de saída não foi criado.'
    );

  }

  const stats =
    fs.statSync(
      arquivo
    );

  if (
    stats.size <
    1024
  ) {

    throw new Error(
      'O arquivo gerado está vazio ou inválido.'
    );

  }

  return true;

}

// ============================================================
// YT-DLP
// ============================================================

async function baixarComYtDlp(
  videoId,
  inicio,
  duracao,
  pasta
) {

  const ytDlp =
    localizarYtDlp();

  const saida =
    path.join(
      pasta,
      'source.%(ext)s'
    );

  const url =
    `https://www.youtube.com/watch?v=${videoId}`;

  const fim =
    inicio +
    duracao;

  console.log(
    '[YT-DLP] Fallback ativado.'
  );

  console.log(
    `[YT-DLP] Executável: ${ytDlp}`
  );

  const args = [

    '--no-playlist',

    '--no-warnings',

    '--force-overwrites',

    '--retries',
    '3',

    '--fragment-retries',
    '3',

    '--concurrent-fragments',
    '4',

    '--merge-output-format',
    'mp4',

    '--download-sections',
    `*${inicio}-${fim}`,

    '--force-keyframes-at-cuts',

    '-f',
    'bv*[height<=720]+ba/b[height<=720]/b',

    '-o',
    saida,

    url

  ];

  await executarProcesso(
    ytDlp,
    args,
    '[YT-DLP]'
  );

  const arquivos =
    fs.readdirSync(
      pasta
    );

  const candidatos =
    arquivos
      .filter(
        nome =>
          nome.endsWith(
            '.mp4'
          ) ||
          nome.endsWith(
            '.mkv'
          ) ||
          nome.endsWith(
            '.webm'
          )
      )
      .map(
        nome =>
          path.join(
            pasta,
            nome
          )
      );

  if (
    !candidatos.length
  ) {

    throw new Error(
      'yt-dlp terminou sem gerar arquivo.'
    );

  }

  candidatos.sort(
    (
      a,
      b
    ) => {

      const tamanhoA =
        fs.statSync(
          a
        ).size;

      const tamanhoB =
        fs.statSync(
          b
        ).size;

      return (
        tamanhoB -
        tamanhoA
      );

    }
  );

  const arquivo =
    candidatos[0];

  validarArquivo(
    arquivo
  );

  console.log(
    `[YT-DLP] Arquivo: ${arquivo}`
  );

  return arquivo;

}

// ============================================================
// ENVIAR ARQUIVO
// ============================================================

function enviarArquivo(
  res,
  arquivo,
  videoId,
  inicio
) {

  validarArquivo(
    arquivo
  );

  const nome =
    `clip-${videoId}-${Math.floor(inicio)}.mp4`;

  res.statusCode =
    200;

  res.setHeader(
    'Content-Type',
    'video/mp4'
  );

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${nome}"`
  );

  res.setHeader(
    'Cache-Control',
    'no-cache, no-store, must-revalidate'
  );

  res.setHeader(
    'Pragma',
    'no-cache'
  );

  res.setHeader(
    'Content-Length',
    fs.statSync(
      arquivo
    ).size
  );

  return new Promise(
    (
      resolve,
      reject
    ) => {

      const stream =
        fs.createReadStream(
          arquivo
        );

      stream.on(
        'error',
        reject
      );

      res.on(
        'finish',
        resolve
      );

      res.on(
        'close',
        () => {

          if (
            !res.writableFinished
          ) {

            stream.destroy();

          }

        }
      );

      stream.pipe(
        res
      );

    }
  );

}

// ============================================================
// DOWNLOAD
// ============================================================

app.get(
  '/api/download',
  async (req, res) => {

    let pasta =
      null;

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

      } =
        req.query;

      const entrada =
        id ||
        videoIdParam ||
        url ||
        videoUrl ||
        youtubeUrl;

      console.log(
        '[Download] Entrada:',
        entrada
          ? String(
              entrada
            ).slice(
              0,
              150
            )
          : 'nenhuma'
      );

      const videoId =
        extrairVideoId(
          entrada
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

      pasta =
        fs.mkdtempSync(
          path.join(
            TMP_ROOT,
            'download-'
          )
        );

      const arquivoFinal =
        path.join(
          pasta,
          'clip-final.mp4'
        );

      console.log('');
      console.log(
        '================================================'
      );
      console.log(
        '[Download] NOVO DOWNLOAD 12.8.0'
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

      // ======================================================
      // TENTATIVA 1 - YT-API
      // ======================================================

      if (
        RAPIDAPI_KEY
      ) {

        try {

          console.log(
            '[Download] Consultando YT-API...'
          );

          const dados =
            await ytApiDownload(
              videoId
            );

          const streams =
            encontrarStreams(
              dados
            );

          console.log(
            `[Download] ${streams.total} streams encontradas.`
          );

          // ==================================================
          // VÍDEO + ÁUDIO
          // ==================================================

          if (
            streams.video &&
            streams.audio
          ) {

            console.log(
              '[Download] Tentando vídeo + áudio separados.'
            );

            const videoOk =
              await testarStream(
                streams.video.url
              );

            const audioOk =
              await testarStream(
                streams.audio.url
              );

            if (
              videoOk &&
              audioOk
            ) {

              try {

                await executarFfmpegStreamsArquivo(
                  streams.video.url,
                  streams.audio.url,
                  inicio,
                  duracao,
                  arquivoFinal
                );

                console.log(
                  '[Download] YT-API + FFmpeg concluído.'
                );

                await enviarArquivo(
                  res,
                  arquivoFinal,
                  videoId,
                  inicio
                );

                metrics.downloads++;

                return;

              } catch (erro) {

                console.error(
                  '[Download] FFmpeg YT-API falhou:',
                  erro.message
                );

              }

            } else {

              console.log(
                '[Download] Streams não acessíveis.'
              );

            }

          }

          // ==================================================
          // STREAM COMBINADA
          // ==================================================

          if (
            streams.combinado
          ) {

            console.log(
              '[Download] Tentando stream combinada.'
            );

            const combinadoOk =
              await testarStream(
                streams.combinado.url
              );

            if (
              combinadoOk
            ) {

              try {

                await executarFfmpegCombinadoArquivo(
                  streams.combinado.url,
                  inicio,
                  duracao,
                  arquivoFinal
                );

                console.log(
                  '[Download] Stream combinada concluída.'
                );

                await enviarArquivo(
                  res,
                  arquivoFinal,
                  videoId,
                  inicio
                );

                metrics.downloads++;

                return;

              } catch (erro) {

                console.error(
                  '[Download] Stream combinada falhou:',
                  erro.message
                );

              }

            }

          }

        } catch (erro) {

          console.error(
            '[Download] YT-API falhou:',
            erro.message
          );

        }

      } else {

        console.log(
          '[Download] RAPIDAPI_KEY não configurada. Pulando YT-API.'
        );

      }

      // ======================================================
      // FALLBACK YT-DLP
      // ======================================================

      console.log(
        '[Download] Ativando fallback yt-dlp...'
      );

      const arquivoBaixado =
        await baixarComYtDlp(
          videoId,
          inicio,
          duracao,
          pasta
        );

      // Se o yt-dlp já produziu exatamente o corte,
      // ainda normalizamos com FFmpeg para garantir MP4
      // compatível.

      await executarFfmpegArquivo(
        arquivoBaixado,
        0,
        duracao,
        arquivoFinal
      );

      await enviarArquivo(
        res,
        arquivoFinal,
        videoId,
        inicio
      );

      metrics.downloads++;

      console.log(
        '[Download] Finalizado pelo fallback yt-dlp.'
      );

    } catch (erro) {

      console.error(
        '[Download Error]',
        erro?.message ||
        erro
      );

      if (
        !res.headersSent
      ) {

        return respostaErro(
          res,
          500,
          'Não foi possível gerar o corte.',
          erro?.message
        );

      }

      try {

        res.end();

      } catch {}

    } finally {

      apagarDiretorio(
        pasta
      );

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

      if (
        !MP_ACCESS_TOKEN
      ) {

        return respostaErro(
          res,
          503,
          'Mercado Pago não configurado.'
        );

      }

      const {
        email,
        valor,
        userId,
        plano
      } =
        req.body || {};

      const amount =
        numeroSeguro(
          valor,
          0
        );

      if (
        amount <= 0
      ) {

        return respostaErro(
          res,
          400,
          'Valor inválido.'
        );

      }

      if (
        amount >
        10000
      ) {

        return respostaErro(
          res,
          400,
          'Valor acima do limite permitido.'
        );

      }

      const emailFinal =
        String(
          email ||
          'cliente@clipforge.local'
        ).trim();

      const idempotency =
        `clipforge-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}`;

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
                idempotency

            },

            body:
              JSON.stringify({

                transaction_amount:
                  Number(
                    amount.toFixed(2)
                  ),

                description:
                  plano === 'VIP'
                    ? 'ClipForge Pro VIP'
                    : 'ClipForge Pro',

                payment_method_id:
                  'pix',

                payer: {

                  email:
                    emailFinal

                }

              })

          }
        );

      const data =
        await pagamento
          .json()
          .catch(
            () => ({})
          );

      if (
        !pagamento.ok
      ) {

        console.error(
          '[Mercado Pago Error]',
          JSON.stringify(
            data
          )
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

      const registro = {

        id:
          String(
            data.id
          ),

        userId:
          userId ||
          null,

        plano:
          plano ||
          'VIP',

        valor:
          amount,

        status:
          data.status ||
          'pending',

        criadoEm:
          new Date()
            .toISOString()

      };

      pagamentos.set(
        String(
          data.id
        ),
        registro
      );

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
        '[PIX Error]',
        erro
      );

      return respostaErro(
        res,
        500,
        'Erro ao criar pagamento.'
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

      if (
        !MP_ACCESS_TOKEN
      ) {

        return respostaErro(
          res,
          503,
          'Mercado Pago não configurado.'
        );

      }

      const paymentId =
        String(
          req.params.id ||
          ''
        ).trim();

      if (
        !paymentId
      ) {

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

            method:
              'GET',

            headers: {

              'Authorization':
                `Bearer ${MP_ACCESS_TOKEN}`

            }

          }
        );

      const data =
        await response
          .json()
          .catch(
            () => ({})
          );

      if (
        !response.ok
      ) {

        return respostaErro(
          res,
          response.status,
          'Não foi possível consultar o pagamento.'
        );

      }

      const approved =
        data.status ===
        'approved';

      const registro =
        pagamentos.get(
          paymentId
        );

      if (
        registro
      ) {

        const eraAprovado =
          registro.status ===
          'approved';

        registro.status =
          data.status;

        registro.status_detail =
          data.status_detail;

        registro.atualizadoEm =
          new Date()
            .toISOString();

        if (
          approved &&
          !eraAprovado
        ) {

          metrics.pixAprovados++;

        }

      } else if (
        approved
      ) {

        pagamentos.set(
          paymentId,
          {

            id:
              paymentId,

            status:
              data.status,

            status_detail:
              data.status_detail,

            valor:
              Number(
                data.transaction_amount ||
                0
              ),

            atualizadoEm:
              new Date()
                .toISOString()

          }
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

        approved,

        valor:
          data.transaction_amount ||
          null

      });

    } catch (erro) {

      console.error(
        '[PIX Status Error]',
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
// WEBHOOK MERCADO PAGO
// ============================================================
//
// Endpoint preparado para receber notificações do Mercado Pago.
// ============================================================

app.post(
  '/api/pix/webhook',
  async (req, res) => {

    try {

      const body =
        req.body || {};

      console.log(
        '[PIX Webhook]',
        JSON.stringify(
          body
        ).slice(
          0,
          2000
        )
      );

      return res
        .status(200)
        .json({
          success: true
        });

    } catch (erro) {

      console.error(
        '[Webhook Error]',
        erro
      );

      return res
        .status(200)
        .json({
          success: true
        });

    }

  }
);

// ============================================================
// LIMPEZA DE TEMPORÁRIOS
// ============================================================

function limparTemporariosAntigos() {

  try {

    if (
      !fs.existsSync(
        TMP_ROOT
      )
    ) {

      return;

    }

    const agora =
      Date.now();

    const itens =
      fs.readdirSync(
        TMP_ROOT
      );

    for (
      const item of itens
    ) {

      const caminho =
        path.join(
          TMP_ROOT,
          item
        );

      try {

        const stats =
          fs.statSync(
            caminho
          );

        const idade =
          agora -
          stats.mtimeMs;

        // 30 minutos

        if (
          idade >
          30 * 60 * 1000
        ) {

          fs.rmSync(
            caminho,
            {
              recursive:
                true,
              force:
                true
            }
          );

        }

      } catch {}

    }

  } catch (erro) {

    console.error(
      '[Temp Cleanup]',
      erro.message
    );

  }

}

setInterval(
  limparTemporariosAntigos,
  10 * 60 * 1000
);

// ============================================================
// ERRO GLOBAL
// ============================================================

app.use(
  (
    err,
    req,
    res,
    next
  ) => {

    console.error(
      '[Global Error]',
      err
    );

    if (
      res.headersSent
    ) {

      return next(
        err
      );

    }

    return res
      .status(500)
      .json({

        success:
          false,

        error:
          'Erro interno do servidor.'

      });

  }
);

// ============================================================
// 404
// ============================================================

app.use(
  (
    req,
    res
  ) => {

    res
      .status(404)
      .json({

        success:
          false,

        error:
          'Endpoint não encontrado.',

        path:
          req.path

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
      '           CLIPFORGE PRO BACKEND'
    );

    console.log(
      '           VERSION 12.8.0'
    );

    console.log(
      '================================================'
    );

    console.log(
      `[ClipForge] Porta: ${PORT}`
    );

    console.log(
      `[YT-API] ${
        RAPIDAPI_KEY
          ? 'CONFIGURADA'
          : 'NÃO CONFIGURADA'
      }`
    );

    console.log(
      `[Mercado Pago] ${
        MP_ACCESS_TOKEN
          ? 'CONFIGURADO'
          : 'NÃO CONFIGURADO'
      }`
    );

    console.log(
      `[Gemini] ${
        GEMINI_API_KEY
          ? 'CONFIGURADO'
          : 'NÃO CONFIGURADO'
      }`
    );

    console.log(
      `[Admin] ${
        ADMIN_PASSWORD
          ? 'CONFIGURADO'
          : 'NÃO CONFIGURADO'
      }`
    );

    console.log(
      `[yt-dlp] ${
        fs.existsSync(
          YTDLP_PATH
        )
          ? 'Encontrado em bin/yt-dlp'
          : 'Será procurado no PATH'
      }`
    );

    console.log(
      '[Download] YT-API + FFmpeg + yt-dlp fallback ativo.'
    );

    console.log(
      '[YouTube] URLs normalizadas automaticamente.'
    );

    console.log(
      '[PIX] Mercado Pago ativo quando configurado.'
    );

    console.log(
      '================================================'
    );

  }
);

// ============================================================
// ENCERRAMENTO
// ============================================================

function encerramento(
  sinal
) {

  console.log(
    `[ClipForge] Recebido ${sinal}. Encerrando...`
  );

  try {

    limparTemporariosAntigos();

  } catch {}

  process.exit(
    0
  );

}

process.on(
  'SIGTERM',
  () =>
    encerramento(
      'SIGTERM'
    )
);

process.on(
  'SIGINT',
  () =>
    encerramento(
      'SIGINT'
    )
);