/**
 * ============================================================
 * CLIPFORGE PRO - BACKEND 13.0.1
 * ============================================================
 *
 * Baseado no backend 13.0.0
 *
 * CORREÇÕES:
 *
 * - Sessão de usuário não confia mais em userId arbitrário
 *   enviado pelo frontend.
 *
 * - Gemini Interactions API atualizada.
 *
 * - Gemini continua analisando URLs públicas do YouTube
 *   diretamente.
 *
 * - Structured JSON output do Gemini corrigido.
 *
 * - Melhor tratamento de erros do Gemini.
 *
 * - RapidAPI prioriza streams com vídeo + áudio.
 *
 * - Streams video-only não são escolhidas cegamente.
 *
 * - Validação da duração real do vídeo com ffprobe.
 *
 * - Cortes fora da duração do vídeo são corrigidos.
 *
 * - Fallback fictício do Gemini removido.
 *
 * - FFmpeg gera MP4 H.264 + AAC + faststart.
 *
 * - Melhor limpeza de arquivos temporários.
 *
 * - Controle de pontos mais seguro.
 *
 * - Reembolso em falhas de processamento.
 *
 * - Mercado Pago PIX controlado pelo servidor.
 *
 * - Webhook Mercado Pago.
 *
 * - Dashboard administrativo.
 *
 * - Sessão administrativa temporária.
 *
 * - CORS configurável.
 *
 * IMPORTANTE:
 *
 * Usuários e pagamentos ainda ficam em memória.
 * Para produção definitiva, usar PostgreSQL/Supabase.
 * ============================================================
 */

"use strict";

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();

/* ============================================================
   CONFIGURAÇÃO
   ============================================================ */

const PORT = Number(
  process.env.PORT || 10000
);

const FRONTEND_URL =
  String(
    process.env.FRONTEND_URL || "*"
  ).trim();

const RAPIDAPI_KEY =
  process.env.RAPIDAPI_KEY || "";

const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST ||
  "yt-api.p.rapidapi.com";

const MP_ACCESS_TOKEN =
  process.env.MP_ACCESS_TOKEN || "";

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || "";

const SESSION_SECRET =
  process.env.SESSION_SECRET || "";

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "";

const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.8-flash";

const YTDLP_PATH =
  process.env.YTDLP_PATH ||
  path.join(
    __dirname,
    "bin",
    "yt-dlp"
  );

const TEMP_DIR =
  process.env.TEMP_DIR ||
  path.join(
    os.tmpdir(),
    "clipforge"
  );

const DOWNLOAD_TIMEOUT =
  Number(
    process.env.DOWNLOAD_TIMEOUT ||
    180000
  );

const GEMINI_TIMEOUT =
  Number(
    process.env.GEMINI_TIMEOUT ||
    180000
  );

const MAX_CLIPS =
  Number(
    process.env.MAX_CLIPS || 5
  );

const DEFAULT_CLIP_DURATION =
  Number(
    process.env.DEFAULT_CLIP_DURATION ||
    55
  );

const MIN_CLIP_DURATION =
  Number(
    process.env.MIN_CLIP_DURATION ||
    20
  );

const MAX_CLIP_DURATION =
  Number(
    process.env.MAX_CLIP_DURATION ||
    60
  );

/* ============================================================
   CONFIGURAÇÕES DO CLIPFORGE
   ============================================================ */

const INITIAL_POINTS = 200;

const DAILY_BONUS = 50;

const DOWNLOAD_COST = 50;

const VIP_PRICE = 19.90;

const SESSION_DAYS = 30;

const ADMIN_SESSION_HOURS = 12;


/* ============================================================
   VALIDAÇÃO DE CONFIGURAÇÃO
   ============================================================ */

if (!SESSION_SECRET) {

  console.warn(
    "[SECURITY] ATENÇÃO: SESSION_SECRET não configurada."
  );

  console.warn(
    "[SECURITY] Configure SESSION_SECRET no Render."
  );
}

if (!GEMINI_API_KEY) {

  console.warn(
    "[Gemini] GEMINI_API_KEY não configurada."
  );
}


/* ============================================================
   CORS
   ============================================================ */

const corsOptions = {

  origin: (
    origin,
    callback
  ) => {

    if (!origin) {
      return callback(
        null,
        true
      );
    }

    if (
      FRONTEND_URL === "*" ||
      FRONTEND_URL === ""
    ) {

      return callback(
        null,
        true
      );
    }

    const allowed =
      FRONTEND_URL
        .split(",")
        .map(
          item =>
            item.trim()
        )
        .filter(Boolean);

    if (
      allowed.includes(origin)
    ) {

      return callback(
        null,
        true
      );
    }

    console.warn(
      "[CORS] Origem bloqueada:",
      origin
    );

    return callback(
      new Error(
        "Origem não autorizada."
      )
    );
  },

  methods: [
    "GET",
    "POST",
    "OPTIONS"
  ],

  allowedHeaders: [
    "Content-Type",
    "Authorization"
  ],

  exposedHeaders: [
    "Content-Disposition"
  ]
};


app.use(
  cors(corsOptions)
);

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);


/* ============================================================
   DIRETÓRIO TEMPORÁRIO
   ============================================================ */

try {

  fs.mkdirSync(
    TEMP_DIR,
    {
      recursive: true
    }
  );

} catch (error) {

  console.error(
    "[TEMP] Erro criando diretório:",
    error.message
  );
}


/* ============================================================
   MÉTRICAS
   ============================================================ */

const metrics = {

  downloads: 0,

  analyses: 0,

  geminiAnalyses: 0,

  failedAnalyses: 0,

  pixCreated: 0,

  pixApproved: 0,

  revenue: 0
};


/* ============================================================
   MEMÓRIA
   ============================================================ */

const usuarios =
  new Map();

const pagamentos =
  new Map();

const adminSessions =
  new Map();


/* ============================================================
   HELPERS
   ============================================================ */

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}


function safeNumber(
  value,
  fallback = 0
) {

  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {

    return fallback;
  }

  return number;
}


function clamp(
  value,
  min,
  max
) {

  return Math.max(
    min,
    Math.min(
      max,
      value
    )
  );
}


function randomId(
  prefix = ""
) {

  return (
    prefix +
    crypto
      .randomBytes(16)
      .toString("hex")
  );
}


function safeUnlink(
  filePath
) {

  try {

    if (
      filePath &&
      fs.existsSync(filePath)
    ) {

      fs.unlinkSync(
        filePath
      );
    }

  } catch (_) {}
}


/* ============================================================
   DATA BRASIL
   ============================================================ */

function getBrazilDate() {

  try {

    return new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone:
          "America/Sao_Paulo",

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit"
      }
    ).format(
      new Date()
    );

  } catch (_) {

    return new Date()
      .toISOString()
      .slice(
        0,
        10
      );
  }
}


/* ============================================================
   YOUTUBE
   ============================================================ */

function extractYouTubeId(
  input
) {

  if (!input) {
    return null;
  }

  const value =
    String(input).trim();

  if (
    /^[a-zA-Z0-9_-]{11}$/.test(
      value
    )
  ) {

    return value;
  }

  try {

    const url =
      new URL(value);

    const hostname =
      url.hostname
        .toLowerCase();

    if (
      !(
        hostname.includes(
          "youtube.com"
        ) ||
        hostname.includes(
          "youtu.be"
        ) ||
        hostname.includes(
          "youtube-nocookie.com"
        )
      )
    ) {

      return null;
    }


    if (
      hostname ===
        "youtu.be" ||
      hostname.endsWith(
        ".youtu.be"
      )
    ) {

      const id =
        url.pathname
          .replace(
            /^\/+/,
            ""
          )
          .split("/")[0];

      if (
        id &&
        /^[a-zA-Z0-9_-]{11}$/.test(
          id
        )
      ) {

        return id;
      }
    }


    const queryId =
      url.searchParams.get(
        "v"
      );

    if (
      queryId &&
      /^[a-zA-Z0-9_-]{11}$/.test(
        queryId
      )
    ) {

      return queryId;
    }


    const pathParts =
      url.pathname
        .split("/")
        .filter(Boolean);


    const shortsIndex =
      pathParts.indexOf(
        "shorts"
      );

    if (
      shortsIndex >= 0 &&
      pathParts[
        shortsIndex + 1
      ]
    ) {

      const id =
        pathParts[
          shortsIndex + 1
        ];

      if (
        /^[a-zA-Z0-9_-]{11}$/.test(
          id
        )
      ) {

        return id;
      }
    }


    const embedIndex =
      pathParts.indexOf(
        "embed"
      );

    if (
      embedIndex >= 0 &&
      pathParts[
        embedIndex + 1
      ]
    ) {

      const id =
        pathParts[
          embedIndex + 1
        ];

      if (
        /^[a-zA-Z0-9_-]{11}$/.test(
          id
        )
      ) {

        return id;
      }
    }

  } catch (_) {

    return null;
  }

  return null;
}


function buildYouTubeUrl(
  videoId
) {

  return (
    `https://www.youtube.com/watch?v=${videoId}`
  );
}


/* ============================================================
   AUTENTICAÇÃO
   ============================================================ */

function authFromRequest(
  req
) {

  const auth =
    req.headers.authorization ||
    "";

  if (!auth) {
    return "";
  }

  return auth
    .replace(
      /^Bearer\s+/i,
      ""
    )
    .trim();
}


/* ============================================================
   TOKEN HMAC
   ============================================================ */

function createUserToken(
  userId
) {

  if (!SESSION_SECRET) {

    throw new Error(
      "SESSION_SECRET não configurada."
    );
  }


  const payload = {

    userId,

    exp:
      Date.now() +
      SESSION_DAYS *
        24 *
        60 *
        60 *
        1000
  };


  const payloadText =
    Buffer
      .from(
        JSON.stringify(
          payload
        )
      )
      .toString(
        "base64url"
      );


  const signature =
    crypto
      .createHmac(
        "sha256",
        SESSION_SECRET
      )
      .update(
        payloadText
      )
      .digest(
        "base64url"
      );


  return (
    `${payloadText}.${signature}`
  );
}


function verifyUserToken(
  token
) {

  if (
    !token ||
    !SESSION_SECRET
  ) {

    return null;
  }


  const parts =
    token.split(".");


  if (
    parts.length !== 2
  ) {

    return null;
  }


  const [
    payloadText,
    signature
  ] = parts;


  try {

    const expected =
      crypto
        .createHmac(
          "sha256",
          SESSION_SECRET
        )
        .update(
          payloadText
        )
        .digest(
          "base64url"
        );


    const expectedBuffer =
      Buffer.from(
        expected
      );

    const receivedBuffer =
      Buffer.from(
        signature
      );


    if (
      expectedBuffer.length !==
      receivedBuffer.length
    ) {

      return null;
    }


    if (
      !crypto.timingSafeEqual(
        expectedBuffer,
        receivedBuffer
      )
    ) {

      return null;
    }


    const payload =
      JSON.parse(
        Buffer
          .from(
            payloadText,
            "base64url"
          )
          .toString(
            "utf8"
          )
      );


    if (
      !payload.userId ||
      !payload.exp
    ) {

      return null;
    }


    if (
      Date.now() >
      Number(
        payload.exp
      )
    ) {

      return null;
    }


    return payload;

  } catch (_) {

    return null;
  }
}


/* ============================================================
   USUÁRIO
   ============================================================ */

function getOrCreateUser(
  userId
) {

  let usuario =
    usuarios.get(
      userId
    );


  if (!usuario) {

    usuario = {

      userId,

      points:
        INITIAL_POINTS,

      vip:
        false,

      lastBonus:
        null,

      createdAt:
        Date.now(),

      updatedAt:
        Date.now()
    };


    usuarios.set(
      userId,
      usuario
    );
  }


  return usuario;
}


/* ============================================================
   BÔNUS DIÁRIO
   ============================================================ */

function aplicarBonusDiario(
  usuario
) {

  const hoje =
    getBrazilDate();


  if (
    usuario.lastBonus ===
    hoje
  ) {

    return false;
  }


  usuario.points =
    Math.max(
      0,
      safeNumber(
        usuario.points,
        0
      )
    ) +
    DAILY_BONUS;


  usuario.lastBonus =
    hoje;


  usuario.updatedAt =
    Date.now();


  return true;
}


/* ============================================================
   USUÁRIO AUTENTICADO
   ============================================================ */

function getAuthenticatedUser(
  req
) {

  const token =
    authFromRequest(
      req
    );


  const payload =
    verifyUserToken(
      token
    );


  if (!payload) {
    return null;
  }


  const usuario =
    getOrCreateUser(
      payload.userId
    );


  aplicarBonusDiario(
    usuario
  );


  return usuario;
}


/* ============================================================
   MIDDLEWARE USUÁRIO
   ============================================================ */

function requireUser(
  req,
  res,
  next
) {

  const usuario =
    getAuthenticatedUser(
      req
    );


  if (!usuario) {

    return res.status(401).json({

      ok: false,

      error:
        "Sessão inválida ou expirada.",

      code:
        "AUTH_REQUIRED"
    });
  }


  req.usuario =
    usuario;


  next();
}


/* ============================================================
   ADMIN
   ============================================================ */

function createAdminToken() {

  return crypto
    .randomBytes(32)
    .toString("hex");
}


function isAdmin(
  req
) {

  const token =
    authFromRequest(
      req
    );


  if (!token) {
    return false;
  }


  const session =
    adminSessions.get(
      token
    );


  if (!session) {
    return false;
  }


  if (
    Date.now() >
    session.expiresAt
  ) {

    adminSessions.delete(
      token
    );

    return false;
  }


  return true;
}


/* ============================================================
   STATUS
   ============================================================ */

app.get(
  "/",
  (req, res) => {

    res.json({

      ok: true,

      service:
        "ClipForge Pro Backend",

      version:
        "13.0.1",

      status:
        "online",

      gemini:
        Boolean(
          GEMINI_API_KEY
        ),

      geminiModel:
        GEMINI_MODEL,

      youtubeAIAnalysis:
        Boolean(
          GEMINI_API_KEY
        ),

      authentication:
        Boolean(
          SESSION_SECRET
        ),

      timestamp:
        new Date()
          .toISOString()
    });
  }
);


app.get(
  "/api/status",
  (req, res) => {

    res.json({

      ok: true,

      version:
        "13.0.1",

      services: {

        gemini:
          Boolean(
            GEMINI_API_KEY
          ),

        rapidapi:
          Boolean(
            RAPIDAPI_KEY
          ),

        mercadoPago:
          Boolean(
            MP_ACCESS_TOKEN
          ),

        admin:
          Boolean(
            ADMIN_PASSWORD
          ),

        authentication:
          Boolean(
            SESSION_SECRET
          ),

        ytDlp:
          fs.existsSync(
            YTDLP_PATH
          ),

        ffmpeg:
          true,

        ffprobe:
          true
      },

      metrics
    });
  }
);


/* ============================================================
   SESSÃO
   ============================================================ */

app.post(
  "/api/session",
  (req, res) => {

    try {

      if (!SESSION_SECRET) {

        return res.status(503).json({

          ok: false,

          error:
            "SESSION_SECRET não configurada no servidor."
        });
      }


      /*
       * CORREÇÃO 13.0.1
       *
       * Não confiamos mais em um userId
       * arbitrário enviado pelo frontend.
       *
       * Sempre criamos um novo usuário
       * quando não existe uma sessão válida.
       */

      const currentToken =
        authFromRequest(
          req
        );


      const existingPayload =
        verifyUserToken(
          currentToken
        );


      let usuario;


      if (
        existingPayload
      ) {

        usuario =
          getOrCreateUser(
            existingPayload.userId
          );

      } else {

        const userId =
          randomId(
            "user_"
          );


        usuario =
          getOrCreateUser(
            userId
          );
      }


      const bonusAdded =
        aplicarBonusDiario(
          usuario
        );


      const token =
        createUserToken(
          usuario.userId
        );


      return res.json({

        ok: true,

        token,

        user: {

          userId:
            usuario.userId,

          pontos:
            usuario.points,

          points:
            usuario.points,

          vip:
            usuario.vip,

          isVip:
            usuario.vip,

          dailyBonusAdded:
            bonusAdded
        }
      });

    } catch (error) {

      console.error(
        "[SESSION]",
        error.message
      );


      return res.status(500).json({

        ok: false,

        error:
          "Erro criando sessão."
      });
    }
  }
);


/* ============================================================
   ME
   ============================================================ */

app.get(
  "/api/me",
  requireUser,
  (req, res) => {

    const usuario =
      req.usuario;


    const bonusAdded =
      aplicarBonusDiario(
        usuario
      );


    return res.json({

      ok: true,

      user: {

        userId:
          usuario.userId,

        pontos:
          usuario.points,

        points:
          usuario.points,

        vip:
          usuario.vip,

        isVip:
          usuario.vip,

        dailyBonusAdded:
          bonusAdded
      }
    });
  }
);


/* ============================================================
   GEMINI
   ============================================================ */

async function analisarComGemini({
  youtubeUrl,
  videoId,
  quantity,
  targetDuration
}) {

  if (!GEMINI_API_KEY) {

    throw new Error(
      "GEMINI_API_KEY não configurada no servidor."
    );
  }


  const quantidade =
    clamp(
      Math.round(
        safeNumber(
          quantity,
          3
        )
      ),
      1,
      MAX_CLIPS
    );


  const duracaoAlvo =
    clamp(
      Math.round(
        safeNumber(
          targetDuration,
          DEFAULT_CLIP_DURATION
        )
      ),
      MIN_CLIP_DURATION,
      MAX_CLIP_DURATION
    );


  /*
   * Schema JSON.
   */

  const schema = {

    type:
      "object",

    properties: {

      clips: {

        type:
          "array",

        items: {

          type:
            "object",

          properties: {

            start: {
              type:
                "number"
            },

            end: {
              type:
                "number"
            },

            title: {
              type:
                "string"
            },

            reason: {
              type:
                "string"
            },

            score: {
              type:
                "number"
            }
          },

          required: [
            "start",
            "end",
            "title",
            "reason",
            "score"
          ]
        }
      }
    },

    required: [
      "clips"
    ]
  };


  const prompt = `
Você é o motor profissional de seleção de cortes do ClipForge Pro.

Analise cuidadosamente o vídeo inteiro do YouTube.

Analise:

- imagem
- áudio
- falas
- contexto
- mudanças de cena
- humor
- emoção
- surpresa
- conflitos
- revelações
- frases fortes
- perguntas
- respostas
- momentos inesperados
- momentos que geram curiosidade
- momentos com potencial para Shorts
- momentos com potencial para Reels
- momentos com potencial para TikTok

OBJETIVO:

Encontrar exatamente os melhores momentos disponíveis,
até o limite de ${quantidade} cortes.

Cada corte deve ter aproximadamente
${duracaoAlvo} segundos.

REGRAS OBRIGATÓRIAS:

1. Retorne timestamps em segundos.
2. "start" é o início do corte.
3. "end" é o final do corte.
4. Nunca use timestamps negativos.
5. Não invente acontecimentos.
6. Não invente timestamps.
7. O corte precisa existir realmente no vídeo.
8. Evite começar no meio de uma frase.
9. Evite terminar no meio de uma frase.
10. Prefira momentos com começo, desenvolvimento e conclusão.
11. Evite silêncio prolongado.
12. Evite trechos sem contexto.
13. Prefira momentos que funcionem isoladamente.
14. O score deve ser de 0 a 100.
15. Ordene pelo maior potencial primeiro.
16. Cada corte deve ter entre ${MIN_CLIP_DURATION} e ${MAX_CLIP_DURATION} segundos.
17. Não ultrapasse ${quantidade} cortes.
18. Se houver menos momentos realmente válidos, retorne somente os válidos.
19. Não repita o mesmo trecho.
20. Priorize retenção e potencial de compartilhamento.

RESPONDA SOMENTE COM JSON VÁLIDO.
`;


  const body = {

    model:
      GEMINI_MODEL,

    input: [

      {
        type:
          "text",

        text:
          prompt
      },

      {
        type:
          "video",

        uri:
          youtubeUrl
      }
    ],

    response_format: {

      type:
        "text",

      mime_type:
        "application/json",

      schema
    }
  };


  console.log(
    "[Gemini] =================================="
  );

  console.log(
    "[Gemini] Enviando URL pública do YouTube."
  );

  console.log(
    "[Gemini] Modelo:",
    GEMINI_MODEL
  );

  console.log(
    "[Gemini] Vídeo:",
    videoId
  );


  const controller =
    new AbortController();


  const timeout =
    setTimeout(
      () => {
        controller.abort();
      },
      GEMINI_TIMEOUT
    );


  let response;


  try {

    response =
      await fetch(
        "https://generativelanguage.googleapis.com/v1beta/interactions",
        {

          method:
            "POST",

          headers: {

            "Content-Type":
              "application/json",

            "x-goog-api-key":
              GEMINI_API_KEY
          },

          body:
            JSON.stringify(
              body
            ),

          signal:
            controller.signal
        }
      );

  } catch (error) {

    if (
      error.name ===
      "AbortError"
    ) {

      throw new Error(
        `Gemini excedeu o timeout de ${Math.round(
          GEMINI_TIMEOUT / 1000
        )} segundos.`
      );
    }

    throw error;

  } finally {

    clearTimeout(
      timeout
    );
  }


  const rawText =
    await response.text();


  let data;


  try {

    data =
      JSON.parse(
        rawText
      );

  } catch (_) {

    data = {
      raw:
        rawText
    };
  }


  if (
    !response.ok
  ) {

    console.error(
      "[Gemini] HTTP:",
      response.status
    );


    console.error(
      "[Gemini] Resposta:",
      rawText.substring(
        0,
        4000
      )
    );


    const apiMessage =
      data?.error?.message ||
      data?.message ||
      data?.raw ||
      "Resposta desconhecida";


    throw new Error(
      `Gemini HTTP ${response.status}: ${apiMessage}`
    );
  }


  /*
   * A Interactions API retorna output_text.
   */

  let outputText =
    data?.output_text ||
    data?.outputText ||
    "";


  /*
   * Compatibilidade com respostas
   * que trazem outputs.
   */

  if (
    !outputText &&
    Array.isArray(
      data?.outputs
    )
  ) {

    const textParts =
      [];


    for (
      const output
      of data.outputs
    ) {

      if (
        typeof output?.text ===
        "string"
      ) {

        textParts.push(
          output.text
        );
      }


      if (
        Array.isArray(
          output?.content
        )
      ) {

        for (
          const content
          of output.content
        ) {

          if (
            typeof content?.text ===
            "string"
          ) {

            textParts.push(
              content.text
            );
          }
        }
      }
    }


    outputText =
      textParts.join("");
  }


  /*
   * Compatibilidade com steps.
   */

  if (
    !outputText &&
    Array.isArray(
      data?.steps
    )
  ) {

    const textParts =
      [];


    for (
      const step
      of data.steps
    ) {

      if (
        typeof step?.text ===
        "string"
      ) {

        textParts.push(
          step.text
        );
      }


      if (
        Array.isArray(
          step?.content
        )
      ) {

        for (
          const content
          of step.content
        ) {

          if (
            typeof content?.text ===
            "string"
          ) {

            textParts.push(
              content.text
            );
          }
        }
      }
    }


    outputText =
      textParts.join("");
  }


  if (!outputText) {

    console.error(
      "[Gemini] Nenhum output_text encontrado."
    );


    console.error(
      JSON.stringify(
        data
      ).substring(
        0,
        6000
      )
    );


    throw new Error(
      "Gemini não retornou o JSON dos cortes."
    );
  }


  outputText =
    String(
      outputText
    ).trim();


  let result;


  try {

    result =
      JSON.parse(
        outputText
      );

  } catch (_) {

    const cleaned =
      outputText
        .replace(
          /^```json\s*/i,
          ""
        )
        .replace(
          /^```\s*/i,
          ""
        )
        .replace(
          /\s*```$/i,
          ""
        )
        .trim();


    try {

      result =
        JSON.parse(
          cleaned
        );

    } catch (jsonError) {

      console.error(
        "[Gemini] JSON inválido:"
      );

      console.error(
        outputText.substring(
          0,
          5000
        )
      );


      throw new Error(
        "Gemini retornou uma resposta que não pôde ser convertida em JSON."
      );
    }
  }


  if (
    !result ||
    !Array.isArray(
      result.clips
    )
  ) {

    throw new Error(
      "Gemini não retornou uma lista válida de clips."
    );
  }


  const clips =
    result.clips
      .map(
        (
          clip,
          index
        ) => {

          const rawStart =
            safeNumber(
              clip?.start,
              0
            );


          const rawEnd =
            safeNumber(
              clip?.end,
              rawStart +
                duracaoAlvo
            );


          let start =
            Math.max(
              0,
              Math.floor(
                rawStart
              )
            );


          let end =
            Math.max(
              start +
                MIN_CLIP_DURATION,
              Math.floor(
                rawEnd
              )
            );


          /*
           * Limita a duração.
           */

          if (
            end - start >
            MAX_CLIP_DURATION
          ) {

            end =
              start +
              MAX_CLIP_DURATION;
          }


          const duration =
            end - start;


          return {

            id:
              index + 1,

            inicio:
              start,

            fim:
              end,

            duracao:
              duration,

            titulo:
              String(
                clip?.title ||
                `Melhor momento #${index + 1}`
              ).substring(
                0,
                150
              ),

            motivo:
              String(
                clip?.reason ||
                "Momento identificado pela IA."
              ).substring(
                0,
                500
              ),

            score:
              clamp(
                Math.round(
                  safeNumber(
                    clip?.score,
                    80
                  )
                ),
                0,
                100
              ),

            ai:
              true,

            modelo:
              GEMINI_MODEL
          };
        }
      )
      .filter(
        clip =>
          clip.duracao >=
            MIN_CLIP_DURATION &&
          clip.duracao <=
            MAX_CLIP_DURATION &&
          clip.fim >
            clip.inicio
      )
      .sort(
        (
          a,
          b
        ) =>
          b.score -
          a.score
      )
      .slice(
        0,
        quantidade
      );


  if (
    !clips.length
  ) {

    throw new Error(
      "A IA não encontrou cortes válidos."
    );
  }


  console.log(
    `[Gemini] ${clips.length} cortes encontrados.`
  );


  for (
    const clip
    of clips
  ) {

    console.log(
      `[Gemini] #${clip.id} ` +
      `${clip.inicio}s → ${clip.fim}s ` +
      `(${clip.duracao}s) ` +
      `score=${clip.score}`
    );
  }


  metrics.geminiAnalyses++;


  return clips;
}


/* ============================================================
   ANALISAR
   ============================================================ */

app.post(
  "/api/analisar",
  requireUser,
  async (
    req,
    res
  ) => {

    const youtubeUrl =
      String(
        req.body?.youtubeUrl ||
        req.body?.url ||
        ""
      ).trim();


    const requestedVideoId =
      String(
        req.body?.videoId ||
        ""
      ).trim();


    const quantity =
      safeNumber(
        req.body?.quantity,
        3
      );


    const duration =
      safeNumber(
        req.body?.duration,
        DEFAULT_CLIP_DURATION
      );


    console.log("");

    console.log(
      "[Análise] =================================="
    );

    console.log(
      "[Análise] Usuário:",
      req.usuario.userId
    );

    console.log(
      "[Análise] Entrada:",
      youtubeUrl ||
      requestedVideoId
    );


    const videoId =
      extractYouTubeId(
        youtubeUrl
      ) ||
      extractYouTubeId(
        requestedVideoId
      );


    if (!videoId) {

      return res.status(400).json({

        ok: false,

        error:
          "Link do YouTube inválido."
      });
    }


    const finalYoutubeUrl =
      buildYouTubeUrl(
        videoId
      );


    const safeQuantity =
      clamp(
        Math.round(
          quantity
        ),
        1,
        MAX_CLIPS
      );


    const safeDuration =
      clamp(
        Math.round(
          duration
        ),
        MIN_CLIP_DURATION,
        MAX_CLIP_DURATION
      );


    metrics.analyses++;


    console.log(
      "[Análise] ID:",
      videoId
    );

    console.log(
      "[Análise] Quantidade:",
      safeQuantity
    );

    console.log(
      "[Análise] Duração:",
      safeDuration
    );


    if (!GEMINI_API_KEY) {

      return res.status(503).json({

        ok: false,

        success: false,

        ai: false,

        videoId,

        error:
          "A análise por IA está temporariamente indisponível.",

        code:
          "GEMINI_NOT_CONFIGURED",

        hint:
          "Configure GEMINI_API_KEY no Render."
      });
    }


    try {

      const clips =
        await analisarComGemini({

          youtubeUrl:
            finalYoutubeUrl,

          videoId,

          quantity:
            safeQuantity,

          targetDuration:
            safeDuration
        });


      return res.json({

        ok: true,

        success: true,

        ai: true,

        modelo:
          GEMINI_MODEL,

        videoId,

        youtubeUrl:
          finalYoutubeUrl,

        clips,

        quantidade:
          clips.length,

        message:
          "Cortes encontrados pela IA Gemini."
      });

    } catch (error) {

      metrics.failedAnalyses++;


      console.error(
        "[Análise] Gemini falhou:",
        error.message
      );


      return res.status(502).json({

        ok: false,

        success: false,

        ai: false,

        videoId,

        error:
          "A IA não conseguiu analisar este vídeo.",

        details:
          error.message,

        hint:
          "Verifique se o vídeo é público, se a GEMINI_API_KEY está válida e se o modelo configurado está disponível."
      });
    }
  }
);


/* ============================================================
   RAPIDAPI YT-API
   ============================================================ */

async function consultarYTAPI(
  videoId
) {

  if (!RAPIDAPI_KEY) {

    throw new Error(
      "RAPIDAPI_KEY não configurada."
    );
  }


  const url =
    `https://${RAPIDAPI_HOST}/dl?id=${encodeURIComponent(
      videoId
    )}&cgeo=BR`;


  console.log(
    "[YT-API] Consultando:",
    videoId
  );


  const response =
    await fetch(
      url,
      {

        method:
          "GET",

        headers: {

          "x-rapidapi-key":
            RAPIDAPI_KEY,

          "x-rapidapi-host":
            RAPIDAPI_HOST
        },

        signal:
          AbortSignal.timeout(
            30000
          )
      }
    );


  const text =
    await response.text();


  let data;


  try {

    data =
      JSON.parse(
        text
      );

  } catch (_) {

    throw new Error(
      "YT-API retornou resposta inválida."
    );
  }


  if (
    !response.ok
  ) {

    throw new Error(
      `YT-API HTTP ${response.status}`
    );
  }


  const streams =
    [];


  function collect(
    value
  ) {

    if (!value) {
      return;
    }


    if (
      Array.isArray(
        value
      )
    ) {

      for (
        const item
        of value
      ) {

        collect(
          item
        );
      }

      return;
    }


    if (
      typeof value !==
      "object"
    ) {

      return;
    }


    const urlCandidate =
      value.url ||
      value.link ||
      value.download_url ||
      value.downloadUrl;


    if (
      typeof urlCandidate ===
        "string" &&
      /^https?:\/\//i.test(
        urlCandidate
      )
    ) {

      const mime =
        String(
          value.mime ||
          value.mimeType ||
          value.type ||
          ""
        );


      const quality =
        String(
          value.quality ||
          value.qualityLabel ||
          value.resolution ||
          ""
        );


      const audio =
        Boolean(
          value.audio ||
          value.hasAudio ||
          value.has_audio ||
          value.withAudio ||
          value.with_audio
        );


      const hasVideo =
        Boolean(
          value.video ||
          value.hasVideo ||
          value.has_video ||
          /^video\//i.test(
            mime
          )
        );


      const combined =
        Boolean(
          audio &&
          hasVideo
        ) ||
        (
          /^video\/mp4/i.test(
            mime
          ) &&
          !/video-only/i.test(
            quality
          )
        );


      streams.push({

        url:
          urlCandidate,

        mime,

        quality,

        height:
          safeNumber(
            value.height,
            0
          ),

        width:
          safeNumber(
            value.width,
            0
          ),

        audio,

        hasVideo,

        combined
      });
    }


    for (
      const key of Object.keys(
        value
      )
    ) {

      const child =
        value[key];


      if (
        child &&
        typeof child ===
          "object"
      ) {

        collect(
          child
        );
      }
    }
  }


  collect(
    data
  );


  const unique =
    [];


  const seen =
    new Set();


  for (
    const stream
    of streams
  ) {

    if (
      seen.has(
        stream.url
      )
    ) {

      continue;
    }


    seen.add(
      stream.url
    );


    unique.push(
      stream
    );
  }


  console.log(
    "[YT-API] Streams encontradas:",
    unique.length
  );


  const combined =
    unique.filter(
      stream =>
        stream.combined
    );


  const withAudio =
    unique.filter(
      stream =>
        stream.audio
    );


  console.log(
    "[YT-API] Streams combinadas:",
    combined.length
  );


  console.log(
    "[YT-API] Streams com áudio:",
    withAudio.length
  );


  return unique;
}


/* ============================================================
   TESTE DE STREAM
   ============================================================ */

async function testarStream(
  url
) {

  try {

    const response =
      await fetch(
        url,
        {

          method:
            "GET",

          headers: {

            Range:
              "bytes=0-1023",

            "User-Agent":
              "Mozilla/5.0"
          },

          redirect:
            "follow",

          signal:
            AbortSignal.timeout(
              15000
            )
        }
      );


    console.log(
      "[Download] Teste stream:",
      response.status
    );


    if (
      response.body &&
      typeof response.body.cancel ===
        "function"
    ) {

      try {

        await response.body.cancel();

      } catch (_) {}
    }


    return response.ok;

  } catch (error) {

    console.log(
      "[Download] Teste falhou:",
      error.message
    );


    return false;
  }
}


/* ============================================================
   FFPROBE
   ============================================================ */

function ffprobeInfo(
  filePath
) {

  return new Promise(
    resolve => {

      const child =
        spawn(
          "ffprobe",
          [

            "-v",
            "error",

            "-show_entries",
            "format=duration",

            "-show_entries",
            "stream=codec_type",

            "-of",
            "json",

            filePath
          ]
        );


      let output =
        "";

      let stderr =
        "";


      child.stdout.on(
        "data",
        data => {

          output +=
            data.toString();
        }
      );


      child.stderr.on(
        "data",
        data => {

          stderr +=
            data.toString();
        }
      );


      child.on(
        "error",
        () => {

          resolve(
            null
          );
        }
      );


      child.on(
        "close",
        code => {

          if (
            code !== 0
          ) {

            resolve(
              null
            );

            return;
          }


          try {

            const data =
              JSON.parse(
                output
              );


            const duration =
              Number(
                data?.format?.duration
              );


            const streams =
              Array.isArray(
                data?.streams
              )
                ? data.streams
                : [];


            const hasVideo =
              streams.some(
                stream =>
                  stream.codec_type ===
                  "video"
              );


            const hasAudio =
              streams.some(
                stream =>
                  stream.codec_type ===
                  "audio"
              );


            resolve({

              duration:
                Number.isFinite(
                  duration
                )
                  ? duration
                  : null,

              hasVideo,

              hasAudio

            });

          } catch (_) {

            resolve(
              null
            );
          }
        }
      );
    }
  );
}


async function ffprobeDuration(
  filePath
) {

  const info =
    await ffprobeInfo(
      filePath
    );


  return (
    info?.duration ||
    null
  );
}


/* ============================================================
   DOWNLOAD STREAM PARA ARQUIVO
   ============================================================ */

async function baixarStreamParaArquivo(
  streamUrl,
  outputPath
) {

  const response =
    await fetch(
      streamUrl,
      {

        method:
          "GET",

        headers: {

          "User-Agent":
            "Mozilla/5.0",

          Accept:
            "*/*"
        },

        redirect:
          "follow",

        signal:
          AbortSignal.timeout(
            DOWNLOAD_TIMEOUT
          )
      }
    );


  if (
    !response.ok
  ) {

    throw new Error(
      `Stream HTTP ${response.status}`
    );
  }


  if (
    !response.body
  ) {

    throw new Error(
      "Stream sem body."
    );
  }


  const fileStream =
    fs.createWriteStream(
      outputPath
    );


  const reader =
    response.body.getReader();


  try {

    while (true) {

      const {
        done,
        value
      } =
        await reader.read();


      if (
        done
      ) {

        break;
      }


      if (
        value
      ) {

        const canContinue =
          fileStream.write(
            Buffer.from(
              value
            )
          );


        if (
          !canContinue
        ) {

          await new Promise(
            resolve =>
              fileStream.once(
                "drain",
                resolve
              )
          );
        }
      }
    }


    await new Promise(
      (
        resolve,
        reject
      ) => {

        fileStream.end(
          resolve
        );

        fileStream.on(
          "error",
          reject
        );
      }
    );


    return outputPath;

  } catch (error) {

    try {

      await reader.cancel();

    } catch (_) {}


    try {

      fileStream.destroy();

    } catch (_) {}


    safeUnlink(
      outputPath
    );


    throw error;
  }
}


/* ============================================================
   EXECUTAR PROCESSO
   ============================================================ */

function executar(
  command,
  args,
  options = {}
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      console.log(
        "[Processo]",
        command,
        args.join(" ")
      );


      const child =
        spawn(
          command,
          args,
          {
            ...options
          }
        );


      let stdout =
        "";

      let stderr =
        "";


      child.stdout?.on(
        "data",
        data => {

          stdout +=
            data.toString();
        }
      );


      child.stderr?.on(
        "data",
        data => {

          stderr +=
            data.toString();
        }
      );


      child.on(
        "error",
        reject
      );


      child.on(
        "close",
        code => {

          resolve({

            code,

            stdout,

            stderr
          });
        }
      );
    }
  );
}


/* ============================================================
   YT-DLP
   ============================================================ */

async function baixarComYtDlp(
  videoId,
  outputPath
) {

  if (
    !fs.existsSync(
      YTDLP_PATH
    )
  ) {

    throw new Error(
      "yt-dlp não encontrado."
    );
  }


  console.log(
    "[YT-DLP] Fallback ativado."
  );


  console.log(
    "[YT-DLP] Executável:",
    YTDLP_PATH
  );


  const url =
    buildYouTubeUrl(
      videoId
    );


  const args = [

    "--no-playlist",

    "--no-warnings",

    "--newline",

    "--restrict-filenames",

    "-f",
    "bv*+ba/b",

    "--merge-output-format",
    "mp4",

    "-o",
    outputPath,

    url
  ];


  const result =
    await executar(
      YTDLP_PATH,
      args,
      {

        cwd:
          path.dirname(
            YTDLP_PATH
          )
      }
    );


  if (
    result.code !== 0
  ) {

    throw new Error(
      `yt-dlp terminou com código ${result.code}. ` +
      result.stderr.slice(
        -3000
      )
    );
  }


  if (
    !fs.existsSync(
      outputPath
    )
  ) {

    throw new Error(
      "yt-dlp terminou sem gerar o arquivo."
    );
  }


  const info =
    await ffprobeInfo(
      outputPath
    );


  if (
    !info ||
    !info.hasVideo
  ) {

    throw new Error(
      "yt-dlp gerou um arquivo sem vídeo válido."
    );
  }


  console.log(
    "[YT-DLP] Vídeo válido."
  );


  console.log(
    "[YT-DLP] Duração:",
    info.duration
  );


  console.log(
    "[YT-DLP] Áudio:",
    info.hasAudio
  );


  return outputPath;
}


/* ============================================================
   SELEÇÃO DE STREAMS
   ============================================================ */

function ordenarStreams(
  streams
) {

  return [...streams].sort(
    (
      a,
      b
    ) => {

      function score(
        stream
      ) {

        let value =
          0;


        /*
         * Muito importante:
         * streams combinadas vêm primeiro.
         */

        if (
          stream.combined
        ) {

          value +=
            100000;
        }


        if (
          stream.audio
        ) {

          value +=
            30000;
        }


        if (
          stream.hasVideo
        ) {

          value +=
            10000;
        }


        value +=
          (
            stream.height ||
            0
          ) *
          100;


        value +=
          (
            stream.width ||
            0
          );


        const mime =
          String(
            stream.mime ||
            ""
          ).toLowerCase();


        if (
          mime.includes(
            "video/mp4"
          )
        ) {

          value +=
            5000;
        }


        if (
          mime.includes(
            "video/webm"
          )
        ) {

          value +=
            1000;
        }


        return value;
      }


      return (
        score(b) -
        score(a)
      );
    }
  );
}


/* ============================================================
   FFmpeg
   ============================================================ */

async function cortarVideo(
  inputPath,
  outputPath,
  start,
  duration
) {

  const info =
    await ffprobeInfo(
      inputPath
    );


  if (
    !info ||
    !info.hasVideo
  ) {

    throw new Error(
      "Arquivo original não contém vídeo válido."
    );
  }


  const videoDuration =
    safeNumber(
      info.duration,
      0
    );


  if (
    videoDuration <= 0
  ) {

    throw new Error(
      "Não foi possível determinar a duração do vídeo."
    );
  }


  let safeStart =
    Math.max(
      0,
      Math.floor(
        safeNumber(
          start,
          0
        )
      )
    );


  if (
    safeStart >=
    videoDuration
  ) {

    throw new Error(
      `O início do corte (${safeStart}s) está fora da duração do vídeo (${Math.floor(
        videoDuration
      )}s).`
    );
  }


  let safeDuration =
    clamp(
      Math.floor(
        safeNumber(
          duration,
          DEFAULT_CLIP_DURATION
        )
      ),
      1,
      300
    );


  /*
   * Nunca ultrapassa o final real.
   */

  const available =
    Math.max(
      1,
      Math.floor(
        videoDuration -
        safeStart
      )
    );


  safeDuration =
    Math.min(
      safeDuration,
      available
    );


  /*
   * Se o trecho ficou muito pequeno,
   * não tenta gerar um corte inválido.
   */

  if (
    safeDuration <
    MIN_CLIP_DURATION &&
    videoDuration -
      safeStart >=
      MIN_CLIP_DURATION
  ) {

    safeDuration =
      MIN_CLIP_DURATION;
  }


  console.log(
    `[FFmpeg] Vídeo original: ${videoDuration.toFixed(
      2
    )}s`
  );


  console.log(
    `[FFmpeg] Corte: ${safeStart}s / ${safeDuration}s`
  );


  const args = [

    "-y",

    "-ss",
    String(
      safeStart
    ),

    "-i",
    inputPath,

    "-t",
    String(
      safeDuration
    ),

    "-map",
    "0:v:0",

    "-map",
    "0:a:0?",

    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-crf",
    "23",

    "-pix_fmt",
    "yuv420p",

    "-c:a",
    "aac",

    "-b:a",
    "128k",

    "-ar",
    "44100",

    "-movflags",
    "+faststart",

    "-avoid_negative_ts",
    "make_zero",

    outputPath
  ];


  const result =
    await executar(
      "ffmpeg",
      args
    );


  if (
    result.code !== 0
  ) {

    throw new Error(
      "FFmpeg falhou: " +
      result.stderr.slice(
        -4000
      )
    );
  }


  if (
    !fs.existsSync(
      outputPath
    )
  ) {

    throw new Error(
      "FFmpeg não gerou o arquivo."
    );
  }


  const outputInfo =
    await ffprobeInfo(
      outputPath
    );


  if (
    !outputInfo ||
    !outputInfo.hasVideo
  ) {

    throw new Error(
      "O MP4 final não contém vídeo válido."
    );
  }


  console.log(
    "[FFmpeg] MP4 final válido."
  );


  console.log(
    "[FFmpeg] Duração:",
    outputInfo.duration
  );


  console.log(
    "[FFmpeg] Áudio:",
    outputInfo.hasAudio
  );


  return outputPath;
}


/* ============================================================
   DOWNLOAD / RENDER
   ============================================================ */

app.get(
  "/api/download",
  requireUser,
  async (
    req,
    res
  ) => {

    const usuario =
      req.usuario;


    const videoId =
      extractYouTubeId(
        req.query?.id ||
        req.query?.url ||
        ""
      );


    let start =
      Math.max(
        0,
        safeNumber(
          req.query?.start,
          0
        )
      );


    const duration =
      clamp(
        safeNumber(
          req.query?.duration,
          DEFAULT_CLIP_DURATION
        ),
        1,
        300
      );


    if (!videoId) {

      return res.status(400).json({

        ok: false,

        error:
          "ID ou URL do YouTube inválido."
      });
    }


    const isVip =
      Boolean(
        usuario.vip
      );


    let chargedPoints =
      false;


    /*
     * ========================================================
     * PONTOS
     * ========================================================
     */

    if (!isVip) {

      const points =
        safeNumber(
          usuario.points,
          0
        );


      if (
        points <
        DOWNLOAD_COST
      ) {

        return res.status(402).json({

          ok: false,

          error:
            "Pontos insuficientes.",

          code:
            "INSUFFICIENT_POINTS",

          pontos:
            points,

          points,

          custo:
            DOWNLOAD_COST,

          vip:
            false
        });
      }


      usuario.points =
        points -
        DOWNLOAD_COST;


      usuario.updatedAt =
        Date.now();


      chargedPoints =
        true;
    }


    const jobId =
      crypto
        .randomBytes(8)
        .toString("hex");


    const originalPath =
      path.join(
        TEMP_DIR,
        `${jobId}-original.mp4`
      );


    const clipPath =
      path.join(
        TEMP_DIR,
        `${jobId}-short.mp4`
      );


    console.log("");

    console.log(
      "[Download] =================================="
    );

    console.log(
      "[Download] CLIPFORGE 13.0.1"
    );

    console.log(
      "[Download] Usuário:",
      usuario.userId
    );

    console.log(
      "[Download] VIP:",
      isVip
    );

    console.log(
      "[Download] Pontos cobrados:",
      chargedPoints
        ? DOWNLOAD_COST
        : 0
    );

    console.log(
      "[Download] Vídeo:",
      videoId
    );

    console.log(
      "[Download] Start:",
      start
    );

    console.log(
      "[Download] Duration:",
      duration
    );


    let responseStarted =
      false;


    try {

      let sourceDownloaded =
        false;


      /*
       * ========================================================
       * 1. RAPIDAPI
       * ========================================================
       */

      if (
        RAPIDAPI_KEY
      ) {

        try {

          const streams =
            await consultarYTAPI(
              videoId
            );


          const orderedStreams =
            ordenarStreams(
              streams
            );


          console.log(
            "[Download] Streams ordenadas:",
            orderedStreams.length
          );


          /*
           * Primeiro tentamos somente
           * streams que parecem possuir
           * vídeo + áudio.
           */

          const preferred =
            orderedStreams.filter(
              stream =>
                stream.combined
            );


          const secondary =
            orderedStreams.filter(
              stream =>
                !stream.combined &&
                stream.audio &&
                stream.hasVideo
            );


          const candidates = [

            ...preferred,

            ...secondary

          ];


          console.log(
            "[Download] Candidatas A/V:",
            candidates.length
          );


          for (
            const stream
            of candidates.slice(
              0,
              15
            )
          ) {

            if (
              !stream.url
            ) {

              continue;
            }


            console.log(
              "[Download] Testando stream:",
              stream.quality ||
              stream.mime ||
              "desconhecida"
            );


            const accessible =
              await testarStream(
                stream.url
              );


            if (
              !accessible
            ) {

              continue;
            }


            try {

              safeUnlink(
                originalPath
              );


              await baixarStreamParaArquivo(
                stream.url,
                originalPath
              );


              if (
                !fs.existsSync(
                  originalPath
                )
              ) {

                continue;
              }


              const info =
                await ffprobeInfo(
                  originalPath
                );


              if (
                info &&
                info.hasVideo &&
                info.hasAudio
              ) {

                console.log(
                  "[Download] Stream A/V válida encontrada."
                );


                console.log(
                  "[Download] Duração:",
                  info.duration
                );


                sourceDownloaded =
                  true;


                break;
              }


              console.log(
                "[Download] Stream não possui vídeo + áudio. Ignorando."
              );


              safeUnlink(
                originalPath
              );

            } catch (error) {

              console.log(
                "[Download] Falha baixando stream:",
                error.message
              );


              safeUnlink(
                originalPath
              );
            }
          }

        } catch (error) {

          console.log(
            "[Download] YT-API falhou:",
            error.message
          );
        }
      }


      /*
       * ========================================================
       * 2. YT-DLP
       * ========================================================
       */

      if (
        !sourceDownloaded
      ) {

        console.log(
          "[Download] Ativando fallback yt-dlp..."
        );


        try {

          safeUnlink(
            originalPath
          );


          await baixarComYtDlp(
            videoId,
            originalPath
          );


          sourceDownloaded =
            fs.existsSync(
              originalPath
            );

        } catch (error) {

          console.error(
            "[YT-DLP] Falhou:",
            error.message
          );


          safeUnlink(
            originalPath
          );
        }
      }


      /*
       * ========================================================
       * 3. NENHUMA FONTE
       * ========================================================
       */

      if (
        !sourceDownloaded
      ) {

        if (
          chargedPoints
        ) {

          usuario.points +=
            DOWNLOAD_COST;

          usuario.updatedAt =
            Date.now();
        }


        return res.status(502).json({

          ok: false,

          error:
            "Não foi possível obter uma fonte de vídeo acessível para gerar o MP4.",

          reason:
            "O YouTube ou a fonte utilizada bloqueou o acesso ao arquivo.",

          pointsRefunded:
            chargedPoints,

          pontos:
            usuario.points,

          points:
            usuario.points,

          message:
            "A análise da IA e a geração do MP4 são etapas diferentes. A IA pode analisar o vídeo, mas o servidor ainda precisa conseguir obter uma fonte de vídeo para renderizar o corte."
        });
      }


      /*
       * ========================================================
       * 4. VALIDAÇÃO DO VÍDEO
       * ========================================================
       */

      const sourceInfo =
        await ffprobeInfo(
          originalPath
        );


      if (
        !sourceInfo ||
        !sourceInfo.hasVideo
      ) {

        throw new Error(
          "O arquivo baixado não possui vídeo válido."
        );
      }


      const sourceDuration =
        safeNumber(
          sourceInfo.duration,
          0
        );


      if (
        sourceDuration <= 0
      ) {

        throw new Error(
          "Não foi possível determinar a duração do vídeo baixado."
        );
      }


      /*
       * Se o frontend enviar um timestamp
       * fora do vídeo, tentamos corrigir.
       */

      if (
        start >=
        sourceDuration
      ) {

        throw new Error(
          `O timestamp ${start}s está fora do vídeo de ${Math.floor(
            sourceDuration
          )}s.`
        );
      }


      /*
       * Se o corte ultrapassar o fim,
       * reduzimos automaticamente.
       */

      let safeDuration =
        duration;


      if (
        start +
          safeDuration >
        sourceDuration
      ) {

        safeDuration =
          Math.floor(
            sourceDuration -
            start
          );
      }


      if (
        safeDuration <= 0
      ) {

        throw new Error(
          "Não existe duração suficiente para gerar o corte."
        );
      }


      /*
       * ========================================================
       * 5. FFMPEG
       * ========================================================
       */

      await cortarVideo(
        originalPath,
        clipPath,
        start,
        safeDuration
      );


      metrics.downloads++;


      /*
       * ========================================================
       * 6. ENVIO DO MP4
       * ========================================================
       */

      const filename =
        `clipforge-short-${videoId}-${Math.floor(
          start
        )}s.mp4`;


      res.statusCode =
        200;


      res.setHeader(
        "Content-Type",
        "video/mp4"
      );


      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );


      res.setHeader(
        "Content-Length",
        String(
          fs.statSync(
            clipPath
          ).size
        )
      );


      res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate"
      );


      res.setHeader(
        "Pragma",
        "no-cache"
      );


      responseStarted =
        true;


      const stream =
        fs.createReadStream(
          clipPath
        );


      stream.on(
        "error",
        error => {

          console.error(
            "[Download] Erro enviando arquivo:",
            error.message
          );


          safeUnlink(
            clipPath
          );

          safeUnlink(
            originalPath
          );
        }
      );


      stream.on(
        "close",
        () => {

          setTimeout(
            () => {

              safeUnlink(
                clipPath
              );

              safeUnlink(
                originalPath
              );

            },
            5000
          );
        }
      );


      stream.pipe(
        res
      );

    } catch (error) {

      console.error(
        "[Download Error]",
        error.message
      );


      /*
       * Reembolso.
       */

      if (
        chargedPoints
      ) {

        usuario.points +=
          DOWNLOAD_COST;

        usuario.updatedAt =
          Date.now();


        console.log(
          "[Pontos] Reembolso:",
          DOWNLOAD_COST
        );
      }


      safeUnlink(
        originalPath
      );

      safeUnlink(
        clipPath
      );


      if (
        !responseStarted &&
        !res.headersSent
      ) {

        return res.status(500).json({

          ok: false,

          error:
            "Erro ao gerar o corte.",

          details:
            error.message,

          pointsRefunded:
            chargedPoints,

          pontos:
            usuario.points,

          points:
            usuario.points
        });
      }
    }
  }
);


/* ============================================================
   ADMIN LOGIN
   ============================================================ */

app.post(
  "/api/admin/login",
  (req, res) => {

    const password =
      String(
        req.body?.password ||
        ""
      );


    if (
      !ADMIN_PASSWORD
    ) {

      return res.status(503).json({

        ok: false,

        error:
          "ADMIN_PASSWORD não configurada."
      });
    }


    if (
      password !==
      ADMIN_PASSWORD
    ) {

      return res.status(401).json({

        ok: false,

        authenticated:
          false,

        error:
          "Senha administrativa inválida."
      });
    }


    const token =
      createAdminToken();


    const createdAt =
      Date.now();


    const expiresAt =
      createdAt +
      ADMIN_SESSION_HOURS *
        60 *
        60 *
        1000;


    adminSessions.set(
      token,
      {
        createdAt,
        expiresAt
      }
    );


    return res.json({

      ok: true,

      authenticated:
        true,

      token,

      expiresAt
    });
  }
);


/* ============================================================
   ADMIN LOGOUT
   ============================================================ */

app.post(
  "/api/admin/logout",
  (req, res) => {

    const token =
      authFromRequest(
        req
      );


    if (token) {

      adminSessions.delete(
        token
      );
    }


    return res.json({

      ok: true,

      loggedOut:
        true
    });
  }
);


/* ============================================================
   ADMIN DASHBOARD
   ============================================================ */

app.get(
  "/api/admin/dashboard",
  (req, res) => {

    if (
      !isAdmin(req)
    ) {

      return res.status(401).json({

        ok: false,

        error:
          "Não autorizado."
      });
    }


    const memory =
      process.memoryUsage();


    const memoriaMB =
      Number(
        (
          memory.rss /
          1024 /
          1024
        ).toFixed(2)
      );


    let totalUsuarios =
      usuarios.size;


    let totalVip =
      0;


    let totalPontos =
      0;


    for (
      const usuario
      of usuarios.values()
    ) {

      if (
        usuario.vip
      ) {

        totalVip++;
      }


      totalPontos +=
        safeNumber(
          usuario.points,
          0
        );
    }


    return res.json({

      ok: true,

      version:
        "13.0.1",

      metricas: {

        valorArrecadado:
          Number(
            metrics.revenue.toFixed(
              2
            )
          ),

        totalVendas:
          metrics.pixApproved,

        totalDownloads:
          metrics.downloads,

        totalAnalises:
          metrics.analyses,

        analisesGemini:
          metrics.geminiAnalyses,

        falhasGemini:
          metrics.failedAnalyses,

        totalUsuarios,

        totalVip,

        totalPontos,

        memoriaMB,

        uptime:
          Math.round(
            process.uptime()
          )
      },

      services: {

        gemini:
          Boolean(
            GEMINI_API_KEY
          ),

        geminiModel:
          GEMINI_MODEL,

        rapidapi:
          Boolean(
            RAPIDAPI_KEY
          ),

        mercadoPago:
          Boolean(
            MP_ACCESS_TOKEN
          ),

        authentication:
          Boolean(
            SESSION_SECRET
          ),

        ytDlp:
          fs.existsSync(
            YTDLP_PATH
          )
      }
    });
  }
);


/* ============================================================
   MERCADO PAGO - CRIAR PIX
   ============================================================ */

app.post(
  "/api/pix/criar",
  requireUser,
  async (
    req,
    res
  ) => {

    const usuario =
      req.usuario;


    if (
      !MP_ACCESS_TOKEN
    ) {

      return res.status(503).json({

        ok: false,

        error:
          "Mercado Pago não configurado."
      });
    }


    /*
     * O preço é SEMPRE definido pelo servidor.
     */

    const valor =
      VIP_PRICE;


    const plano =
      "VIP";


    const userId =
      usuario.userId;


    const externalReference =
      `clipforge-${userId}-${Date.now()}`;


    const emailRecebido =
      String(
        req.body?.email ||
        ""
      ).trim();


    const email =
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        emailRecebido
      )
        ? emailRecebido
        : `user-${userId}@clipforge.local`;


    try {

      const response =
        await fetch(
          "https://api.mercadopago.com/v1/payments",
          {

            method:
              "POST",

            headers: {

              "Authorization":
                `Bearer ${MP_ACCESS_TOKEN}`,

              "Content-Type":
                "application/json",

              "X-Idempotency-Key":
                crypto.randomUUID()
            },

            body:
              JSON.stringify({

                transaction_amount:
                  Number(
                    valor.toFixed(
                      2
                    )
                  ),

                description:
                  "ClipForge Pro VIP",

                payment_method_id:
                  "pix",

                external_reference:
                  externalReference,

                payer: {

                  email
                }
              })
          }
        );


      const data =
        await response.json();


      if (
        !response.ok
      ) {

        console.error(
          "[Mercado Pago]",
          JSON.stringify(
            data
          ).substring(
            0,
            3000
          )
        );


        return res.status(
          response.status
        ).json({

          ok: false,

          error:
            data?.message ||
            "Erro criando pagamento."
        });
      }


      const id =
        String(
          data.id ||
          ""
        );


      if (!id) {

        return res.status(502).json({

          ok: false,

          error:
            "Mercado Pago não retornou o ID do pagamento."
        });
      }


      const pix =
        data
          ?.point_of_interaction
          ?.transaction_data;


      pagamentos.set(
        id,
        {

          id,

          userId,

          plano,

          valor,

          status:
            data.status ||
            "pending",

          approved:
            false,

          counted:
            false,

          createdAt:
            Date.now(),

          externalReference
        }
      );


      metrics.pixCreated++;


      console.log(
        "[PIX] Criado:",
        id
      );


      console.log(
        "[PIX] Usuário:",
        userId
      );


      console.log(
        "[PIX] Valor:",
        valor
      );


      return res.json({

        ok: true,

        id,

        paymentId:
          id,

        status:
          data.status,

        valor,

        plano,

        externalReference,

        qr_code:
          pix?.qr_code ||
          null,

        qrCode:
          pix?.qr_code ||
          null,

        qr_code_base64:
          pix?.qr_code_base64 ||
          null,

        qrCodeBase64:
          pix?.qr_code_base64 ||
          null,

        ticket_url:
          pix?.ticket_url ||
          null,

        ticketUrl:
          pix?.ticket_url ||
          null
      });

    } catch (error) {

      console.error(
        "[PIX]",
        error.message
      );


      return res.status(500).json({

        ok: false,

        error:
          "Erro criando PIX.",

        details:
          error.message
      });
    }
  }
);


/* ============================================================
   PROCESSAR PAGAMENTO APROVADO
   ============================================================ */

function processarPagamentoAprovado(
  data
) {

  if (!data) {
    return null;
  }


  const paymentId =
    String(
      data.id ||
      ""
    );


  if (!paymentId) {
    return null;
  }


  const status =
    String(
      data.status ||
      ""
    );


  const approved =
    status ===
    "approved";


  let registro =
    pagamentos.get(
      paymentId
    );


  /*
   * Recuperação através da referência.
   */

  if (
    !registro &&
    data.external_reference
  ) {

    const externalReference =
      String(
        data.external_reference
      );


    const match =
      externalReference.match(
        /^clipforge-(.+)-(\d+)$/
      );


    if (
      match
    ) {

      registro = {

        id:
          paymentId,

        userId:
          match[1],

        plano:
          "VIP",

        valor:
          safeNumber(
            data.transaction_amount,
            VIP_PRICE
          ),

        status,

        approved:
          false,

        counted:
          false,

        createdAt:
          Date.now(),

        externalReference
      };


      pagamentos.set(
        paymentId,
        registro
      );
    }
  }


  if (!registro) {

    console.warn(
      "[PIX] Pagamento não associado a usuário:",
      paymentId
    );


    return null;
  }


  registro.status =
    status;


  registro.approved =
    approved;


  if (
    approved
  ) {

    const usuario =
      getOrCreateUser(
        registro.userId
      );


    if (
      !usuario.vip
    ) {

      usuario.vip =
        true;

      usuario.updatedAt =
        Date.now();


      console.log(
        "[VIP] Ativado:",
        usuario.userId
      );
    }


    if (
      !registro.counted
    ) {

      registro.counted =
        true;


      metrics.pixApproved++;


      metrics.revenue +=
        safeNumber(
          registro.valor,
          VIP_PRICE
        );
    }
  }


  return registro;
}


/* ============================================================
   MERCADO PAGO - STATUS
   ============================================================ */

app.get(
  "/api/pix/status/:id",
  requireUser,
  async (
    req,
    res
  ) => {

    const usuario =
      req.usuario;


    const paymentId =
      String(
        req.params.id ||
        ""
      ).trim();


    if (!paymentId) {

      return res.status(400).json({

        ok: false,

        error:
          "ID do pagamento inválido."
      });
    }


    if (
      !MP_ACCESS_TOKEN
    ) {

      return res.status(503).json({

        ok: false,

        error:
          "Mercado Pago não configurado."
      });
    }


    try {

      const response =
        await fetch(
          `https://api.mercadopago.com/v1/payments/${encodeURIComponent(
            paymentId
          )}`,
          {

            method:
              "GET",

            headers: {

              "Authorization":
                `Bearer ${MP_ACCESS_TOKEN}`
            },

            signal:
              AbortSignal.timeout(
                20000
              )
          }
        );


      const data =
        await response.json();


      if (
        !response.ok
      ) {

        return res.status(
          response.status
        ).json({

          ok: false,

          error:
            data?.message ||
            "Erro consultando pagamento."
        });
      }


      const externalReference =
        String(
          data.external_reference ||
          ""
        );


      /*
       * Primeiro verificamos o pagamento
       * já registrado em memória.
       */

      const existing =
        pagamentos.get(
          paymentId
        );


      if (
        existing &&
        existing.userId !==
          usuario.userId
      ) {

        return res.status(403).json({

          ok: false,

          error:
            "Este pagamento não pertence ao usuário atual."
        });
      }


      /*
       * Se ainda não está em memória,
       * verificamos a referência.
       */

      if (
        !existing &&
        externalReference
      ) {

        const match =
          externalReference.match(
            /^clipforge-(.+)-(\d+)$/
          );


        if (
          match &&
          match[1] !==
            usuario.userId
        ) {

          return res.status(403).json({

            ok: false,

            error:
              "Este pagamento não pertence ao usuário atual."
          });
        }
      }


      const registro =
        processarPagamentoAprovado(
          data
        );


      const status =
        String(
          data.status ||
          "pending"
        );


      const approved =
        status ===
        "approved";


      if (
        approved &&
        registro &&
        registro.userId ===
          usuario.userId
      ) {

        usuario.vip =
          true;

        usuario.updatedAt =
          Date.now();
      }


      const valor =
        safeNumber(
          registro?.valor ??
          data.transaction_amount,
          VIP_PRICE
        );


      return res.json({

        ok: true,

        id:
          paymentId,

        status,

        approved,

        plano:
          registro?.plano ||
          "VIP",

        valor,

        vip:
          Boolean(
            usuario.vip
          ),

        isVip:
          Boolean(
            usuario.vip
          ),

        pontos:
          usuario.points,

        points:
          usuario.points
      });

    } catch (error) {

      console.error(
        "[PIX STATUS]",
        error.message
      );


      return res.status(500).json({

        ok: false,

        error:
          "Erro consultando pagamento."
      });
    }
  }
);


/* ============================================================
   WEBHOOK MERCADO PAGO
   ============================================================ */

app.post(
  "/api/pix/webhook",
  async (
    req,
    res
  ) => {

    console.log(
      "[Webhook MP]",
      JSON.stringify(
        req.body
      ).substring(
        0,
        2000
      )
    );


    /*
     * Resposta rápida.
     */

    res.sendStatus(
      200
    );


    try {

      let paymentId =
        "";


      if (
        req.body?.data?.id
      ) {

        paymentId =
          String(
            req.body.data.id
          );
      }


      if (
        !paymentId &&
        req.query?.["data.id"]
      ) {

        paymentId =
          String(
            req.query[
              "data.id"
            ]
          );
      }


      if (
        !paymentId &&
        req.body?.id
      ) {

        paymentId =
          String(
            req.body.id
          );
      }


      if (
        !paymentId
      ) {

        console.log(
          "[Webhook MP] Nenhum payment ID."
        );

        return;
      }


      if (
        !MP_ACCESS_TOKEN
      ) {

        console.log(
          "[Webhook MP] MP_ACCESS_TOKEN não configurado."
        );

        return;
      }


      const response =
        await fetch(
          `https://api.mercadopago.com/v1/payments/${encodeURIComponent(
            paymentId
          )}`,
          {

            method:
              "GET",

            headers: {

              "Authorization":
                `Bearer ${MP_ACCESS_TOKEN}`
            },

            signal:
              AbortSignal.timeout(
                20000
              )
          }
        );


      const data =
        await response.json();


      if (
        !response.ok
      ) {

        console.error(
          "[Webhook MP] Erro:",
          JSON.stringify(
            data
          ).substring(
            0,
            3000
          )
        );

        return;
      }


      const registro =
        processarPagamentoAprovado(
          data
        );


      if (
        registro
      ) {

        console.log(
          "[Webhook MP] Processado:",
          paymentId,
          registro.status
        );
      }

    } catch (error) {

      console.error(
        "[Webhook MP] Erro:",
        error.message
      );
    }
  }
);


/* ============================================================
   LIMPEZA SESSÕES ADMIN
   ============================================================ */

setInterval(
  () => {

    const agora =
      Date.now();


    for (
      const [
        token,
        session
      ]
      of adminSessions
    ) {

      if (
        agora >
        session.expiresAt
      ) {

        adminSessions.delete(
          token
        );
      }
    }

  },
  60 * 60 * 1000
);


/* ============================================================
   LIMPEZA TEMPORÁRIA
   ============================================================ */

setInterval(
  () => {

    try {

      if (
        !fs.existsSync(
          TEMP_DIR
        )
      ) {

        return;
      }


      const files =
        fs.readdirSync(
          TEMP_DIR
        );


      const agora =
        Date.now();


      for (
        const file
        of files
      ) {

        const fullPath =
          path.join(
            TEMP_DIR,
            file
          );


        try {

          const stat =
            fs.statSync(
              fullPath
            );


          /*
           * Remove arquivos com mais de 30 minutos.
           */

          if (
            agora -
              stat.mtimeMs >
            30 * 60 * 1000
          ) {

            fs.unlinkSync(
              fullPath
            );


            console.log(
              "[Cleanup] Removido:",
              file
            );
          }

        } catch (_) {}
      }

    } catch (error) {

      console.error(
        "[Cleanup]",
        error.message
      );
    }

  },
  10 * 60 * 1000
);


/* ============================================================
   404
   ============================================================ */

app.use(
  (
    req,
    res
  ) => {

    res.status(404).json({

      ok: false,

      error:
        "Rota não encontrada.",

      path:
        req.originalUrl
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
      "[Global Error]",
      error
    );


    if (
      res.headersSent
    ) {

      return next(
        error
      );
    }


    res.status(500).json({

      ok: false,

      error:
        "Erro interno do servidor."
    });
  }
);


/* ============================================================
   START
   ============================================================ */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");

    console.log(
      "===================================================="
    );

    console.log(
      "       CLIPFORGE PRO BACKEND VERSION 13.0.1"
    );

    console.log(
      "===================================================="
    );

    console.log(
      `[ClipForge] Porta: ${PORT}`
    );

    console.log(
      `[Frontend] ${FRONTEND_URL}`
    );

    console.log(
      `[YT-API] ${
        RAPIDAPI_KEY
          ? "CONFIGURADA"
          : "NÃO CONFIGURADA"
      }`
    );

    console.log(
      `[Mercado Pago] ${
        MP_ACCESS_TOKEN
          ? "CONFIGURADO"
          : "NÃO CONFIGURADO"
      }`
    );

    console.log(
      `[Gemini] ${
        GEMINI_API_KEY
          ? "CONFIGURADO"
          : "NÃO CONFIGURADO"
      }`
    );

    console.log(
      `[Gemini] Modelo: ${GEMINI_MODEL}`
    );

    console.log(
      `[Admin] ${
        ADMIN_PASSWORD
          ? "CONFIGURADO"
          : "NÃO CONFIGURADO"
      }`
    );

    console.log(
      `[Sessão] ${
        SESSION_SECRET
          ? "CONFIGURADA"
          : "NÃO CONFIGURADA"
      }`
    );

    console.log(
      `[yt-dlp] ${
        fs.existsSync(
          YTDLP_PATH
        )
          ? `Encontrado em ${YTDLP_PATH}`
          : "NÃO ENCONTRADO"
      }`
    );

    console.log(
      `[Pontos] Inicial: ${INITIAL_POINTS}`
    );

    console.log(
      `[Pontos] Bônus diário: +${DAILY_BONUS}`
    );

    console.log(
      `[Pontos] Custo por corte: ${DOWNLOAD_COST}`
    );

    console.log(
      `[VIP] Preço: R$ ${VIP_PRICE.toFixed(2)}`
    );

    console.log(
      `[Timeout Download] ${DOWNLOAD_TIMEOUT}ms`
    );

    console.log(
      `[Timeout Gemini] ${GEMINI_TIMEOUT}ms`
    );

    console.log(
      "[Gemini] Análise direta de URLs públicas do YouTube ativa."
    );

    console.log(
      "[Download] RapidAPI A/V + yt-dlp + FFmpeg ativo."
    );

    console.log(
      "[Auth] Sessões HMAC de usuário ativadas."
    );

    console.log(
      "[PIX] Mercado Pago integrado."
    );

    console.log(
      "===================================================="
    );

    console.log("");
  }
);