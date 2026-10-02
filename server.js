/**
 * ============================================================
 * CLIPFORGE PRO
 * Backend 13.0.6
 * ============================================================
 *
 * Node.js + Express
 *
 * Principais recursos:
 * - Gemini Interactions API
 * - Gemini 3.8 Flash
 * - Análise direta de URLs públicas do YouTube
 * - Saída estruturada JSON
 * - Download externo opcional
 * - RapidAPI
 * - yt-dlp fallback
 * - FFmpeg
 * - Sessões em memória
 * - Sistema de usuários
 * - Pontos/análises
 * - Mercado Pago / Pix
 * - Webhook Mercado Pago
 * - Área administrativa
 * - Métricas
 * - CORS
 *
 * ============================================================
 */

"use strict";

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

/* ============================================================
   CONFIGURAÇÃO
   ============================================================ */

const APP_VERSION = "13.0.6";

const app = express();

const PORT = Number(process.env.PORT || 10000);

const HOST = process.env.HOST || "0.0.0.0";

const NODE_ENV = process.env.NODE_ENV || "production";

/* ============================================================
   GEMINI
   ============================================================ */

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  "";

const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.8-flash";

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

/* ============================================================
   RAPIDAPI
   ============================================================ */

const RAPIDAPI_KEY =
  process.env.RAPIDAPI_KEY ||
  process.env.X_RAPIDAPI_KEY ||
  "";

const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST ||
  "youtube-media-downloader.p.rapidapi.com";

/* ============================================================
   DOWNLOAD EXTERNO
   ============================================================ */

const EXTERNAL_DOWNLOAD_URL =
  process.env.EXTERNAL_DOWNLOAD_URL ||
  "";

/* ============================================================
   YT-DLP / FFMPEG
   ============================================================ */

const YTDLP_PATH =
  process.env.YTDLP_PATH ||
  path.join(process.cwd(), "bin", "yt-dlp");

const FFMPEG_PATH =
  process.env.FFMPEG_PATH ||
  "ffmpeg";

const FFPROBE_PATH =
  process.env.FFPROBE_PATH ||
  "ffprobe";

const YTDLP_COOKIES_FILE =
  process.env.YTDLP_COOKIES_FILE ||
  "";

/* ============================================================
   MERCADO PAGO
   ============================================================ */

const MP_ACCESS_TOKEN =
  process.env.MP_ACCESS_TOKEN ||
  process.env.MERCADOPAGO_ACCESS_TOKEN ||
  "";

const MP_WEBHOOK_SECRET =
  process.env.MP_WEBHOOK_SECRET ||
  "";

/* ============================================================
   ADMIN
   ============================================================ */

const ADMIN_USER =
  process.env.ADMIN_USER ||
  "admin";

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ||
  "";

/* ============================================================
   FRONTEND / CORS
   ============================================================ */

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  "";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://clipforge.netlify.app",
  "https://clipforge-pro.netlify.app",
  "https://clipforgepro.netlify.app",
];

const ALLOWED_ORIGINS = [
  ...new Set(
    [
      ...DEFAULT_ALLOWED_ORIGINS,
      FRONTEND_URL,
      ...(process.env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ].filter(Boolean)
  ),
];

/* ============================================================
   DIRETÓRIOS
   ============================================================ */

const TEMP_ROOT = path.join(
  os.tmpdir(),
  "clipforge-pro"
);

const DOWNLOAD_DIR = path.join(
  TEMP_ROOT,
  "downloads"
);

const OUTPUT_DIR = path.join(
  TEMP_ROOT,
  "outputs"
);

/* ============================================================
   ESTADO EM MEMÓRIA
   ============================================================ */

const users = new Map();
const sessions = new Map();
const adminSessions = new Map();
const payments = new Map();

/* ============================================================
   MÉTRICAS
   ============================================================ */

const metrics = {
  startedAt: new Date().toISOString(),

  requests: 0,
  analyses: 0,
  analysisSuccess: 0,
  analysisFailures: 0,

  geminiRequests: 0,
  geminiSuccess: 0,
  geminiFailures: 0,

  downloads: 0,
  downloadSuccess: 0,
  downloadFailures: 0,

  externalDownloadAttempts: 0,
  rapidApiAttempts: 0,
  ytdlpAttempts: 0,

  pixCreated: 0,
  pixApproved: 0,
  pixRejected: 0,

  errors: 0,
};

/* ============================================================
   UTILITÁRIOS
   ============================================================ */

function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomId(prefix = "") {
  return (
    prefix +
    crypto.randomBytes(12).toString("hex")
  );
}

function safeString(value, fallback = "") {
  if (
    value === undefined ||
    value === null
  ) {
    return fallback;
  }

  return String(value);
}

function clampNumber(
  value,
  min,
  max,
  fallback
) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return Math.min(
    max,
    Math.max(min, n)
  );
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "http:" ||
      url.protocol === "https:"
    );
  } catch {
    return false;
  }
}

/* ============================================================
   YOUTUBE
   ============================================================ */

function extractYouTubeVideoId(input) {
  if (!input) {
    return null;
  }

  const value = String(input).trim();

  /*
   * ID puro
   */
  if (
    /^[a-zA-Z0-9_-]{11}$/.test(value)
  ) {
    return value;
  }

  let url;

  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const host =
    url.hostname.toLowerCase();

  /*
   * youtube.com/watch?v=
   */
  if (
    host === "youtube.com" ||
    host === "www.youtube.com" ||
    host === "m.youtube.com"
  ) {
    const id = url.searchParams.get("v");

    if (
      id &&
      /^[a-zA-Z0-9_-]{11}$/.test(id)
    ) {
      return id;
    }

    /*
     * /shorts/ID
     */
    const shortsMatch =
      url.pathname.match(
        /\/shorts\/([a-zA-Z0-9_-]{11})/
      );

    if (shortsMatch) {
      return shortsMatch[1];
    }

    /*
     * /embed/ID
     */
    const embedMatch =
      url.pathname.match(
        /\/embed\/([a-zA-Z0-9_-]{11})/
      );

    if (embedMatch) {
      return embedMatch[1];
    }

    /*
     * /live/ID
     */
    const liveMatch =
      url.pathname.match(
        /\/live\/([a-zA-Z0-9_-]{11})/
      );

    if (liveMatch) {
      return liveMatch[1];
    }
  }

  /*
   * youtu.be/ID
   */
  if (
    host === "youtu.be" ||
    host === "www.youtu.be"
  ) {
    const id =
      url.pathname
        .replace(/^\/+/, "")
        .split("/")[0];

    if (
      /^[a-zA-Z0-9_-]{11}$/.test(id)
    ) {
      return id;
    }
  }

  return null;
}

function normalizeYouTubeUrl(input) {
  const videoId =
    extractYouTubeVideoId(input);

  if (!videoId) {
    return null;
  }

  return {
    videoId,
    url:
      `https://www.youtube.com/watch?v=${videoId}`,
  };
}

/* ============================================================
   DIRETÓRIOS
   ============================================================ */

async function ensureDirectories() {
  await fsp.mkdir(
    DOWNLOAD_DIR,
    {
      recursive: true,
    }
  );

  await fsp.mkdir(
    OUTPUT_DIR,
    {
      recursive: true,
    }
  );
}

/* ============================================================
   LIMPEZA
   ============================================================ */

async function safeRemove(file) {
  if (!file) {
    return;
  }

  try {
    await fsp.rm(file, {
      recursive: true,
      force: true,
    });
  } catch {}
}

async function cleanupOldFiles() {
  const dirs = [
    DOWNLOAD_DIR,
    OUTPUT_DIR,
  ];

  const cutoff =
    Date.now() -
    60 * 60 * 1000;

  for (const dir of dirs) {
    try {
      const entries =
        await fsp.readdir(
          dir,
          {
            withFileTypes: true,
          }
        );

      for (const entry of entries) {
        const fullPath =
          path.join(
            dir,
            entry.name
          );

        try {
          const stat =
            await fsp.stat(
              fullPath
            );

          if (
            stat.mtimeMs <
            cutoff
          ) {
            await safeRemove(
              fullPath
            );
          }
        } catch {}
      }
    } catch {}
  }
}

/* ============================================================
   USUÁRIOS
   ============================================================ */

function getOrCreateUser(userId) {
  const id =
    userId ||
    randomId("user_");

  let user =
    users.get(id);

  if (!user) {
    user = {
      id,
      createdAt:
        new Date().toISOString(),

      analyses: 0,
      downloads: 0,

      points: 10,

      vip: false,

      lastAnalysisAt: null,
      lastDownloadAt: null,
    };

    users.set(id, user);
  }

  return user;
}

/* ============================================================
   SESSÕES
   ============================================================ */

function createSession(userId) {
  const token =
    randomId("sess_");

  sessions.set(
    token,
    {
      userId,
      createdAt: now(),
      expiresAt:
        now() +
        30 *
          24 *
          60 *
          60 *
          1000,
    }
  );

  return token;
}

function getSessionUser(req) {
  const auth =
    req.headers.authorization ||
    "";

  if (
    !auth.startsWith("Bearer ")
  ) {
    return null;
  }

  const token =
    auth.slice(7).trim();

  if (!token) {
    return null;
  }

  const session =
    sessions.get(token);

  if (!session) {
    return null;
  }

  if (
    session.expiresAt <
    now()
  ) {
    sessions.delete(token);
    return null;
  }

  return getOrCreateUser(
    session.userId
  );
}

/* ============================================================
   MIDDLEWARE DE USUÁRIO
   ============================================================ */

function requireUser(req, res, next) {
  const user =
    getSessionUser(req);

  if (!user) {
    return res.status(401).json({
      ok: false,
      error:
        "Sessão inválida ou expirada.",
      code:
        "UNAUTHORIZED",
    });
  }

  req.user = user;

  next();
}

/*
 * Compatibilidade:
 * algumas versões do frontend podem
 * enviar apenas userId.
 */
function resolveRequestUser(req) {
  const sessionUser =
    getSessionUser(req);

  if (sessionUser) {
    return sessionUser;
  }

  const headerUser =
    req.headers["x-user-id"];

  const bodyUser =
    req.body &&
    (
      req.body.userId ||
      req.body.user_id
    );

  const userId =
    headerUser ||
    bodyUser;

  if (userId) {
    return getOrCreateUser(
      safeString(userId)
    );
  }

  return null;
}

/* ============================================================
   ADMIN
   ============================================================ */

function createAdminSession() {
  const token =
    randomId("admin_");

  adminSessions.set(
    token,
    {
      createdAt: now(),
      expiresAt:
        now() +
        12 *
          60 *
          60 *
          1000,
    }
  );

  return token;
}

function requireAdmin(req, res, next) {
  const auth =
    req.headers.authorization ||
    "";

  if (
    !auth.startsWith("Bearer ")
  ) {
    return res.status(401).json({
      ok: false,
      error:
        "Autenticação administrativa necessária.",
    });
  }

  const token =
    auth.slice(7).trim();

  const session =
    adminSessions.get(token);

  if (!session) {
    return res.status(401).json({
      ok: false,
      error:
        "Sessão administrativa inválida.",
    });
  }

  if (
    session.expiresAt <
    now()
  ) {
    adminSessions.delete(token);

    return res.status(401).json({
      ok: false,
      error:
        "Sessão administrativa expirada.",
    });
  }

  req.admin = true;

  next();
}

/* ============================================================
   CORS
   ============================================================ */

const corsOptions = {
  origin(origin, callback) {
    /*
     * Permite ferramentas sem Origin,
     * curl, health checks etc.
     */
    if (!origin) {
      return callback(null, true);
    }

    /*
     * Desenvolvimento
     */
    if (
      NODE_ENV !== "production" &&
      (
        origin.startsWith(
          "http://localhost:"
        ) ||
        origin.startsWith(
          "http://127.0.0.1:"
        )
      )
    ) {
      return callback(null, true);
    }

    if (
      ALLOWED_ORIGINS.includes(
        origin
      )
    ) {
      return callback(
        null,
        true
      );
    }

    /*
     * Netlify
     */
    if (
      origin.endsWith(
        ".netlify.app"
      )
    ) {
      return callback(
        null,
        true
      );
    }

    /*
     * Em produção rejeita origem
     * desconhecida.
     */
    return callback(
      new Error(
        "Origem não permitida pelo CORS."
      )
    );
  },

  methods: [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-User-Id",
    "X-Requested-With",
  ],

  credentials: true,

  maxAge: 86400,
};

/* ============================================================
   MIDDLEWARE
   ============================================================ */

app.disable("x-powered-by");

app.use(
  cors(corsOptions)
);

/*
 * Express 5:
 * regex em vez de app.options("*")
 */
app.options(
  /.*/,
  cors(corsOptions)
);

app.use(
  express.json({
    limit: "2mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "2mb",
  })
);

app.use(
  (req, res, next) => {
    metrics.requests++;

    res.setHeader(
      "X-ClipForge-Version",
      APP_VERSION
    );

    next();
  }
);

/* ============================================================
   GEMINI SCHEMA
   ============================================================ */

const geminiSchema = {
  type: "object",

  properties: {
    title: {
      type: "string",
      description:
        "Título curto do vídeo.",
    },

    summary: {
      type: "string",
      description:
        "Resumo breve do conteúdo.",
    },

    clips: {
      type: "array",

      items: {
        type: "object",

        properties: {
          start: {
            type: "number",
          },

          end: {
            type: "number",
          },

          title: {
            type: "string",
          },

          description: {
            type: "string",
          },

          score: {
            type: "number",
          },

          reason: {
            type: "string",
          },
        },

        required: [
          "start",
          "end",
          "title",
          "description",
          "score",
          "reason",
        ],
      },
    },
  },

  required: [
    "title",
    "summary",
    "clips",
  ],
};

/* ============================================================
   PROMPT GEMINI
   ============================================================ */

function buildGeminiPrompt({
  videoId,
  maxClips = 8,
  minDuration = 20,
  maxDuration = 90,
}) {
  return `
Você é o sistema de análise de vídeos do ClipForge Pro.

Analise o vídeo do YouTube fornecido junto desta mensagem.

Identifique os melhores momentos para criar cortes curtos,
com foco em trechos que tenham potencial de retenção,
viralização e interesse do público.

Procure principalmente:

- frases fortes;
- momentos engraçados;
- histórias interessantes;
- opiniões relevantes;
- revelações;
- conflitos;
- perguntas e respostas;
- momentos emocionais;
- ensinamentos;
- momentos surpreendentes;
- trechos que funcionem isoladamente.

REGRAS:

1. Retorne somente JSON compatível com o schema.
2. Não invente acontecimentos.
3. Não crie timestamps aleatórios.
4. Os timestamps devem estar dentro do vídeo.
5. Cada corte deve ter entre ${minDuration} e ${maxDuration} segundos sempre que possível.
6. Evite cortes excessivamente parecidos.
7. Evite sobreposição entre cortes.
8. Priorize começo e fim naturais.
9. Gere no máximo ${maxClips} cortes.
10. score deve ser um número entre 0 e 100.
11. title deve ser curto e chamativo.
12. description deve explicar o conteúdo do corte.
13. reason deve explicar por que o momento é interessante.
14. Se não houver bons momentos, retorne clips como array vazio.

ID do vídeo:
${videoId}

O resultado deve conter:

{
  "title": "título",
  "summary": "resumo",
  "clips": [
    {
      "start": 0,
      "end": 60,
      "title": "Título do corte",
      "description": "Descrição",
      "score": 95,
      "reason": "Motivo"
    }
  ]
}
`.trim();
}

/* ============================================================
   EXTRAÇÃO DA RESPOSTA GEMINI
   ============================================================ */

function extractGeminiOutputText(data) {
  if (!data) {
    return "";
  }

  /*
   * Forma atual conveniente
   */
  if (
    typeof data.output_text ===
      "string" &&
    data.output_text.trim()
  ) {
    return data.output_text.trim();
  }

  /*
   * Algumas respostas podem usar
   * camelCase.
   */
  if (
    typeof data.outputText ===
      "string" &&
    data.outputText.trim()
  ) {
    return data.outputText.trim();
  }

  /*
   * steps é a estrutura atual
   * documentada da Interactions API.
   */
  if (
    Array.isArray(data.steps)
  ) {
    const texts = [];

    for (
      const step of data.steps
    ) {
      if (!step) continue;

      if (
        typeof step.text ===
        "string"
      ) {
        texts.push(step.text);
      }

      if (
        Array.isArray(
          step.content
        )
      ) {
        for (
          const item of step.content
        ) {
          if (
            item &&
            typeof item.text ===
              "string"
          ) {
            texts.push(
              item.text
            );
          }
        }
      }
    }

    if (texts.length) {
      return texts.join("\n").trim();
    }
  }

  /*
   * outputs
   */
  if (
    Array.isArray(data.outputs)
  ) {
    const texts = [];

    for (
      const output of data.outputs
    ) {
      if (!output) continue;

      if (
        typeof output.text ===
        "string"
      ) {
        texts.push(
          output.text
        );
      }

      if (
        Array.isArray(
          output.content
        )
      ) {
        for (
          const item of output.content
        ) {
          if (
            item &&
            typeof item.text ===
              "string"
          ) {
            texts.push(
              item.text
            );
          }
        }
      }
    }

    if (texts.length) {
      return texts.join("\n").trim();
    }
  }

  /*
   * candidates - compatibilidade
   */
  if (
    Array.isArray(
      data.candidates
    )
  ) {
    const texts = [];

    for (
      const candidate of data.candidates
    ) {
      const parts =
        candidate &&
        candidate.content &&
        Array.isArray(
          candidate.content.parts
        )
          ? candidate.content.parts
          : [];

      for (
        const part of parts
      ) {
        if (
          part &&
          typeof part.text ===
            "string"
        ) {
          texts.push(
            part.text
          );
        }
      }
    }

    if (texts.length) {
      return texts.join("\n").trim();
    }
  }

  return "";
}

/* ============================================================
   JSON
   ============================================================ */

function extractJsonFromText(text) {
  if (!text) {
    return null;
  }

  let value =
    String(text).trim();

  /*
   * Remove fences markdown.
   */
  value =
    value
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

  /*
   * JSON direto
   */
  try {
    return JSON.parse(value);
  } catch {}

  /*
   * Procurar objeto.
   */
  const first =
    value.indexOf("{");

  const last =
    value.lastIndexOf("}");

  if (
    first !== -1 &&
    last !== -1 &&
    last > first
  ) {
    try {
      return JSON.parse(
        value.slice(
          first,
          last + 1
        )
      );
    } catch {}
  }

  return null;
}

/* ============================================================
   NORMALIZAÇÃO DOS CLIPES
   ============================================================ */

function normalizarClips(
  clips,
  options = {}
) {
  if (!Array.isArray(clips)) {
    return [];
  }

  const minDuration =
    Number(
      options.minDuration ||
        20
    );

  const maxDuration =
    Number(
      options.maxDuration ||
        90
    );

  const maxClips =
    Number(
      options.maxClips ||
        8
    );

  const normalized =
    [];

  for (
    const clip of clips
  ) {
    if (!clip) {
      continue;
    }

    let start =
      Number(
        clip.start ??
          clip.startTime ??
          clip.inicio ??
          clip.begin
      );

    let end =
      Number(
        clip.end ??
          clip.endTime ??
          clip.fim ??
          clip.finish
      );

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end)
    ) {
      continue;
    }

    start =
      Math.max(
        0,
        start
      );

    end =
      Math.max(
        start,
        end
      );

    /*
     * Se o modelo retornar duração
     * curta demais, tenta preservar
     * o início e ajustar o final.
     */
    let duration =
      end - start;

    if (
      duration <
      minDuration
    ) {
      end =
        start +
        minDuration;

      duration =
        end - start;
    }

    /*
     * Limita duração máxima.
     */
    if (
      duration >
      maxDuration
    ) {
      end =
        start +
        maxDuration;
    }

    duration =
      end - start;

    if (
      duration <
      minDuration
    ) {
      continue;
    }

    const score =
      clampNumber(
        clip.score ??
          clip.rating ??
          clip.potential,
        0,
        100,
        70
      );

    normalized.push({
      start:
        Number(
          start.toFixed(2)
        ),

      end:
        Number(
          end.toFixed(2)
        ),

      duration:
        Number(
          duration.toFixed(2)
        ),

      title:
        safeString(
          clip.title ||
            clip.name ||
            "Corte recomendado"
        ).slice(
          0,
          140
        ),

      description:
        safeString(
          clip.description ||
            clip.summary ||
            ""
        ).slice(
          0,
          500
        ),

      score:
        Number(
          score.toFixed(1)
        ),

      reason:
        safeString(
          clip.reason ||
            clip.explanation ||
            ""
        ).slice(
          0,
          500
        ),
    });
  }

  /*
   * Score maior primeiro.
   */
  normalized.sort(
    (a, b) =>
      b.score - a.score
  );

  /*
   * Remove sobreposição.
   */
  const result = [];

  for (
    const clip of normalized
  ) {
    const overlap =
      result.some(
        (existing) => {
          const overlapStart =
            Math.max(
              existing.start,
              clip.start
            );

          const overlapEnd =
            Math.min(
              existing.end,
              clip.end
            );

          return (
            overlapEnd >
            overlapStart
          );
        }
      );

    if (overlap) {
      continue;
    }

    result.push(clip);

    if (
      result.length >=
      maxClips
    ) {
      break;
    }
  }

  /*
   * Ordem cronológica para o frontend.
   */
  result.sort(
    (a, b) =>
      a.start - b.start
  );

  return result;
}

/* ============================================================
   GEMINI
   ============================================================ */

async function analisarComGemini({
  youtubeUrl,
  videoId,
  maxClips,
  minDuration,
  maxDuration,
}) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY não configurada."
    );
  }

  metrics.geminiRequests++;

  const prompt =
    buildGeminiPrompt({
      videoId,
      maxClips,
      minDuration,
      maxDuration,
    });

  /*
   * Interactions API atual:
   * - modelo Gemini 3.8 Flash
   * - vídeo por URL pública do YouTube
   * - resposta JSON estruturada
   */
  const body = {
    model: GEMINI_MODEL,

    input: [
      {
        type: "text",
        text: prompt,
      },

      {
        type: "video",
        uri: youtubeUrl,
      },
    ],

    response_format: {
      type: "text",
      mime_type:
        "application/json",

      schema:
        geminiSchema,
    },
  };

  console.log(
    `[Gemini] Modelo: ${GEMINI_MODEL}`
  );

  console.log(
    "[Gemini] Endpoint: Interactions API"
  );

  console.log(
    "[Gemini] Enviando URL pública do YouTube para análise..."
  );

  let response;

  try {
    response =
      await fetch(
        GEMINI_ENDPOINT,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            "x-goog-api-key":
              GEMINI_API_KEY,
          },

          body:
            JSON.stringify(body),

          signal:
            AbortSignal.timeout(
              180000
            ),
        }
      );
  } catch (error) {
    metrics.geminiFailures++;

    throw new Error(
      `Falha de conexão com Gemini: ${error.message}`
    );
  }

  const rawText =
    await response.text();

  let data = null;

  try {
    data =
      rawText
        ? JSON.parse(rawText)
        : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    metrics.geminiFailures++;

    const message =
      data &&
      data.error &&
      data.error.message
        ? data.error.message
        : rawText;

    throw new Error(
      `Gemini HTTP ${response.status}: ${message}`
    );
  }

  const outputText =
    extractGeminiOutputText(
      data
    );

  if (!outputText) {
    metrics.geminiFailures++;

    throw new Error(
      "Gemini não retornou texto de saída."
    );
  }

  const parsed =
    extractJsonFromText(
      outputText
    );

  if (!parsed) {
    metrics.geminiFailures++;

    console.error(
      "[Gemini] Resposta não é JSON válido:",
      outputText.slice(
        0,
        2000
      )
    );

    throw new Error(
      "Gemini retornou uma resposta que não pôde ser convertida em JSON."
    );
  }

  const clips =
    normalizarClips(
      parsed.clips,
      {
        maxClips,
        minDuration,
        maxDuration,
      }
    );

  metrics.geminiSuccess++;

  return {
    title:
      safeString(
        parsed.title ||
          "Vídeo analisado"
      ),

    summary:
      safeString(
        parsed.summary ||
          ""
      ),

    clips,
  };
}

/* ============================================================
   PROCESSAMENTO DE COMANDOS
   ============================================================ */

function runCommand(
  command,
  args,
  options = {}
) {
  return new Promise(
    (resolve, reject) => {
      const child =
        spawn(
          command,
          args,
          {
            cwd:
              options.cwd ||
              process.cwd(),

            env: {
              ...process.env,
              ...(options.env ||
                {}),
            },

            windowsHide:
              true,
          }
        );

      let stdout = "";
      let stderr = "";

      child.stdout.on(
        "data",
        (chunk) => {
          stdout +=
            chunk.toString();
        }
      );

      child.stderr.on(
        "data",
        (chunk) => {
          stderr +=
            chunk.toString();
        }
      );

      const timeout =
        setTimeout(
          () => {
            try {
              child.kill(
                "SIGKILL"
              );
            } catch {}

            reject(
              new Error(
                "Processo excedeu o tempo limite."
              )
            );
          },
          options.timeout ||
            300000
        );

      child.on(
        "error",
        (error) => {
          clearTimeout(
            timeout
          );

          reject(error);
        }
      );

      child.on(
        "close",
        (code) => {
          clearTimeout(
            timeout
          );

          resolve({
            code,
            stdout,
            stderr,
          });
        }
      );
    }
  );
}

/* ============================================================
   DOWNLOAD EXTERNO
   ============================================================ */

async function downloadWithExternalService({
  youtubeUrl,
  videoId,
  outputPath,
}) {
  if (
    !EXTERNAL_DOWNLOAD_URL
  ) {
    throw new Error(
      "Downloader externo não configurado."
    );
  }

  metrics.externalDownloadAttempts++;

  console.log(
    "[Download] Tentando downloader externo..."
  );

  const payload = {
    url: youtubeUrl,
    videoId,
    output: "mp4",
  };

  let response;

  try {
    response =
      await fetch(
        EXTERNAL_DOWNLOAD_URL,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            Accept:
              "application/json, video/mp4, video/*",
          },

          body:
            JSON.stringify(
              payload
            ),

          signal:
            AbortSignal.timeout(
              180000
            ),
        }
      );
  } catch (error) {
    throw new Error(
      `Downloader externo indisponível: ${error.message}`
    );
  }

  if (!response.ok) {
    const text =
      await response
        .text()
        .catch(
          () => ""
        );

    throw new Error(
      `Downloader externo HTTP ${response.status}: ${text.slice(
        0,
        500
      )}`
    );
  }

  const contentType =
    (
      response.headers.get(
        "content-type"
      ) || ""
    ).toLowerCase();

  /*
   * Resposta binária direta.
   */
  if (
    contentType.includes(
      "video/"
    ) ||
    contentType.includes(
      "application/octet-stream"
    )
  ) {
    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    if (!buffer.length) {
      throw new Error(
        "Downloader externo retornou arquivo vazio."
      );
    }

    await fsp.writeFile(
      outputPath,
      buffer
    );

    return outputPath;
  }

  /*
   * Resposta JSON com URL.
   */
  const data =
    await response.json();

  const downloadUrl =
    data.url ||
    data.downloadUrl ||
    data.download_url ||
    data.videoUrl ||
    data.video_url ||
    data.result?.url ||
    data.data?.url;

  if (!downloadUrl) {
    throw new Error(
      "Downloader externo não retornou uma URL de vídeo."
    );
  }

  const videoResponse =
    await fetch(
      downloadUrl,
      {
        signal:
          AbortSignal.timeout(
            180000
          ),
      }
    );

  if (!videoResponse.ok) {
    throw new Error(
      `Falha ao baixar arquivo do downloader externo: HTTP ${videoResponse.status}`
    );
  }

  const buffer =
    Buffer.from(
      await videoResponse.arrayBuffer()
    );

  if (!buffer.length) {
    throw new Error(
      "Arquivo retornado pelo downloader externo está vazio."
    );
  }

  await fsp.writeFile(
    outputPath,
    buffer
  );

  return outputPath;
}

/* ============================================================
   RAPIDAPI
   ============================================================ */

async function fetchRapidApiData(
  videoId
) {
  if (
    !RAPIDAPI_KEY
  ) {
    throw new Error(
      "RapidAPI não configurado."
    );
  }

  metrics.rapidApiAttempts++;

  const endpoint =
    `https://${RAPIDAPI_HOST}/dl?id=${encodeURIComponent(
      videoId
    )}&cgeo=BR`;

  const response =
    await fetch(
      endpoint,
      {
        method: "GET",

        headers: {
          "x-rapidapi-key":
            RAPIDAPI_KEY,

          "x-rapidapi-host":
            RAPIDAPI_HOST,

          Accept:
            "application/json",
        },

        signal:
          AbortSignal.timeout(
            60000
          ),
      }
    );

  const text =
    await response.text();

  let data = null;

  try {
    data =
      text
        ? JSON.parse(text)
        : null;
  } catch {}

  if (!response.ok) {
    throw new Error(
      `RapidAPI HTTP ${response.status}: ${text.slice(
        0,
        500
      )}`
    );
  }

  return data;
}

/* ============================================================
   EXTRAÇÃO DE STREAMS
   ============================================================ */

function collectUrls(
  value,
  result = [],
  depth = 0
) {
  if (
    depth >
    8
  ) {
    return result;
  }

  if (
    value === null ||
    value === undefined
  ) {
    return result;
  }

  if (
    typeof value ===
    "string"
  ) {
    if (
      /^https?:\/\//i.test(
        value
      )
    ) {
      result.push({
        url: value,
      });
    }

    return result;
  }

  if (
    Array.isArray(value)
  ) {
    for (
      const item of value
    ) {
      collectUrls(
        item,
        result,
        depth + 1
      );
    }

    return result;
  }

  if (
    typeof value ===
    "object"
  ) {
    const candidateUrl =
      value.url ||
      value.href ||
      value.downloadUrl ||
      value.download_url ||
      value.videoUrl ||
      value.video_url;

    if (
      typeof candidateUrl ===
        "string" &&
      /^https?:\/\//i.test(
        candidateUrl
      )
    ) {
      result.push({
        url:
          candidateUrl,

        quality:
          value.quality ||
          value.qualityLabel ||
          value.resolution ||
          value.label ||
          "",

        height:
          Number(
            value.height ||
              value.videoHeight ||
              0
          ),

        width:
          Number(
            value.width ||
              value.videoWidth ||
              0
          ),

        hasAudio:
          Boolean(
            value.hasAudio ??
              value.audio ??
              value.audioUrl
          ),

        mime:
          value.mimeType ||
          value.mime ||
          "",
      });
    }

    for (
      const key of Object.keys(
        value
      )
    ) {
      collectUrls(
        value[key],
        result,
        depth + 1
      );
    }
  }

  return result;
}

function deduplicateStreams(
  streams
) {
  const map =
    new Map();

  for (
    const stream of streams
  ) {
    if (
      !stream ||
      !stream.url
    ) {
      continue;
    }

    if (
      !map.has(
        stream.url
      )
    ) {
      map.set(
        stream.url,
        stream
      );
    }
  }

  return Array.from(
    map.values()
  );
}

/* ============================================================
   DOWNLOAD DE STREAM
   ============================================================ */

async function downloadStream(
  url,
  outputPath
) {
  const response =
    await fetch(
      url,
      {
        method: "GET",

        signal:
          AbortSignal.timeout(
            120000
          ),
      }
    );

  if (!response.ok) {
    throw new Error(
      `Stream HTTP ${response.status}`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  if (!buffer.length) {
    throw new Error(
      "Stream retornou arquivo vazio."
    );
  }

  await fsp.writeFile(
    outputPath,
    buffer
  );

  return outputPath;
}

/* ============================================================
   RAPIDAPI DOWNLOAD
   ============================================================ */

async function downloadWithRapidApi({
  videoId,
  outputPath,
}) {
  const data =
    await fetchRapidApiData(
      videoId
    );

  let streams =
    collectUrls(data);

  streams =
    deduplicateStreams(
      streams
    );

  /*
   * Preferir maior resolução.
   */
  streams.sort(
    (a, b) => {
      const ah =
        Number(
          a.height || 0
        );

      const bh =
        Number(
          b.height || 0
        );

      return bh - ah;
    }
  );

  console.log(
    `[YT-API] Streams encontradas: ${streams.length}`
  );

  /*
   * Limita tentativas para
   * não ficar preso em dezenas
   * de URLs expiradas.
   */
  const candidates =
    streams.slice(
      0,
      8
    );

  let lastError =
    null;

  for (
    const stream of candidates
  ) {
    try {
      console.log(
        `[Download] Testando stream: ${
          stream.quality ||
          stream.height ||
          "unknown"
        }`
      );

      await downloadStream(
        stream.url,
        outputPath
      );

      return outputPath;
    } catch (error) {
      lastError =
        error;

      console.log(
        `[Download] Stream falhou: ${error.message}`
      );

      await safeRemove(
        outputPath
      );
    }
  }

  throw (
    lastError ||
    new Error(
      "Nenhuma stream RapidAPI pôde ser baixada."
    )
  );
}

/* ============================================================
   YT-DLP
   ============================================================ */

function detectYtDlpError(
  stderr
) {
  const text =
    safeString(
      stderr
    ).toLowerCase();

  if (
    text.includes(
      "sign in to confirm"
    ) ||
    text.includes(
      "not a bot"
    ) ||
    text.includes(
      "login_required"
    ) ||
    text.includes(
      "use --cookies-from-browser"
    )
  ) {
    return (
      "O YouTube bloqueou o IP deste servidor com proteção anti-bot. " +
      "O yt-dlp não conseguiu acessar o vídeo."
    );
  }

  if (
    text.includes(
      "http error 403"
    )
  ) {
    return (
      "O YouTube retornou HTTP 403 ao yt-dlp."
    );
  }

  return null;
}

async function downloadWithYtDlp({
  youtubeUrl,
  outputPath,
}) {
  metrics.ytdlpAttempts++;

  console.log(
    `[YT-DLP] Executável: ${YTDLP_PATH}`
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

    youtubeUrl,
  ];

  if (
    YTDLP_COOKIES_FILE
  ) {
    args.splice(
      1,
      0,
      "--cookies",
      YTDLP_COOKIES_FILE
    );
  }

  let result;

  try {
    result =
      await runCommand(
        YTDLP_PATH,
        args,
        {
          timeout:
            300000,
        }
      );
  } catch (error) {
    throw new Error(
      `Falha ao executar yt-dlp: ${error.message}`
    );
  }

  if (
    result.code !== 0
  ) {
    const antiBot =
      detectYtDlpError(
        result.stderr
      );

    if (antiBot) {
      throw new Error(
        antiBot
      );
    }

    throw new Error(
      `yt-dlp terminou com código ${result.code}. ${result.stderr.slice(
        -2000
      )}`
    );
  }

  try {
    await fsp.access(
      outputPath
    );
  } catch {
    throw new Error(
      "yt-dlp terminou sem gerar o arquivo MP4."
    );
  }

  const stat =
    await fsp.stat(
      outputPath
    );

  if (
    stat.size <
    10000
  ) {
    throw new Error(
      "yt-dlp gerou um arquivo inválido ou vazio."
    );
  }

  return outputPath;
}

/* ============================================================
   FFPROBE
   ============================================================ */

async function probeVideo(
  inputPath
) {
  const result =
    await runCommand(
      FFPROBE_PATH,
      [
        "-v",
        "error",

        "-show_entries",
        "format=duration",

        "-of",
        "default=noprint_wrappers=1:nokey=1",

        inputPath,
      ],
      {
        timeout:
          60000,
      }
    );

  if (
    result.code !== 0
  ) {
    return {
      duration: null,
    };
  }

  const duration =
    Number(
      result.stdout.trim()
    );

  return {
    duration:
      Number.isFinite(
        duration
      )
        ? duration
        : null,
  };
}

/* ============================================================
   FFMPEG
   ============================================================ */

async function renderClip({
  inputPath,
  outputPath,
  start,
  duration,
}) {
  const safeStart =
    Math.max(
      0,
      Number(start) || 0
    );

  const safeDuration =
    Math.max(
      1,
      Number(duration) || 1
    );

  const result =
    await runCommand(
      FFMPEG_PATH,
      [
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

        "-movflags",
        "+faststart",

        outputPath,
      ],
      {
        timeout:
          300000,
      }
    );

  if (
    result.code !== 0
  ) {
    throw new Error(
      `FFmpeg falhou: ${result.stderr.slice(
        -2500
      )}`
    );
  }

  try {
    const stat =
      await fsp.stat(
        outputPath
      );

    if (
      stat.size <
      10000
    ) {
      throw new Error(
        "FFmpeg gerou arquivo inválido."
      );
    }
  } catch (error) {
    if (
      error.code ===
      "ENOENT"
    ) {
      throw new Error(
        "FFmpeg não gerou o MP4."
      );
    }

    throw error;
  }

  return outputPath;
}

/* ============================================================
   DOWNLOAD PRINCIPAL
   ============================================================ */

async function downloadOriginalVideo({
  youtubeUrl,
  videoId,
}) {
  const base =
    `${videoId}-${Date.now()}`;

  const outputPath =
    path.join(
      DOWNLOAD_DIR,
      `${base}.mp4`
    );

  /*
   * 1. Downloader externo
   */
  if (
    EXTERNAL_DOWNLOAD_URL
  ) {
    try {
      await downloadWithExternalService(
        {
          youtubeUrl,
          videoId,
          outputPath,
        }
      );

      return {
        path: outputPath,
        method:
          "external",
      };
    } catch (error) {
      console.log(
        `[Download] Downloader externo falhou: ${error.message}`
      );

      await safeRemove(
        outputPath
      );
    }
  }

  /*
   * 2. RapidAPI
   */
  if (
    RAPIDAPI_KEY
  ) {
    try {
      await downloadWithRapidApi(
        {
          videoId,
          outputPath,
        }
      );

      return {
        path: outputPath,
        method:
          "rapidapi",
      };
    } catch (error) {
      console.log(
        `[Download] RapidAPI falhou: ${error.message}`
      );

      await safeRemove(
        outputPath
      );
    }
  }

  /*
   * 3. yt-dlp
   */
  try {
    await downloadWithYtDlp(
      {
        youtubeUrl,
        outputPath,
      }
    );

    return {
      path: outputPath,
      method:
        "yt-dlp",
    };
  } catch (error) {
    await safeRemove(
      outputPath
    );

    throw new Error(
      `Todos os métodos de download falharam. ${error.message}`
    );
  }
}

/* ============================================================
   MERCADO PAGO
   ============================================================ */

async function mpRequest(
  endpoint,
  options = {}
) {
  if (!MP_ACCESS_TOKEN) {
    throw new Error(
      "MP_ACCESS_TOKEN não configurado."
    );
  }

  const response =
    await fetch(
      `https://api.mercadopago.com${endpoint}`,
      {
        ...options,

        headers: {
          Authorization:
            `Bearer ${MP_ACCESS_TOKEN}`,

          "Content-Type":
            "application/json",

          ...(options.headers ||
            {}),
        },

        signal:
          AbortSignal.timeout(
            60000
          ),
      }
    );

  const text =
    await response.text();

  let data = null;

  try {
    data =
      text
        ? JSON.parse(text)
        : null;
  } catch {
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    throw new Error(
      `Mercado Pago HTTP ${response.status}: ${text.slice(
        0,
        1000
      )}`
    );
  }

  return data;
}

/* ============================================================
   CRIAÇÃO DE PIX
   ============================================================ */

async function createPixPayment({
  user,
  amount,
  description,
}) {
  const transactionAmount =
    Number(amount);

  if (
    !Number.isFinite(
      transactionAmount
    ) ||
    transactionAmount <= 0
  ) {
    throw new Error(
      "Valor inválido."
    );
  }

  const externalReference =
    `clipforge-${user.id}-${randomId()}`;

  const idempotencyKey =
    randomId("mp_");

  const body = {
    transaction_amount:
      Number(
        transactionAmount.toFixed(
          2
        )
      ),

    description:
      description ||
      "ClipForge Pro VIP",

    payment_method_id:
      "pix",

    external_reference:
      externalReference,

    payer: {
      email:
        `user-${user.id}@clipforge.local`,
    },
  };

  const data =
    await mpRequest(
      "/v1/payments",
      {
        method: "POST",

        headers: {
          "X-Idempotency-Key":
            idempotencyKey,
        },

        body:
          JSON.stringify(
            body
          ),
      }
    );

  const paymentId =
    String(
      data.id
    );

  const transactionData =
    data.point_of_interaction &&
    data.point_of_interaction
      .transaction_data
      ? data.point_of_interaction
          .transaction_data
      : {};

  const payment = {
    id:
      paymentId,

    userId:
      user.id,

    status:
      data.status ||
      "pending",

    amount:
      transactionAmount,

    externalReference,

    qrCode:
      transactionData
        .qr_code ||
      "",

    qrCodeBase64:
      transactionData
        .qr_code_base64 ||
      "",

    ticketUrl:
      transactionData
        .ticket_url ||
      null,

    createdAt:
      new Date().toISOString(),

    raw:
      data,
  };

  payments.set(
    paymentId,
    payment
  );

  metrics.pixCreated++;

  return payment;
}

/* ============================================================
   ATUALIZAÇÃO DE PAGAMENTO
   ============================================================ */

async function refreshPayment(
  paymentId
) {
  const data =
    await mpRequest(
      `/v1/payments/${encodeURIComponent(
        paymentId
      )}`,
      {
        method: "GET",
      }
    );

  const existing =
    payments.get(
      String(paymentId)
    );

  const payment =
    existing || {
      id:
        String(paymentId),
      userId:
        null,
    };

  const previousStatus =
    payment.status;

  payment.status =
    data.status ||
    payment.status ||
    "pending";

  payment.raw =
    data;

  payment.updatedAt =
    new Date().toISOString();

  payments.set(
    String(paymentId),
    payment
  );

  /*
   * Só contabiliza aprovação
   * na transição.
   */
  if (
    previousStatus !==
      "approved" &&
    payment.status ===
      "approved"
  ) {
    metrics.pixApproved++;

    const user =
      payment.userId
        ? users.get(
            payment.userId
          )
        : null;

    if (user) {
      user.vip = true;

      user.points =
        Math.max(
          user.points,
          100
        );
    }
  }

  return payment;
}

/* ============================================================
   ROTAS
   ============================================================ */

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,

      name:
        "ClipForge Pro API",

      version:
        APP_VERSION,

      status:
        "online",

      timestamp:
        new Date().toISOString(),
    });
  }
);

/* ============================================================
   STATUS
   ============================================================ */

app.get(
  "/api/status",
  (req, res) => {
    res.json({
      ok: true,

      service:
        "ClipForge Pro",

      version:
        APP_VERSION,

      node:
        process.version,

      environment:
        NODE_ENV,

      uptime:
        process.uptime(),

      gemini: {
        configured:
          Boolean(
            GEMINI_API_KEY
          ),

        model:
          GEMINI_MODEL,

        endpoint:
          GEMINI_ENDPOINT,

        api:
          "Interactions API",
      },

      rapidApi: {
        configured:
          Boolean(
            RAPIDAPI_KEY
          ),

        host:
          RAPIDAPI_HOST,
      },

      downloader: {
        external:
          Boolean(
            EXTERNAL_DOWNLOAD_URL
          ),

        rapidApi:
          Boolean(
            RAPIDAPI_KEY
          ),

        ytDlp:
          Boolean(
            YTDLP_PATH
          ),

        ffmpeg:
          Boolean(
            FFMPEG_PATH
          ),

        ffprobe:
          Boolean(
            FFPROBE_PATH
          ),
      },

      mercadoPago: {
        configured:
          Boolean(
            MP_ACCESS_TOKEN
          ),
      },

      metrics: {
        requests:
          metrics.requests,

        analyses:
          metrics.analyses,

        analysisSuccess:
          metrics.analysisSuccess,

        analysisFailures:
          metrics.analysisFailures,

        geminiRequests:
          metrics.geminiRequests,

        geminiSuccess:
          metrics.geminiSuccess,

        geminiFailures:
          metrics.geminiFailures,

        downloads:
          metrics.downloads,

        downloadSuccess:
          metrics.downloadSuccess,

        downloadFailures:
          metrics.downloadFailures,
      },
    });
  }
);

/* ============================================================
   LOGIN / SESSÃO
   ============================================================ */

app.post(
  "/api/auth/login",
  (req, res) => {
    const body =
      req.body || {};

    const userId =
      safeString(
        body.userId ||
          body.user_id ||
          randomId("user_")
      );

    const user =
      getOrCreateUser(
        userId
      );

    const token =
      createSession(
        user.id
      );

    res.json({
      ok: true,

      token,

      user: {
        id:
          user.id,

        vip:
          user.vip,

        points:
          user.points,

        analyses:
          user.analyses,

        downloads:
          user.downloads,
      },
    });
  }
);

/* ============================================================
   ME
   ============================================================ */

app.get(
  "/api/auth/me",
  requireUser,
  (req, res) => {
    const user =
      req.user;

    res.json({
      ok: true,

      user: {
        id:
          user.id,

        vip:
          user.vip,

        points:
          user.points,

        analyses:
          user.analyses,

        downloads:
          user.downloads,

        createdAt:
          user.createdAt,

        lastAnalysisAt:
          user.lastAnalysisAt,

        lastDownloadAt:
          user.lastDownloadAt,
      },
    });
  }
);

/* ============================================================
   ANÁLISE
   ============================================================ */

app.post(
  "/api/analisar",
  async (req, res) => {
    metrics.analyses++;

    let user =
      resolveRequestUser(
        req
      );

    /*
     * Compatibilidade com frontend
     * que ainda não faz login.
     */
    if (!user) {
      user =
        getOrCreateUser(
          randomId("user_")
        );
    }

    const body =
      req.body || {};

    const rawUrl =
      body.url ||
      body.youtubeUrl ||
      body.youtube_url ||
      body.videoUrl ||
      body.video_url;

    const normalized =
      normalizeYouTubeUrl(
        rawUrl
      );

    if (!normalized) {
      metrics.analysisFailures++;

      return res.status(400).json({
        ok: false,

        error:
          "URL do YouTube inválida.",

        code:
          "INVALID_YOUTUBE_URL",
      });
    }

    const maxClips =
      clampNumber(
        body.maxClips ||
          body.max_clips,
        1,
        12,
        8
      );

    const minDuration =
      clampNumber(
        body.minDuration ||
          body.min_duration,
        10,
        120,
        20
      );

    const maxDuration =
      clampNumber(
        body.maxDuration ||
          body.max_duration,
        20,
        180,
        90
      );

    if (
      maxDuration <
      minDuration
    ) {
      metrics.analysisFailures++;

      return res.status(400).json({
        ok: false,

        error:
          "maxDuration deve ser maior ou igual a minDuration.",
      });
    }

    console.log(
      "===================================================="
    );

    console.log(
      `[Análise] CLIPFORGE ${APP_VERSION}`
    );

    console.log(
      `[Análise] Usuário: ${user.id}`
    );

    console.log(
      `[Análise] Vídeo: ${normalized.videoId}`
    );

    try {
      const result =
        await analisarComGemini(
          {
            youtubeUrl:
              normalized.url,

            videoId:
              normalized.videoId,

            maxClips,

            minDuration,

            maxDuration,
          }
        );

      user.analyses++;
      user.lastAnalysisAt =
        new Date().toISOString();

      /*
       * Consome ponto somente
       * quando a análise foi concluída.
       */
      if (!user.vip) {
        user.points =
          Math.max(
            0,
            user.points - 1
          );
      }

      metrics.analysisSuccess++;

      console.log(
        `[Análise] Sucesso: ${result.clips.length} cortes`
      );

      return res.json({
        ok: true,

        version:
          APP_VERSION,

        video: {
          id:
            normalized.videoId,

          url:
            normalized.url,
        },

        title:
          result.title,

        summary:
          result.summary,

        clips:
          result.clips,

        count:
          result.clips.length,

        user: {
          id:
            user.id,

          vip:
            user.vip,

          points:
            user.points,

          analyses:
            user.analyses,
        },
      });
    } catch (error) {
      /*
       * IMPORTANTE:
       * não incrementar geminiFailures aqui,
       * porque analisarComGemini já faz isso.
       */
      metrics.analysisFailures++;

      console.error(
        `[Análise] Erro: ${error.message}`
      );

      return res.status(500).json({
        ok: false,

        error:
          error.message ||
          "Não foi possível analisar o vídeo.",

        code:
          "ANALYSIS_FAILED",

        version:
          APP_VERSION,
      });
    }
  }
);

/* ============================================================
   DOWNLOAD / GERAR CORTE
   ============================================================ */

app.post(
  "/api/download",
  async (req, res) => {
    metrics.downloads++;

    let user =
      resolveRequestUser(
        req
      );

    if (!user) {
      user =
        getOrCreateUser(
          randomId("user_")
        );
    }

    const body =
      req.body || {};

    const rawUrl =
      body.url ||
      body.youtubeUrl ||
      body.youtube_url ||
      body.videoUrl ||
      body.video_url;

    const normalized =
      normalizeYouTubeUrl(
        rawUrl
      );

    if (!normalized) {
      metrics.downloadFailures++;

      return res.status(400).json({
        ok: false,

        error:
          "URL do YouTube inválida.",

        code:
          "INVALID_YOUTUBE_URL",
      });
    }

    const start =
      clampNumber(
        body.start ??
          body.startTime ??
          body.inicio,
        0,
        86400,
        0
      );

    const end =
      Number(
        body.end ??
          body.endTime ??
          body.fim
      );

    let duration;

    if (
      Number.isFinite(end) &&
      end > start
    ) {
      duration =
        end - start;
    } else {
      duration =
        clampNumber(
          body.duration,
          1,
          180,
          60
        );
    }

    duration =
      clampNumber(
        duration,
        1,
        180,
        60
      );

    console.log(
      `[Download] Usuário: ${user.id}`
    );

    console.log(
      `[Download] Vídeo: ${normalized.videoId}`
    );

    console.log(
      `[Download] Início: ${start}s`
    );

    console.log(
      `[Download] Duração: ${duration}s`
    );

    let original = null;

    let clipPath = null;

    try {
      original =
        await downloadOriginalVideo(
          {
            youtubeUrl:
              normalized.url,

            videoId:
              normalized.videoId,
          }
        );

      const probe =
        await probeVideo(
          original.path
        );

      /*
       * Evita solicitar um trecho
       * além do tamanho real.
       */
      let actualDuration =
        duration;

      if (
        Number.isFinite(
          probe.duration
        )
      ) {
        if (
          start >=
          probe.duration
        ) {
          throw new Error(
            "O tempo inicial está além da duração do vídeo."
          );
        }

        actualDuration =
          Math.min(
            actualDuration,
            probe.duration -
              start
          );
      }

      if (
        actualDuration <=
        0
      ) {
        throw new Error(
          "Duração do corte inválida."
        );
      }

      const filename =
        `clip-${normalized.videoId}-${Date.now()}.mp4`;

      clipPath =
        path.join(
          OUTPUT_DIR,
          filename
        );

      await renderClip(
        {
          inputPath:
            original.path,

          outputPath:
            clipPath,

          start,

          duration:
            actualDuration,
        }
      );

      user.downloads++;
      user.lastDownloadAt =
        new Date().toISOString();

      metrics.downloadSuccess++;

      /*
       * Express envia arquivo e
       * remove após terminar.
       */
      return res.download(
        clipPath,
        filename,
        async (error) => {
          await safeRemove(
            clipPath
          );

          await safeRemove(
            original.path
          );

          if (error) {
            console.error(
              "[Download] Erro no envio:",
              error.message
            );
          }
        }
      );
    } catch (error) {
      metrics.downloadFailures++;

      console.error(
        `[Download] Erro: ${error.message}`
      );

      await safeRemove(
        clipPath
      );

      if (original) {
        await safeRemove(
          original.path
        );
      }

      return res.status(500).json({
        ok: false,

        error:
          error.message ||
          "Falha ao gerar o corte.",

        code:
          "DOWNLOAD_FAILED",

        version:
          APP_VERSION,
      });
    }
  }
);

/* ============================================================
   CRIAR PIX
   ============================================================ */

app.post(
  "/api/pix/criar",
  async (req, res) => {
    const user =
      resolveRequestUser(
        req
      ) ||
      getOrCreateUser(
        randomId("user_")
      );

    if (!MP_ACCESS_TOKEN) {
      return res.status(503).json({
        ok: false,

        error:
          "Mercado Pago não configurado no servidor.",
      });
    }

    const body =
      req.body || {};

    const amount =
      body.amount ??
      body.valor ??
      body.price ??
      19.90;

    const description =
      body.description ||
      body.descricao ||
      "ClipForge Pro VIP";

    try {
      const payment =
        await createPixPayment(
          {
            user,

            amount,

            description,
          }
        );

      /*
       * Compatibilidade com
       * frontends que usam qr_code.
       */
      return res.json({
        ok: true,

        id:
          payment.id,

        paymentId:
          payment.id,

        status:
          payment.status,

        amount:
          payment.amount,

        qrCode:
          payment.qrCode,

        qr_code:
          payment.qrCode,

        qrCodeBase64:
          payment.qrCodeBase64,

        qr_code_base64:
          payment.qrCodeBase64,

        ticketUrl:
          payment.ticketUrl,

        ticket_url:
          payment.ticketUrl,

        externalReference:
          payment.externalReference,

        external_reference:
          payment.externalReference,
      });
    } catch (error) {
      metrics.pixRejected++;

      console.error(
        "[PIX] Erro:",
        error.message
      );

      return res.status(500).json({
        ok: false,

        error:
          error.message ||
          "Não foi possível criar o pagamento Pix.",
      });
    }
  }
);

/* ============================================================
   STATUS PIX
   ============================================================ */

app.get(
  "/api/pix/status/:id",
  async (req, res) => {
    const paymentId =
      req.params.id;

    if (!paymentId) {
      return res.status(400).json({
        ok: false,

        error:
          "ID do pagamento não informado.",
      });
    }

    try {
      const payment =
        await refreshPayment(
          paymentId
        );

      return res.json({
        ok: true,

        id:
          payment.id,

        paymentId:
          payment.id,

        status:
          payment.status,

        approved:
          payment.status ===
          "approved",

        amount:
          payment.amount,

        userId:
          payment.userId,
      });
    } catch (error) {
      console.error(
        "[PIX] Status:",
        error.message
      );

      return res.status(500).json({
        ok: false,

        error:
          error.message ||
          "Não foi possível consultar o pagamento.",
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
    /*
     * O Mercado Pago pode enviar
     * diferentes estruturas de
     * notificação.
     */
    const body =
      req.body || {};

    console.log(
      "[Mercado Pago] Webhook recebido:",
      JSON.stringify(
        body
      ).slice(
        0,
        3000
      )
    );

    /*
     * Não bloquear webhook apenas
     * porque a aplicação não possui
     * segredo configurado.
     *
     * O segredo pode ser validado
     * posteriormente conforme a
     * configuração da conta.
     */

    const paymentId =
      body.data &&
      body.data.id
        ? body.data.id
        : body.id ||
          body.payment_id ||
          null;

    if (
      paymentId
    ) {
      try {
        await refreshPayment(
          String(
            paymentId
          )
        );
      } catch (error) {
        console.error(
          "[Mercado Pago] Falha ao atualizar webhook:",
          error.message
        );
      }
    }

    return res.status(200).json({
      ok: true,
    });
  }
);

/* ============================================================
   ADMIN LOGIN
   ============================================================ */

app.post(
  "/api/admin/login",
  (req, res) => {
    if (!ADMIN_PASSWORD) {
      return res.status(503).json({
        ok: false,

        error:
          "ADMIN_PASSWORD não configurada no Render.",
      });
    }

    const body =
      req.body || {};

    const username =
      safeString(
        body.username ||
          body.user ||
          body.email
      );

    const password =
      safeString(
        body.password
      );

    if (
      username !==
        ADMIN_USER ||
      password !==
        ADMIN_PASSWORD
    ) {
      return res.status(401).json({
        ok: false,

        error:
          "Usuário ou senha inválidos.",
      });
    }

    const token =
      createAdminSession();

    return res.json({
      ok: true,

      token,

      user:
        ADMIN_USER,
    });
  }
);

/* ============================================================
   ADMIN DASHBOARD
   ============================================================ */

app.get(
  "/api/admin/dashboard",
  requireAdmin,
  (req, res) => {
    const userList =
      Array.from(
        users.values()
      );

    const paymentList =
      Array.from(
        payments.values()
      );

    return res.json({
      ok: true,

      version:
        APP_VERSION,

      server: {
        uptime:
          process.uptime(),

        node:
          process.version,

        startedAt:
          metrics.startedAt,
      },

      users: {
        total:
          userList.length,

        vip:
          userList.filter(
            (user) =>
              user.vip
          ).length,

        analyses:
          userList.reduce(
            (
              total,
              user
            ) =>
              total +
              user.analyses,
            0
          ),

        downloads:
          userList.reduce(
            (
              total,
              user
            ) =>
              total +
              user.downloads,
            0
          ),
      },

      payments: {
        total:
          paymentList.length,

        approved:
          paymentList.filter(
            (payment) =>
              payment.status ===
              "approved"
          ).length,

        pending:
          paymentList.filter(
            (payment) =>
              payment.status ===
              "pending"
          ).length,
      },

      metrics,

      configuration: {
        geminiConfigured:
          Boolean(
            GEMINI_API_KEY
          ),

        geminiModel:
          GEMINI_MODEL,

        rapidApiConfigured:
          Boolean(
            RAPIDAPI_KEY
          ),

        externalDownloader:
          Boolean(
            EXTERNAL_DOWNLOAD_URL
          ),

        mercadoPagoConfigured:
          Boolean(
            MP_ACCESS_TOKEN
          ),

        ytdlp:
          YTDLP_PATH,

        ffmpeg:
          FFMPEG_PATH,

        ffprobe:
          FFPROBE_PATH,
      },
    });
  }
);

/* ============================================================
   ADMIN USERS
   ============================================================ */

app.get(
  "/api/admin/users",
  requireAdmin,
  (req, res) => {
    const list =
      Array.from(
        users.values()
      ).map(
        (user) => ({
          id:
            user.id,

          vip:
            user.vip,

          points:
            user.points,

          analyses:
            user.analyses,

          downloads:
            user.downloads,

          createdAt:
            user.createdAt,

          lastAnalysisAt:
            user.lastAnalysisAt,

          lastDownloadAt:
            user.lastDownloadAt,
        })
      );

    res.json({
      ok: true,

      total:
        list.length,

      users:
        list,
    });
  }
);

/* ============================================================
   ADMIN MÉTRICAS
   ============================================================ */

app.get(
  "/api/admin/metrics",
  requireAdmin,
  (req, res) => {
    res.json({
      ok: true,

      version:
        APP_VERSION,

      metrics,
    });
  }
);

/* ============================================================
   LOGOUT
   ============================================================ */

app.post(
  "/api/auth/logout",
  (req, res) => {
    const auth =
      req.headers.authorization ||
      "";

    if (
      auth.startsWith(
        "Bearer "
      )
    ) {
      const token =
        auth.slice(
          7
        ).trim();

      sessions.delete(
        token
      );
    }

    res.json({
      ok: true,
    });
  }
);

/* ============================================================
   404
   ============================================================ */

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,

      error:
        "Rota não encontrada.",

      path:
        req.originalUrl,

      version:
        APP_VERSION,
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
    metrics.errors++;

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
      error.status ||
        500
    ).json({
      ok: false,

      error:
        error.message ||
        "Erro interno do servidor.",

      version:
        APP_VERSION,
    });
  }
);

/* ============================================================
   START
   ============================================================ */

async function startServer() {
  await ensureDirectories();

  /*
   * Limpeza inicial.
   */
  await cleanupOldFiles();

  /*
   * Limpeza periódica.
   */
  setInterval(
    () => {
      cleanupOldFiles()
        .catch(
          () => {}
        );
    },
    30 * 60 * 1000
  );

  app.listen(
    PORT,
    HOST,
    () => {
      console.log("");
      console.log(
        "===================================================="
      );
      console.log(
        `CLIPFORGE PRO ${APP_VERSION}`
      );
      console.log(
        "===================================================="
      );

      console.log(
        `Server: http://${HOST}:${PORT}`
      );

      console.log(
        `Node: ${process.version}`
      );

      console.log(
        `Environment: ${NODE_ENV}`
      );

      console.log(
        `Gemini: ${
          GEMINI_API_KEY
            ? "CONFIGURADO"
            : "NÃO CONFIGURADO"
        }`
      );

      console.log(
        `Gemini Model: ${GEMINI_MODEL}`
      );

      console.log(
        `Gemini Endpoint: Interactions API`
      );

      console.log(
        `RapidAPI: ${
          RAPIDAPI_KEY
            ? "CONFIGURADO"
            : "NÃO CONFIGURADO"
        }`
      );

      console.log(
        `yt-dlp: ${YTDLP_PATH}`
      );

      console.log(
        `FFmpeg: ${FFMPEG_PATH}`
      );

      console.log(
        `FFprobe: ${FFPROBE_PATH}`
      );

      console.log(
        `Downloader externo: ${
          EXTERNAL_DOWNLOAD_URL
            ? "CONFIGURADO"
            : "NÃO CONFIGURADO"
        }`
      );

      console.log(
        `Mercado Pago: ${
          MP_ACCESS_TOKEN
            ? "CONFIGURADO"
            : "NÃO CONFIGURADO"
        }`
      );

      console.log(
        `Frontend CORS: ${
          ALLOWED_ORIGINS.join(
            ", "
          ) || "Netlify permitido"
        }`
      );

      console.log(
        "===================================================="
      );

      console.log(
        "[Gemini] Análise direta de URLs públicas do YouTube ativa."
      );

      console.log(
        "[Download] Externo + RapidAPI + FFmpeg + yt-dlp fallback ativo."
      );

      console.log(
        "===================================================="
      );
      console.log("");
    }
  );
}

/* ============================================================
   TRATAMENTO DE ENCERRAMENTO
   ============================================================ */

process.on(
  "SIGTERM",
  () => {
    console.log(
      "[Server] SIGTERM recebido."
    );

    process.exit(0);
  }
);

process.on(
  "SIGINT",
  () => {
    console.log(
      "[Server] SIGINT recebido."
    );

    process.exit(0);
  }
);

process.on(
  "unhandledRejection",
  (reason) => {
    console.error(
      "[Process] Unhandled Rejection:",
      reason
    );
  }
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "[Process] Uncaught Exception:",
      error
    );
  }
);

/* ============================================================
   START
   ============================================================ */

startServer()
  .catch((error) => {
    console.error(
      "[FATAL] Não foi possível iniciar o ClipForge:",
      error
    );

    process.exit(1);
  });