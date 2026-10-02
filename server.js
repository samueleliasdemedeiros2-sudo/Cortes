/**
 * ============================================================
 * CLIPFORGE PRO - BACKEND 13.0.0
 * ============================================================
 *
 * PRINCIPAIS MELHORIAS:
 *
 * - Usuário identificado pelo servidor
 * - Pontos controlados pelo backend
 * - VIP controlado pelo backend
 * - Bônus diário validado pelo backend
 * - Download protegido por autenticação
 * - Download desconta pontos NO SERVIDOR
 * - Pix vinculado ao usuário autenticado
 * - Valor do VIP não é confiado ao frontend
 * - VIP só é liberado após confirmação no Mercado Pago
 * - Sessão de usuário assinada
 * - Sessão administrativa separada
 * - Senha do admin nunca é enviada ao frontend
 * - Rate limit básico
 * - Mantém /api/analisar
 * - Mantém Gemini
 * - Mantém YT-API
 * - Mantém yt-dlp
 * - Mantém FFmpeg
 * - Mantém Mercado Pago
 *
 * IMPORTANTE:
 * Este backend mantém usuários/pagamentos em memória.
 * No Render, reiniciar o serviço limpa esses dados.
 * Para produção definitiva, utilizar banco de dados.
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

const PORT = Number(process.env.PORT || 10000);

/* ============================================================
   CONFIGURAÇÃO
   ============================================================ */

const RAPIDAPI_KEY =
  process.env.RAPIDAPI_KEY || "";

const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST ||
  "yt-api.p.rapidapi.com";

const MP_ACCESS_TOKEN =
  process.env.MP_ACCESS_TOKEN || "";

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || "";

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "";

const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.8-flash";

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.randomBytes(32).toString("hex");

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
    120000
  );

const MAX_CLIPS =
  Number(
    process.env.MAX_CLIPS ||
    5
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

/* Plano */
const FREE_INITIAL_POINTS = 200;
const DAILY_BONUS_POINTS = 50;
const DOWNLOAD_COST = 50;

const VIP_PRICE = 19.90;
const VIP_PLAN = "VIP";

/*
 * VIP dura 30 dias.
 *
 * O pagamento atual é tratado como assinatura
 * mensal conforme o produto apresentado no frontend.
 */
const VIP_DURATION_MS =
  30 * 24 * 60 * 60 * 1000;


/* ============================================================
   APP
   ============================================================ */

const corsOrigin =
  process.env.CORS_ORIGIN || "*";

app.use(
  cors({
    origin: corsOrigin,
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
  })
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
    "[TEMP] Erro:",
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

  revenue: 0,

  bonusClaims: 0,

  usersCreated: 0,

  unauthorizedDownloads: 0,

  insufficientPoints: 0

};


/* ============================================================
   ARMAZENAMENTO EM MEMÓRIA
   ============================================================ */

const usuarios =
  new Map();

const pagamentos =
  new Map();

const sessoesAdmin =
  new Map();


/* ============================================================
   RATE LIMIT
   ============================================================ */

const rateBuckets =
  new Map();

function rateLimit(
  key,
  limit,
  windowMs
) {

  const agora =
    Date.now();

  const atual =
    rateBuckets.get(key);

  if (
    !atual ||
    agora - atual.start >= windowMs
  ) {

    rateBuckets.set(
      key,
      {
        start: agora,
        count: 1
      }
    );

    return true;
  }

  atual.count++;

  return atual.count <= limit;
}


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


function extractYouTubeId(
  input
) {

  if (!input) {
    return null;
  }

  const value =
    String(input)
      .trim();

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

    if (
      url.hostname.includes(
        "youtube.com"
      ) ||
      url.hostname.includes(
        "youtu.be"
      ) ||
      url.hostname.includes(
        "youtube-nocookie.com"
      )
    ) {

      if (
        url.hostname ===
        "youtu.be" ||
        url.hostname.endsWith(
          "youtu.be"
        )
      ) {

        const id =
          url.pathname
            .replace(/^\/+/, "")
            .split("/")[0];

        if (id) {

          return id.substring(
            0,
            11
          );

        }

      }

      const queryId =
        url.searchParams.get(
          "v"
        );

      if (queryId) {

        return queryId.substring(
          0,
          11
        );

      }

      const pathParts =
        url.pathname
          .split("/")
          .filter(Boolean);

      let possibleIndex = -1;

      if (
        pathParts.includes(
          "shorts"
        )
      ) {

        possibleIndex =
          pathParts.indexOf(
            "shorts"
          ) + 1;

      } else if (
        pathParts.includes(
          "embed"
        )
      ) {

        possibleIndex =
          pathParts.indexOf(
            "embed"
          ) + 1;

      } else if (
        pathParts.includes(
          "live"
        )
      ) {

        possibleIndex =
          pathParts.indexOf(
            "live"
          ) + 1;

      }

      if (
        possibleIndex >= 0 &&
        pathParts[possibleIndex]
      ) {

        return pathParts[
          possibleIndex
        ].substring(
          0,
          11
        );

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
   CRIPTOGRAFIA / SESSÕES
   ============================================================ */

function criarAssinatura(
  payload
) {

  return crypto
    .createHmac(
      "sha256",
      SESSION_SECRET
    )
    .update(payload)
    .digest("hex");

}


function criarTokenUsuario(
  userId
) {

  const payload =
    `${userId}.${Date.now()}`;

  const assinatura =
    criarAssinatura(
      payload
    );

  return Buffer
    .from(
      `${payload}.${assinatura}`
    )
    .toString(
      "base64url"
    );

}


function validarTokenUsuario(
  token
) {

  if (!token) {
    return null;
  }

  try {

    const decoded =
      Buffer
        .from(
          token,
          "base64url"
        )
        .toString();

    const partes =
      decoded.split(".");

    if (
      partes.length !== 3
    ) {

      return null;

    }

    const userId =
      partes[0];

    const timestamp =
      Number(partes[1]);

    const assinatura =
      partes[2];

    if (
      !userId ||
      !timestamp ||
      !assinatura
    ) {

      return null;

    }

    /*
     * Sessão válida por 90 dias.
     */
    if (
      Date.now() - timestamp >
      90 * 24 * 60 * 60 * 1000
    ) {

      return null;

    }

    const payload =
      `${userId}.${timestamp}`;

    const esperada =
      criarAssinatura(
        payload
      );

    if (
      assinatura.length !==
      esperada.length
    ) {

      return null;

    }

    if (
      !crypto.timingSafeEqual(
        Buffer.from(
          assinatura
        ),
        Buffer.from(
          esperada
        )
      )
    ) {

      return null;

    }

    return userId;

  } catch (_) {

    return null;

  }

}


function criarUsuario() {

  const userId =
    `cf_${crypto
      .randomBytes(16)
      .toString("hex")}`;

  const agora =
    Date.now();

  const usuario = {

    id: userId,

    pontos:
      FREE_INITIAL_POINTS,

    vip: false,

    vipExpiresAt: null,

    ultimoBonus: null,

    criadoEm: agora,

    ultimoAcesso: agora,

    downloads: 0,

    analyses: 0

  };

  usuarios.set(
    userId,
    usuario
  );

  metrics.usersCreated++;

  return usuario;

}


function obterUsuario(
  userId
) {

  const usuario =
    usuarios.get(
      userId
    );

  if (!usuario) {
    return null;
  }

  usuario.ultimoAcesso =
    Date.now();

  /*
   * VIP expirado.
   */
  if (
    usuario.vip &&
    usuario.vipExpiresAt &&
    Date.now() >
      usuario.vipExpiresAt
  ) {

    usuario.vip =
      false;

    usuario.vipExpiresAt =
      null;

  }

  return usuario;

}


function usuarioEhVip(
  usuario
) {

  if (!usuario) {
    return false;
  }

  if (!usuario.vip) {
    return false;
  }

  if (
    usuario.vipExpiresAt &&
    Date.now() >
      usuario.vipExpiresAt
  ) {

    usuario.vip =
      false;

    usuario.vipExpiresAt =
      null;

    return false;

  }

  return true;

}


function tokenUsuarioFromRequest(
  req
) {

  const auth =
    req.headers.authorization ||
    "";

  return auth
    .replace(
      /^Bearer\s+/i,
      ""
    )
    .trim();

}


function autenticarUsuario(
  req,
  res
) {

  const token =
    tokenUsuarioFromRequest(
      req
    );

  const userId =
    validarTokenUsuario(
      token
    );

  if (!userId) {

    return null;

  }

  const usuario =
    obterUsuario(
      userId
    );

  if (!usuario) {

    return null;

  }

  return usuario;

}


function exigirUsuario(
  req,
  res,
  next
) {

  const usuario =
    autenticarUsuario(
      req,
      res
    );

  if (!usuario) {

    return res.status(401).json({

      ok: false,

      error:
        "Sessão de usuário inválida ou expirada."

    });

  }

  req.usuario =
    usuario;

  next();

}


/* ============================================================
   ADMIN
   ============================================================ */

function criarSessaoAdmin() {

  const token =
    crypto.randomBytes(
      32
    ).toString(
      "hex"
    );

  sessoesAdmin.set(
    token,
    {
      criadoEm:
        Date.now()
    }
  );

  return token;

}


function isAdmin(
  req
) {

  const auth =
    req.headers.authorization ||
    "";

  const token =
    auth
      .replace(
        /^Bearer\s+/i,
        ""
      )
      .trim();

  if (!token) {
    return false;
  }

  const sessao =
    sessoesAdmin.get(
      token
    );

  if (!sessao) {
    return false;
  }

  /*
   * Sessão admin de 12 horas.
   */
  if (
    Date.now() -
      sessao.criadoEm >
    12 * 60 * 60 * 1000
  ) {

    sessoesAdmin.delete(
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
        "13.0.0",

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

      timestamp:
        new Date().toISOString()

    });

  }
);


app.get(
  "/api/status",
  (req, res) => {

    res.json({

      ok: true,

      version:
        "13.0.0",

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

        ytDlp:
          fs.existsSync(
            YTDLP_PATH
          )

      },

      metrics

    });

  }
);


/* ============================================================
   SESSÃO / USUÁRIO
   ============================================================ */

app.post(
  "/api/user/session",
  (req, res) => {

    const ip =
      req.ip ||
      req.socket.remoteAddress ||
      "unknown";

    if (
      !rateLimit(
        `session:${ip}`,
        20,
        60 * 60 * 1000
      )
    ) {

      return res.status(429).json({

        ok: false,

        error:
          "Muitas sessões criadas. Tente novamente mais tarde."

      });

    }

    const usuario =
      criarUsuario();

    const token =
      criarTokenUsuario(
        usuario.id
      );

    return res.json({

      ok: true,

      token,

      user: {

        id:
          usuario.id,

        pontos:
          usuario.pontos,

        vip:
          usuario.vip,

        vipExpiresAt:
          usuario.vipExpiresAt,

        ultimoBonus:
          usuario.ultimoBonus

      }

    });

  }
);


app.get(
  "/api/user/me",
  exigirUsuario,
  (req, res) => {

    const usuario =
      req.usuario;

    res.json({

      ok: true,

      user: {

        id:
          usuario.id,

        pontos:
          usuarioEhVip(
            usuario
          )
            ? null
            : usuario.pontos,

        vip:
          usuarioEhVip(
            usuario
          ),

        vipExpiresAt:
          usuario.vipExpiresAt,

        ultimoBonus:
          usuario.ultimoBonus,

        downloads:
          usuario.downloads,

        analyses:
          usuario.analyses

      }

    });

  }
);


/* ============================================================
   BÔNUS DIÁRIO
   ============================================================ */

function dataBrasilUTC(
  agora = new Date()
) {

  /*
   * A finalidade aqui é impedir múltiplos resgates
   * durante o mesmo dia lógico.
   *
   * Usa America/Sao_Paulo.
   */

  return new Intl.DateTimeFormat(
    "pt-BR",
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
    agora
  );

}


app.post(
  "/api/user/bonus",
  exigirUsuario,
  (req, res) => {

    const usuario =
      req.usuario;

    if (
      usuarioEhVip(
        usuario
      )
    ) {

      return res.json({

        ok: true,

        claimed: false,

        message:
          "Usuários VIP não precisam de bônus de pontos.",

        user: {

          pontos:
            null,

          vip:
            true

        }

      });

    }

    const hoje =
      dataBrasilUTC();

    if (
      usuario.ultimoBonus ===
      hoje
    ) {

      return res.status(409).json({

        ok: false,

        claimed: false,

        error:
          "O bônus de hoje já foi resgatado.",

        user: {

          pontos:
            usuario.pontos,

          vip:
            false,

          ultimoBonus:
            usuario.ultimoBonus

        }

      });

    }

    usuario.pontos +=
      DAILY_BONUS_POINTS;

    usuario.ultimoBonus =
      hoje;

    metrics.bonusClaims++;

    return res.json({

      ok: true,

      claimed: true,

      added:
        DAILY_BONUS_POINTS,

      user: {

        pontos:
          usuario.pontos,

        vip:
          false,

        ultimoBonus:
          usuario.ultimoBonus

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
      safeNumber(
        quantity,
        3
      ),
      1,
      MAX_CLIPS
    );

  const duracaoAlvo =
    clamp(
      safeNumber(
        targetDuration,
        DEFAULT_CLIP_DURATION
      ),
      MIN_CLIP_DURATION,
      MAX_CLIP_DURATION
    );

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
Você é o motor de seleção de cortes do ClipForge Pro.

Analise cuidadosamente o vídeo inteiro, incluindo:

- imagem
- áudio
- falas
- mudanças de cena
- momentos de surpresa
- humor
- emoção
- conflitos
- revelações
- frases fortes
- perguntas e respostas
- momentos que prendem atenção
- momentos com potencial para Shorts/Reels/TikTok

OBJETIVO:

Encontrar ${quantidade} dos melhores momentos do vídeo
para transformar em Shorts verticais.

Cada corte deve ter aproximadamente
${duracaoAlvo} segundos.

IMPORTANTE:

1. Retorne timestamps em segundos.
2. "start" deve ser o começo do corte.
3. "end" deve ser o final do corte.
4. Evite começar no meio de uma frase.
5. Evite terminar no meio de uma frase.
6. Prefira cortes que tenham começo, desenvolvimento e conclusão.
7. Evite longos períodos de silêncio.
8. Evite trechos sem contexto.
9. Dê prioridade a momentos que funcionem isoladamente.
10. Não invente acontecimentos.
11. O score deve ser de 0 a 100.
12. Ordene os cortes do maior potencial para o menor.
13. Não ultrapasse ${MAX_CLIPS} cortes.
14. Não use timestamps negativos.
15. Não use timestamps fora do vídeo.

A resposta deve conter SOMENTE o JSON solicitado.
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
    "[Gemini] Enviando vídeo do YouTube para análise..."
  );

  console.log(
    "[Gemini] Modelo:",
    GEMINI_MODEL
  );

  console.log(
    "[Gemini] Vídeo:",
    videoId
  );


  const response =
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
          )

      }
    );


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
        3000
      )
    );

    throw new Error(
      `Gemini HTTP ${response.status}: ${
        data?.error?.message ||
        rawText.substring(
          0,
          500
        )
      }`
    );

  }


  let outputText =
    data.output_text ||
    data.outputText ||
    "";


  if (
    !outputText &&
    Array.isArray(
      data.steps
    )
  ) {

    const textParts =
      [];

    for (
      const step of data.steps
    ) {

      if (
        step &&
        Array.isArray(
          step.content
        )
      ) {

        for (
          const content of
          step.content
        ) {

          if (
            content &&
            typeof content.text ===
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
      "[Gemini] Não encontrou output_text."
    );

    console.error(
      JSON.stringify(
        data
      ).substring(
        0,
        5000
      )
    );

    throw new Error(
      "Gemini não retornou o JSON dos cortes."
    );

  }


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

    } catch (_) {

      console.error(
        "[Gemini] JSON inválido:",
        outputText.substring(
          0,
          3000
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
        (clip, index) => {

          const start =
            Math.max(
              0,
              safeNumber(
                clip.start,
                0
              )
            );

          const end =
            Math.max(
              start +
                MIN_CLIP_DURATION,

              safeNumber(
                clip.end,
                start +
                  duracaoAlvo
              )
            );

          const duration =
            end -
            start;

          return {

            id:
              index + 1,

            inicio:
              Math.round(
                start
              ),

            fim:
              Math.round(
                end
              ),

            duracao:
              Math.round(
                duration
              ),

            titulo:
              String(
                clip.title ||
                `Melhor momento #${index + 1}`
              ).substring(
                0,
                150
              ),

            motivo:
              String(
                clip.reason ||
                "Momento identificado pela IA."
              ).substring(
                0,
                500
              ),

            score:
              clamp(
                Math.round(
                  safeNumber(
                    clip.score,
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
        clip => {

          if (
            clip.duracao <
            MIN_CLIP_DURATION
          ) {

            return false;

          }

          if (
            clip.duracao >
            MAX_CLIP_DURATION +
              15
          ) {

            return false;

          }

          return true;

        }
      )
      .slice(
        0,
        quantidade
      );


  if (!clips.length) {

    throw new Error(
      "A IA não encontrou cortes válidos."
    );

  }


  console.log(
    `[Gemini] ${clips.length} cortes encontrados.`
  );


  metrics.geminiAnalyses++;

  return clips;

}


/* ============================================================
   FALLBACK
   ============================================================ */

function gerarFallbackClips() {

  return [

    {
      id:
        1,

      inicio:
        35,

      fim:
        90,

      duracao:
        55,

      titulo:
        "Melhor momento",

      motivo:
        "Corte de fallback.",

      score:
        90,

      ai:
        false

    },

    {
      id:
        2,

      inicio:
        145,

      fim:
        200,

      duracao:
        55,

      titulo:
        "Momento interessante",

      motivo:
        "Corte de fallback.",

      score:
        85,

      ai:
        false

    },

    {
      id:
        3,

      inicio:
        290,

      fim:
        345,

      duracao:
        55,

      titulo:
        "Momento de destaque",

      motivo:
        "Corte de fallback.",

      score:
        80,

      ai:
        false

    }

  ];

}


/* ============================================================
   ANALISAR
   ============================================================ */

app.post(
  "/api/analisar",
  exigirUsuario,
  async (req, res) => {

    const usuario =
      req.usuario;

    const youtubeUrl =
      String(
        req.body.youtubeUrl ||
        req.body.url ||
        ""
      ).trim();

    const requestedVideoId =
      String(
        req.body.videoId ||
        ""
      ).trim();

    const quantity =
      safeNumber(
        req.body.quantity,
        3
      );

    const duration =
      safeNumber(
        req.body.duration,
        DEFAULT_CLIP_DURATION
      );


    if (
      !rateLimit(
        `analysis:${usuario.id}`,
        10,
        10 * 60 * 1000
      )
    ) {

      return res.status(429).json({

        ok: false,

        error:
          "Muitas análises em pouco tempo. Aguarde alguns minutos."

      });

    }


    console.log("");

    console.log(
      "[Análise] =================================="
    );

    console.log(
      "[Análise] Usuário:",
      usuario.id
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


    metrics.analyses++;

    usuario.analyses++;


    if (
      GEMINI_API_KEY
    ) {

      try {

        const clips =
          await analisarComGemini({

            youtubeUrl:
              finalYoutubeUrl,

            videoId,

            quantity,

            targetDuration:
              duration

          });


        return res.json({

          ok:
            true,

          success:
            true,

          ai:
            true,

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


        return res.status(
          502
        ).json({

          ok:
            false,

          success:
            false,

          ai:
            false,

          videoId,

          error:
            "A IA não conseguiu analisar este vídeo.",

          details:
            error.message,

          hint:
            "Verifique se o vídeo é público e se a GEMINI_API_KEY está válida."

        });

      }

    }


    console.warn(
      "[Análise] GEMINI_API_KEY não configurada."
    );


    const clips =
      gerarFallbackClips();


    return res.json({

      ok:
        true,

      success:
        true,

      ai:
        false,

      modelo:
        null,

      videoId,

      youtubeUrl:
        finalYoutubeUrl,

      clips,

      quantidade:
        clips.length,

      message:
        "Gemini não configurado. Foram usados cortes de fallback."

    });

  }
);


/* ============================================================
   RAPIDAPI
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
    "[YT-API] Consultando",
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
        const item of
        value
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

      streams.push({

        url:
          urlCandidate,

        mime:
          value.mime ||
          value.mimeType ||
          value.type ||
          "",

        quality:
          value.quality ||
          value.qualityLabel ||
          value.resolution ||
          "",

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

        audio:
          Boolean(
            value.audio ||
            value.hasAudio
          )

      });

    }


    for (
      const key of
      Object.keys(
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
    const stream of
    streams
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
    "[YT-API] URLs encontradas:",
    unique.length
  );


  return unique;

}


/* ============================================================
   TESTE STREAM
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

function ffprobeDuration(
  filePath
) {

  return new Promise(
    resolve => {

      const process =
        spawn(
          "ffprobe",
          [

            "-v",
            "error",

            "-show_entries",
            "format=duration",

            "-of",
            "default=noprint_wrappers=1:nokey=1",

            filePath

          ]
        );


      let output =
        "";


      process.stdout.on(
        "data",
        data => {

          output +=
            data.toString();

        }
      );


      process.on(
        "close",
        () => {

          const value =
            Number(
              output.trim()
            );

          resolve(
            Number.isFinite(
              value
            )
              ? value
              : null
          );

        }
      );


      process.on(
        "error",
        () => {

          resolve(
            null
          );

        }
      );

    }
  );

}


/* ============================================================
   DOWNLOAD STREAM
   ============================================================ */

async function baixarStreamParaArquivo(
  streamUrl,
  outputPath
) {

  return new Promise(
    async (
      resolve,
      reject
    ) => {

      try {

        const response =
          await fetch(
            streamUrl,
            {

              method:
                "GET",

              headers: {

                "User-Agent":
                  "Mozilla/5.0"

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

          reject(
            new Error(
              `Stream HTTP ${response.status}`
            )
          );

          return;

        }


        if (
          !response.body
        ) {

          reject(
            new Error(
              "Stream sem body."
            )
          );

          return;

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

              if (
                !fileStream.write(
                  Buffer.from(
                    value
                  )
                )
              ) {

                await new Promise(
                  resolveDrain => {

                    fileStream.once(
                      "drain",
                      resolveDrain
                    );

                  }
                );

              }

            }

          }


          fileStream.end();


          fileStream.on(
            "finish",
            () =>
              resolve(
                outputPath
              )
          );


          fileStream.on(
            "error",
            reject
          );


        } catch (error) {

          fileStream.destroy();

          reject(
            error
          );

        }

      } catch (error) {

        reject(
          error
        );

      }

    }
  );

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
        -2000
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


  return outputPath;

}


/* ============================================================
   FFMPEG
   ============================================================ */

async function cortarVideo(
  inputPath,
  outputPath,
  start,
  duration
) {

  const safeStart =
    Math.max(
      0,
      Math.floor(
        safeNumber(
          start,
          0
        )
      )
    );


  const safeDuration =
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


  console.log(
    `[FFmpeg] Corte ${safeStart}s / ${safeDuration}s`
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
    "0:v:0?",

    "-map",
    "0:a:0?",

    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-crf",
    "23",

    "-c:a",
    "aac",

    "-b:a",
    "128k",

    "-movflags",
    "+faststart",

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
      "FFmpeg não gerou o arquivo."
    );

  }


  return outputPath;

}


/* ============================================================
   DOWNLOAD
   ============================================================ */

app.get(
  "/api/download",
  exigirUsuario,
  async (req, res) => {

    const usuario =
      req.usuario;


    const videoId =
      extractYouTubeId(
        req.query.id ||
        req.query.url ||
        ""
      );


    const start =
      Math.max(
        0,
        safeNumber(
          req.query.start,
          0
        )
      );


    const duration =
      clamp(
        safeNumber(
          req.query.duration,
          DEFAULT_CLIP_DURATION
        ),
        MIN_CLIP_DURATION,
        MAX_CLIP_DURATION
      );


    if (!videoId) {

      return res.status(
        400
      ).json({

        ok:
          false,

        error:
          "ID ou URL do YouTube inválido."

      });

    }


    /*
     * ========================================================
     * AUTORIZAÇÃO FINANCEIRA
     * ========================================================
     */

    const vip =
      usuarioEhVip(
        usuario
      );


    if (
      !vip &&
      usuario.pontos <
        DOWNLOAD_COST
    ) {

      metrics.insufficientPoints++;

      return res.status(
        402
      ).json({

        ok:
          false,

        error:
          "Pontos insuficientes.",

        code:
          "INSUFFICIENT_POINTS",

        required:
          DOWNLOAD_COST,

        points:
          usuario.pontos,

        vip:
          false

      });

    }


    /*
     * Se não for VIP, reservamos os pontos
     * ANTES do processamento.
     *
     * Se o download falhar, devolvemos os pontos.
     */

    let pontosCobrados =
      false;


    if (!vip) {

      usuario.pontos -=
        DOWNLOAD_COST;

      pontosCobrados =
        true;

    }


    const jobId =
      crypto
        .randomBytes(
          8
        )
        .toString(
          "hex"
        );


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
      "[Download] NOVO DOWNLOAD 13.0.0"
    );

    console.log(
      "[Download] Usuário:",
      usuario.id
    );

    console.log(
      "[Download] VIP:",
      vip
    );

    console.log(
      "[Download] Pontos:",
      usuario.pontos
    );

    console.log(
      "[Download] ID:",
      videoId
    );

    console.log(
      "[Download] Início:",
      start,
      "s"
    );

    console.log(
      "[Download] Duração:",
      duration,
      "s"
    );


    try {

      let sourceDownloaded =
        false;


      /*
       * ======================================================
       * 1. RAPIDAPI
       * ======================================================
       */

      if (
        RAPIDAPI_KEY
      ) {

        try {

          console.log(
            "[Download] Consultando YT-API..."
          );


          const streams =
            await consultarYTAPI(
              videoId
            );


          const candidates =
            streams
              .sort(
                (a, b) =>
                  (b.height || 0) -
                  (a.height || 0)
              )
              .slice(
                0,
                12
              );


          for (
            const stream of
            candidates
          ) {

            if (
              !stream.url
            ) {

              continue;

            }


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

              await baixarStreamParaArquivo(
                stream.url,
                originalPath
              );


              sourceDownloaded =
                fs.existsSync(
                  originalPath
                );


              if (
                sourceDownloaded
              ) {

                break;

              }

            } catch (error) {

              console.log(
                "[Download] Falha stream:",
                error.message
              );


              try {

                fs.unlinkSync(
                  originalPath
                );

              } catch (_) {}

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
       * ======================================================
       * 2. YT-DLP
       * ======================================================
       */

      if (
        !sourceDownloaded
      ) {

        console.log(
          "[Download] Ativando fallback yt-dlp..."
        );


        try {

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

        }

      }


      /*
       * ======================================================
       * 3. FALHA DE FONTE
       * ======================================================
       */

      if (
        !sourceDownloaded
      ) {

        throw new Error(
          "Não foi possível obter uma fonte de vídeo acessível para gerar o MP4."
        );

      }


      /*
       * ======================================================
       * 4. FFmpeg
       * ======================================================
       */

      await cortarVideo(
        originalPath,
        clipPath,
        start,
        duration
      );


      metrics.downloads++;

      usuario.downloads++;


      const filename =
        `clipforge-short-${videoId}-${start}s.mp4`;


      res.setHeader(
        "Content-Type",
        "video/mp4"
      );


      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );


      res.setHeader(
        "Cache-Control",
        "no-store"
      );


      const stream =
        fs.createReadStream(
          clipPath
        );


      stream.on(
        "error",
        error => {

          console.error(
            "[Download] Erro enviando:",
            error.message
          );

        }
      );


      stream.on(
        "close",
        () => {

          setTimeout(
            () => {

              try {

                fs.unlinkSync(
                  clipPath
                );

              } catch (_) {}


              try {

                fs.unlinkSync(
                  originalPath
                );

              } catch (_) {}

            },
            3000
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
       * Reembolso automático caso os pontos tenham
       * sido cobrados e o processamento tenha falhado.
       */

      if (
        pontosCobrados
      ) {

        usuario.pontos +=
          DOWNLOAD_COST;

        console.log(
          `[Download] ${DOWNLOAD_COST} pontos devolvidos.`
        );

      }


      try {

        fs.unlinkSync(
          originalPath
        );

      } catch (_) {}


      try {

        fs.unlinkSync(
          clipPath
        );

      } catch (_) {}


      if (
        !res.headersSent
      ) {

        return res.status(
          502
        ).json({

          ok:
            false,

          error:
            "Erro ao gerar o corte.",

          details:
            error.message,

          points:
            usuarioEhVip(
              usuario
            )
              ? null
              : usuario.pontos

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

    const ip =
      req.ip ||
      req.socket.remoteAddress ||
      "unknown";


    if (
      !rateLimit(
        `admin:${ip}`,
        10,
        15 * 60 * 1000
      )
    ) {

      return res.status(
        429
      ).json({

        ok:
          false,

        error:
          "Muitas tentativas de login."

      });

    }


    const password =
      String(
        req.body.password ||
        ""
      );


    if (
      !ADMIN_PASSWORD
    ) {

      return res.status(
        503
      ).json({

        ok:
          false,

        error:
          "ADMIN_PASSWORD não configurada."

      });

    }


    if (
      password !==
      ADMIN_PASSWORD
    ) {

      return res.status(
        401
      ).json({

        ok:
          false,

        error:
          "Senha administrativa inválida."

      });

    }


    const token =
      criarSessaoAdmin();


    return res.json({

      ok:
        true,

      authenticated:
        true,

      token

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
      !isAdmin(
        req
      )
    ) {

      return res.status(
        401
      ).json({

        ok:
          false,

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
        ).toFixed(
          2
        )
      );


    return res.json({

      ok:
        true,

      version:
        "13.0.0",

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

        usuarios:
          usuarios.size,

        bonusResgatados:
          metrics.bonusClaims,

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
          )

      }

    });

  }
);


/* ============================================================
   PIX - CRIAR
   ============================================================ */

app.post(
  "/api/pix/criar",
  exigirUsuario,
  async (req, res) => {

    const usuario =
      req.usuario;


    if (
      usuarioEhVip(
        usuario
      )
    ) {

      return res.status(
        409
      ).json({

        ok:
          false,

        error:
          "Este usuário já possui VIP ativo.",

        vip:
          true,

        vipExpiresAt:
          usuario.vipExpiresAt

      });

    }


    if (
      !MP_ACCESS_TOKEN
    ) {

      return res.status(
        503
      ).json({

        ok:
          false,

        error:
          "Mercado Pago não configurado."

      });

    }


    /*
     * NÃO confiamos em valor enviado pelo frontend.
     */

    const valor =
      VIP_PRICE;


    const plano =
      VIP_PLAN;


    const externalReference =
      `clipforge-${usuario.id}-${Date.now()}`;


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
                  valor,

                description:
                  "ClipForge Pro VIP - 30 dias",

                payment_method_id:
                  "pix",

                external_reference:
                  externalReference,

                payer: {

                  email:
                    `clipforge-${usuario.id}@users.invalid`

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
          )
        );


        return res.status(
          response.status
        ).json({

          ok:
            false,

          error:
            data?.message ||
            "Erro criando pagamento."

        });

      }


      const id =
        String(
          data.id
        );


      const pix =
        data
          .point_of_interaction
          ?.transaction_data;


      pagamentos.set(
        id,
        {

          id,

          userId:
            usuario.id,

          plano,

          valor,

          status:
            data.status ||
            "pending",

          createdAt:
            Date.now(),

          approved:
            false,

          counted:
            false

        }
      );


      metrics.pixCreated++;


      /*
       * Retornamos tanto snake_case quanto camelCase
       * para manter compatibilidade com versões antigas
       * do frontend.
       */

      return res.json({

        ok:
          true,

        id,

        paymentId:
          id,

        status:
          data.status,

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
          null,

        externalReference,

        valor,

        plano

      });

    } catch (error) {

      console.error(
        "[PIX]",
        error.message
      );


      return res.status(
        500
      ).json({

        ok:
          false,

        error:
          "Erro criando PIX.",

        details:
          error.message

      });

    }

  }
);


/* ============================================================
   PIX - STATUS
   ============================================================ */

app.get(
  "/api/pix/status/:id",
  exigirUsuario,
  async (req, res) => {

    const usuario =
      req.usuario;


    const paymentId =
      String(
        req.params.id
      );


    if (
      !MP_ACCESS_TOKEN
    ) {

      return res.status(
        503
      ).json({

        ok:
          false,

        error:
          "Mercado Pago não configurado."

      });

    }


    const registro =
      pagamentos.get(
        paymentId
      );


    /*
     * Impede um usuário de consultar o pagamento
     * pertencente a outro usuário.
     */

    if (
      !registro ||
      registro.userId !==
        usuario.id
    ) {

      return res.status(
        403
      ).json({

        ok:
          false,

        error:
          "Pagamento não pertence a este usuário."

      });

    }


    try {

      const response =
        await fetch(
          `https://api.mercadopago.com/v1/payments/${encodeURIComponent(
            paymentId
          )}`,
          {

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

          ok:
            false,

          error:
            data?.message ||
            "Erro consultando pagamento."

        });

      }


      const status =
        data.status ||
        "pending";


      const approved =
        status ===
        "approved";


      registro.status =
        status;

      registro.approved =
        approved;


      /*
       * O VIP é liberado SOMENTE aqui,
       * no backend, depois da confirmação
       * real do Mercado Pago.
       */

      if (
        approved &&
        !registro.counted
      ) {

        registro.counted =
          true;

        metrics.pixApproved++;

        metrics.revenue +=
          safeNumber(
            registro.valor,
            0
          );


        usuario.vip =
          true;

        usuario.vipExpiresAt =
          Date.now() +
          VIP_DURATION_MS;


        console.log(
          `[VIP] Ativado para ${usuario.id}`
        );

      }


      return res.json({

        ok:
          true,

        id:
          paymentId,

        status,

        approved,

        vip:
          usuarioEhVip(
            usuario
          ),

        vipExpiresAt:
          usuario.vipExpiresAt,

        pontos:
          usuarioEhVip(
            usuario
          )
            ? null
            : usuario.pontos,

        plano:
          registro.plano,

        valor:
          registro.valor

      });

    } catch (error) {

      console.error(
        "[PIX STATUS]",
        error.message
      );


      return res.status(
        500
      ).json({

        ok:
          false,

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
  async (req, res) => {

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
     * Respondemos rapidamente.
     *
     * A confirmação oficial continua sendo feita
     * consultando o pagamento diretamente na API
     * do Mercado Pago.
     */

    return res.sendStatus(
      200
    );

  }
);


/* ============================================================
   404
   ============================================================ */

app.use(
  (req, res) => {

    res.status(
      404
    ).json({

      ok:
        false,

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


    res.status(
      500
    ).json({

      ok:
        false,

      error:
        "Erro interno do servidor."

    });

  }
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
        const file of
        files
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
   LIMPEZA DE SESSÕES ADMIN
   ============================================================ */

setInterval(
  () => {

    const agora =
      Date.now();

    for (
      const [
        token,
        sessao
      ] of
      sessoesAdmin.entries()
    ) {

      if (
        agora -
          sessao.criadoEm >
        12 * 60 * 60 * 1000
      ) {

        sessoesAdmin.delete(
          token
        );

      }

    }

  },
  60 * 60 * 1000
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
      "      CLIPFORGE PRO BACKEND VERSION 13.0.0"
    );

    console.log(
      "===================================================="
    );

    console.log(
      `[ClipForge] Porta: ${PORT}`
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
      `[yt-dlp] ${
        fs.existsSync(
          YTDLP_PATH
        )
          ? `Encontrado em ${YTDLP_PATH}`
          : "NÃO ENCONTRADO"
      }`
    );

    console.log(
      "[Auth] Sessões de usuário ativadas."
    );

    console.log(
      "[Pontos] Controle pelo servidor ativado."
    );

    console.log(
      "[VIP] Controle pelo servidor ativado."
    );

    console.log(
      "[Download] Cobrança de pontos no backend ativada."
    );

    console.log(
      "[Gemini] Análise direta de URLs públicas do YouTube ativa."
    );

    console.log(
      "[Download] YT-API + FFmpeg + yt-dlp fallback ativo."
    );

    console.log(
      "===================================================="
    );

    console.log("");

  }
);