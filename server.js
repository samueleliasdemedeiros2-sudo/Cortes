"use strict";

/*
 * ============================================================
 * CLIPFORGE PRO
 * SERVER 13.0.4
 * ============================================================
 *
 * Gemini:
 *   /v1beta/models/${GEMINI_MODEL}:generateContent
 *
 * Pipeline de vídeo:
 *   EXTERNAL_DOWNLOAD_URL
 *        ↓
 *   RapidAPI
 *        ↓
 *   yt-dlp
 *        ↓
 *   ffprobe
 *        ↓
 *   FFmpeg H.264 + AAC + yuv420p
 *
 * ============================================================
 */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

const app = express();

/* ============================================================
   CONFIGURAÇÃO
   ============================================================ */

const PORT = Number(process.env.PORT || 10000);

const FRONTEND_URL = String(process.env.FRONTEND_URL || "*")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const RAPIDAPI_KEY = String(process.env.RAPIDAPI_KEY || "").trim();

const RAPIDAPI_HOST = String(
  process.env.RAPIDAPI_HOST || "yt-api.p.rapidapi.com"
).trim();

const MP_ACCESS_TOKEN = String(process.env.MP_ACCESS_TOKEN || "").trim();

const MP_PAYER_EMAIL = String(
  process.env.MP_PAYER_EMAIL || "pagamentos@clipforge.app"
).trim();

const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "").trim();

const SESSION_SECRET = String(
  process.env.SESSION_SECRET ||
    crypto.randomBytes(32).toString("hex")
).trim();

const GEMINI_API_KEY = String(
  process.env.GEMINI_API_KEY || ""
).trim();

/*
 * Evita usar acidentalmente um modelo 3.8 configurado
 * no Render enquanto esta versão do backend está padronizada
 * para Gemini 2.5 Flash.
 */
const configuredGeminiModel = String(
  process.env.GEMINI_MODEL || ""
).trim();

const GEMINI_MODEL =
  configuredGeminiModel &&
  !/gemini-3\.8-flash/i.test(configuredGeminiModel)
    ? configuredGeminiModel
    : "gemini-2.5-flash";

const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/` +
  `${encodeURIComponent(GEMINI_MODEL)}:generateContent`;

const YTDLP_PATH = String(
  process.env.YTDLP_PATH ||
    path.join(__dirname, "bin", "yt-dlp")
).trim();

const YTDLP_COOKIES_FILE = String(
  process.env.YTDLP_COOKIES_FILE || ""
).trim();

const FFMPEG_PATH = String(
  process.env.FFMPEG_PATH || "ffmpeg"
).trim();

const FFPROBE_PATH = String(
  process.env.FFPROBE_PATH || "ffprobe"
).trim();

const TEMP_DIR = String(
  process.env.TEMP_DIR ||
    path.join(os.tmpdir(), "clipforge")
).trim();

/*
 * Downloader externo.
 *
 * POST padrão:
 * {
 *   url: "...",
 *   videoId: "...",
 *   output: "mp4"
 * }
 *
 * Também pode ser configurado:
 * EXTERNAL_DOWNLOAD_METHOD=GET
 *
 * Nesse caso:
 * ?url=...&videoId=...
 */
const EXTERNAL_DOWNLOAD_URL = String(
  process.env.EXTERNAL_DOWNLOAD_URL || ""
).trim();

const EXTERNAL_DOWNLOAD_TOKEN = String(
  process.env.EXTERNAL_DOWNLOAD_TOKEN || ""
).trim();

const EXTERNAL_DOWNLOAD_METHOD = String(
  process.env.EXTERNAL_DOWNLOAD_METHOD || "POST"
).trim().toUpperCase();

const DOWNLOAD_TIMEOUT = Math.max(
  30_000,
  Number(process.env.DOWNLOAD_TIMEOUT || 180_000)
);

const GEMINI_TIMEOUT = Math.max(
  30_000,
  Number(process.env.GEMINI_TIMEOUT || 180_000)
);

const RAPIDAPI_TIMEOUT = Math.max(
  5_000,
  Number(process.env.RAPIDAPI_TIMEOUT || 30_000)
);

const STREAM_TEST_TIMEOUT = Math.max(
  3_000,
  Number(process.env.STREAM_TEST_TIMEOUT || 10_000)
);

const MAX_CLIPS = Math.max(
  1,
  Math.min(10, Number(process.env.MAX_CLIPS || 5))
);

const DEFAULT_CLIP_DURATION = Math.max(
  1,
  Number(process.env.DEFAULT_CLIP_DURATION || 55)
);

const MIN_CLIP_DURATION = Math.max(
  1,
  Number(process.env.MIN_CLIP_DURATION || 20)
);

const MAX_CLIP_DURATION = Math.max(
  MIN_CLIP_DURATION,
  Number(process.env.MAX_CLIP_DURATION || 60)
);

const INITIAL_POINTS = Math.max(
  0,
  Number(process.env.INITIAL_POINTS || 200)
);

const DAILY_POINTS = Math.max(
  0,
  Number(process.env.DAILY_POINTS || 50)
);

const DOWNLOAD_COST = Math.max(
  1,
  Number(process.env.DOWNLOAD_COST || 50)
);

const VIP_PRICE = Number(
  process.env.VIP_PRICE || 19.9
);

const SESSION_DAYS = Math.max(
  1,
  Number(process.env.SESSION_DAYS || 30)
);

const ADMIN_SESSION_HOURS = Math.max(
  1,
  Number(process.env.ADMIN_SESSION_HOURS || 12)
);

fs.mkdirSync(TEMP_DIR, {
  recursive: true,
});

/* ============================================================
   CORS
   ============================================================ */

const corsOptions = {
  origin(origin, callback) {
    if (
      !origin ||
      FRONTEND_URL.includes("*") ||
      FRONTEND_URL.includes(origin)
    ) {
      return callback(null, true);
    }

    return callback(null, false);
  },

  credentials: false,

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
    "X-Admin-Token",
  ],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

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

/* ============================================================
   MEMÓRIA
   ============================================================ */

const usuarios = new Map();
const pagamentos = new Map();
const adminSessions = new Map();

const metrics = {
  startedAt: Date.now(),

  requests: 0,

  analyses: 0,

  downloads: 0,
  downloadFailures: 0,

  rapidApiAttempts: 0,
  rapidApiSuccesses: 0,

  ytdlpAttempts: 0,
  ytdlpSuccesses: 0,

  externalDownloadAttempts: 0,
  externalDownloadSuccesses: 0,

  geminiAttempts: 0,
  geminiSuccesses: 0,
  geminiFailures: 0,

  pixCreated: 0,
  pixApproved: 0,
};

/* ============================================================
   LOG
   ============================================================ */

function log(...args) {
  console.log(...args);
}

function warn(...args) {
  console.warn(...args);
}

function errorLog(...args) {
  console.error(...args);
}

/* ============================================================
   UTILITÁRIOS
   ============================================================ */

function randomId(prefix = "") {
  return (
    prefix +
    crypto.randomBytes(16).toString("hex")
  );
}

function clamp(value, min, max) {
  return Math.min(
    Math.max(value, min),
    max
  );
}

function numberOr(value, fallback) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function safeFilename(name) {
  return (
    String(name || "clip")
      .replace(/[^\w\-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) ||
    "clip"
  );
}

function safeErrorText(text) {
  const value = String(text || "");

  if (!value) {
    return "";
  }

  let sanitized = value;

  const secrets = [
    GEMINI_API_KEY,
    RAPIDAPI_KEY,
    MP_ACCESS_TOKEN,
    ADMIN_PASSWORD,
    SESSION_SECRET,
    EXTERNAL_DOWNLOAD_TOKEN,
  ].filter(Boolean);

  for (const secret of secrets) {
    sanitized = sanitized.split(secret).join("[REDACTED]");
  }

  return sanitized.slice(0, 1500);
}

function fileExists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function removeFile(file) {
  try {
    fs.rmSync(file, {
      force: true,
    });
  } catch {}
}

/* ============================================================
   SESSÃO HMAC
   ============================================================ */

function hmac(input) {
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(input)
    .digest("hex");
}

function createUserToken(userId) {
  const payload = Buffer.from(
    JSON.stringify({
      userId,
      exp:
        Date.now() +
        SESSION_DAYS *
          24 *
          60 *
          60 *
          1000,
    })
  ).toString("base64url");

  return (
    payload +
    "." +
    hmac(payload)
  );
}

function verifyUserToken(token) {
  try {
    if (!token || typeof token !== "string") {
      return null;
    }

    const parts = token.split(".");

    if (parts.length !== 2) {
      return null;
    }

    const [payload, signature] = parts;

    const expected = hmac(payload);

    if (
      signature.length !== expected.length ||
      !crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected)
      )
    ) {
      return null;
    }

    const decoded = JSON.parse(
      Buffer.from(
        payload,
        "base64url"
      ).toString("utf8")
    );

    if (
      !decoded.userId ||
      !decoded.exp
    ) {
      return null;
    }

    if (
      Date.now() >
      Number(decoded.exp)
    ) {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

function getBearerToken(req) {
  const header = String(
    req.headers.authorization || ""
  );

  if (
    !header
      .toLowerCase()
      .startsWith("bearer ")
  ) {
    return "";
  }

  return header
    .slice(7)
    .trim();
}

function getSuppliedUserToken(req) {
  return (
    getBearerToken(req) ||
    String(
      req.body?.token ||
        req.query?.token ||
        ""
    ).trim()
  );
}

/* ============================================================
   USUÁRIOS
   ============================================================ */

function createUser(userId) {
  const now = Date.now();

  const user = {
    id:
      userId ||
      randomId("user_"),

    points:
      INITIAL_POINTS,

    vip: false,

    vipUntil: null,

    createdAt: now,

    updatedAt: now,

    lastDailyBonusAt: now,

    downloads: 0,

    analyses: 0,
  };

  usuarios.set(
    user.id,
    user
  );

  return user;
}

function getOrCreateUser(userId) {
  if (
    userId &&
    usuarios.has(userId)
  ) {
    return usuarios.get(userId);
  }

  return createUser(userId);
}

function applyDailyBonus(user) {
  const now = Date.now();

  const last = Number(
    user.lastDailyBonusAt || 0
  );

  const dayMs =
    24 *
    60 *
    60 *
    1000;

  if (
    now - last >= dayMs
  ) {
    user.points += DAILY_POINTS;

    user.lastDailyBonusAt = now;

    user.updatedAt = now;

    return true;
  }

  return false;
}

function isVip(user) {
  if (!user) {
    return false;
  }

  if (user.vip === true) {
    if (!user.vipUntil) {
      return true;
    }

    if (
      Date.now() <
      Number(user.vipUntil)
    ) {
      return true;
    }

    user.vip = false;
    user.vipUntil = null;
    user.updatedAt = Date.now();
  }

  return false;
}

function userPublic(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,

    points: user.points,

    vip: isVip(user),

    vipUntil: user.vipUntil,

    downloads:
      user.downloads || 0,

    analyses:
      user.analyses || 0,

    createdAt:
      user.createdAt,
  };
}

/* ============================================================
   YOUTUBE
   ============================================================ */

function extractYouTubeId(input) {
  const value = String(input || "").trim();

  if (!value) {
    return null;
  }

  if (
    /^[a-zA-Z0-9_-]{11}$/.test(value)
  ) {
    return value;
  }

  try {
    const url = new URL(value);

    const hostname =
      url.hostname.toLowerCase();

    if (
      hostname === "youtu.be" ||
      hostname === "www.youtu.be"
    ) {
      const id = url.pathname
        .replace(/^\/+/, "")
        .split("/")[0];

      return /^[a-zA-Z0-9_-]{11}$/.test(id)
        ? id
        : null;
    }

    if (
      hostname.includes("youtube.com") ||
      hostname.includes(
        "youtube-nocookie.com"
      )
    ) {
      const v =
        url.searchParams.get("v");

      if (
        v &&
        /^[a-zA-Z0-9_-]{11}$/.test(v)
      ) {
        return v;
      }

      const parts =
        url.pathname
          .split("/")
          .filter(Boolean);

      const candidates = [
        parts[0] === "shorts"
          ? parts[1]
          : null,

        parts[0] === "embed"
          ? parts[1]
          : null,

        parts[0] === "live"
          ? parts[1]
          : null,
      ];

      for (
        const candidate of candidates
      ) {
        if (
          candidate &&
          /^[a-zA-Z0-9_-]{11}$/.test(
            candidate
          )
        ) {
          return candidate;
        }
      }
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeYouTubeUrl(input) {
  const id =
    extractYouTubeId(input);

  if (!id) {
    return null;
  }

  return (
    "https://www.youtube.com/watch?v=" +
    id
  );
}

/* ============================================================
   AUTH USER
   ============================================================ */

async function requireUser(
  req,
  res,
  next
) {
  try {
    const token =
      getSuppliedUserToken(req);

    const payload =
      verifyUserToken(token);

    if (!payload?.userId) {
      return res.status(401).json({
        success: false,
        error:
          "Sessão inválida ou expirada.",
        code: "AUTH_REQUIRED",
      });
    }

    const user =
      usuarios.get(
        payload.userId
      );

    if (!user) {
      return res.status(401).json({
        success: false,
        error:
          "Usuário não encontrado.",
        code: "USER_NOT_FOUND",
      });
    }

    applyDailyBonus(user);

    req.user = user;

    req.userToken = token;

    next();
  } catch (err) {
    next(err);
  }
}

/* ============================================================
   ADMIN
   ============================================================ */

function createAdminToken() {
  const payload = Buffer.from(
    JSON.stringify({
      id: randomId("admin_"),

      exp:
        Date.now() +
        ADMIN_SESSION_HOURS *
          60 *
          60 *
          1000,
    })
  ).toString("base64url");

  const signature = hmac(
    "admin:" + payload
  );

  const token =
    payload +
    "." +
    signature;

  adminSessions.set(token, {
    createdAt: Date.now(),

    expiresAt:
      Date.now() +
      ADMIN_SESSION_HOURS *
        60 *
        60 *
        1000,
  });

  return token;
}

function verifyAdminToken(token) {
  try {
    if (!token) {
      return false;
    }

    const session =
      adminSessions.get(token);

    if (!session) {
      return false;
    }

    if (
      Date.now() >
      session.expiresAt
    ) {
      adminSessions.delete(token);

      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function requireAdmin(
  req,
  res,
  next
) {
  const token = String(
    req.headers["x-admin-token"] ||
      getBearerToken(req) ||
      req.body?.token ||
      ""
  ).trim();

  if (
    !verifyAdminToken(token)
  ) {
    return res.status(401).json({
      success: false,
      error:
        "Acesso administrativo não autorizado.",
    });
  }

  req.adminToken = token;

  next();
}

/* ============================================================
   GEMINI
   ============================================================ */

async function analisarComGemini(
  youtubeUrl,
  videoId
) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY não configurada."
    );
  }

  metrics.geminiAttempts++;

  const prompt = `
Você é o sistema de seleção inteligente
de cortes do ClipForge Pro.

Analise o vídeo público do YouTube fornecido.

Objetivo:
encontrar até ${MAX_CLIPS} trechos de maior potencial
para Shorts, TikTok e Reels.

REGRAS:

1. Retorne no máximo ${MAX_CLIPS} cortes.

2. Cada corte deve ter entre
${MIN_CLIP_DURATION} e ${MAX_CLIP_DURATION} segundos.

3. Os timestamps devem ser números em segundos.

4. Não invente acontecimentos.

5. Preserve frases completas.

6. Evite iniciar no meio de uma frase.

7. Procure momentos com:
- informação forte;
- opinião;
- surpresa;
- humor;
- conflito;
- emoção;
- revelação;
- história interessante;
- frase de impacto.

8. "score" deve ser um número inteiro
entre 0 e 100.

9. "title" deve ser curto e chamativo,
mas factual.

10. "reason" deve explicar por que
aquele trecho pode funcionar como corte.

ID DO VÍDEO:
${videoId}
`.trim();

  const payload = {
    contents: [
      {
        role: "user",

        parts: [
          {
            text: prompt,
          },

          {
            fileData: {
              fileUri:
                youtubeUrl,
            },
          },
        ],
      },
    ],

    generationConfig: {
      temperature: 0.2,

      responseMimeType:
        "application/json",

      responseSchema: {
        type: "OBJECT",

        properties: {
          clips: {
            type: "ARRAY",

            items: {
              type: "OBJECT",

              properties: {
                start: {
                  type: "INTEGER",
                },

                end: {
                  type: "INTEGER",
                },

                title: {
                  type: "STRING",
                },

                reason: {
                  type: "STRING",
                },

                score: {
                  type: "INTEGER",
                },
              },

              required: [
                "start",
                "end",
                "title",
                "reason",
                "score",
              ],
            },
          },
        },

        required: [
          "clips",
        ],
      },
    },
  };

  log(
    `[Gemini] Modelo: ${GEMINI_MODEL}`
  );

  log(
    "[Gemini] Enviando URL pública do YouTube para análise..."
  );

  let response;

  try {
    response = await fetch(
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
          JSON.stringify(payload),

        signal:
          AbortSignal.timeout(
            GEMINI_TIMEOUT
          ),
      }
    );
  } catch (err) {
    metrics.geminiFailures++;

    throw new Error(
      "Falha de conexão com Gemini: " +
        safeErrorText(
          err.message || err
        )
    );
  }

  const rawText =
    await response.text();

  if (!response.ok) {
    metrics.geminiFailures++;

    throw new Error(
      `Gemini HTTP ${response.status}: ` +
        safeErrorText(rawText)
    );
  }

  let data;

  try {
    data =
      JSON.parse(rawText);
  } catch {
    metrics.geminiFailures++;

    throw new Error(
      "Gemini retornou resposta inválida."
    );
  }

  const candidate =
    data?.candidates?.[0];

  if (
    candidate?.finishReason ===
    "SAFETY"
  ) {
    metrics.geminiFailures++;

    throw new Error(
      "Gemini bloqueou a resposta por política de segurança."
    );
  }

  const parts =
    candidate?.content?.parts ||
    [];

  const candidateText =
    parts
      .map(
        (part) =>
          part?.text || ""
      )
      .join("")
      .trim();

  if (!candidateText) {
    metrics.geminiFailures++;

    throw new Error(
      "Gemini respondeu sem conteúdo estruturado."
    );
  }

  let parsed;

  try {
    parsed =
      JSON.parse(candidateText);
  } catch {
    const cleaned =
      candidateText
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
      parsed =
        JSON.parse(cleaned);
    } catch {
      metrics.geminiFailures++;

      throw new Error(
        "Gemini retornou JSON inválido."
      );
    }
  }

  if (
    !parsed ||
    !Array.isArray(
      parsed.clips
    )
  ) {
    metrics.geminiFailures++;

    throw new Error(
      "Gemini não retornou a lista 'clips'."
    );
  }

  metrics.geminiSuccesses++;

  return parsed.clips;
}

/* ============================================================
   NORMALIZAÇÃO
   ============================================================ */

function normalizarClips(
  clips
) {
  const result = [];

  for (
    const clip of Array.isArray(clips)
      ? clips
      : []
  ) {
    const start =
      Math.max(
        0,
        numberOr(
          clip.start,
          0
        )
      );

    let end =
      numberOr(
        clip.end,
        start +
          DEFAULT_CLIP_DURATION
      );

    if (end <= start) {
      end =
        start +
        DEFAULT_CLIP_DURATION;
    }

    let duration =
      end - start;

    duration =
      clamp(
        duration,
        MIN_CLIP_DURATION,
        MAX_CLIP_DURATION
      );

    end =
      start +
      duration;

    const title =
      String(
        clip.title ||
          "Corte selecionado"
      )
        .trim()
        .slice(0, 160);

    const reason =
      String(
        clip.reason ||
          "Trecho selecionado pela IA."
      )
        .trim()
        .slice(0, 500);

    const score =
      clamp(
        numberOr(
          clip.score,
          70
        ),
        0,
        100
      );

    const candidate = {
      inicio:
        Math.round(
          start * 100
        ) / 100,

      fim:
        Math.round(
          end * 100
        ) / 100,

      duracao:
        Math.round(
          duration * 100
        ) / 100,

      titulo:
        title ||
        "Corte selecionado",

      motivo:
        reason ||
        "Trecho selecionado pela IA.",

      score:
        Math.round(score),
    };

    const duplicate =
      result.some(
        (existing) => {
          const overlapStart =
            Math.max(
              existing.inicio,
              candidate.inicio
            );

          const overlapEnd =
            Math.min(
              existing.fim,
              candidate.fim
            );

          const overlap =
            Math.max(
              0,
              overlapEnd -
                overlapStart
            );

          const shorter =
            Math.min(
              existing.duracao,
              candidate.duracao
            );

          return (
            shorter > 0 &&
            overlap /
              shorter >=
              0.8
          );
        }
      );

    if (!duplicate) {
      result.push(
        candidate
      );
    }

    if (
      result.length >=
      MAX_CLIPS
    ) {
      break;
    }
  }

  result.sort(
    (a, b) =>
      b.score - a.score
  );

  return result.slice(
    0,
    MAX_CLIPS
  );
}

/* ============================================================
   RAPIDAPI
   ============================================================ */

function inferStreamAudio(value) {
  if (!value) {
    return null;
  }

  if (
    value.audio !== undefined
  ) {
    return Boolean(
      value.audio
    );
  }

  if (
    value.hasAudio !== undefined
  ) {
    return Boolean(
      value.hasAudio
    );
  }

  const text = [
    value.mimeType,
    value.mime,
    value.type,
    value.codecs,
    value.codec,
    value.audioCodec,
    value.audioQuality,
    value.quality,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    /mp4a|aac|opus|vorbis|audio/i.test(
      text
    )
  ) {
    return true;
  }

  if (
    /video\/mp4.*audio/i.test(
      text
    )
  ) {
    return true;
  }

  return null;
}

async function consultarYTAPI(
  videoId
) {
  if (!RAPIDAPI_KEY) {
    throw new Error(
      "RAPIDAPI_KEY não configurada."
    );
  }

  metrics.rapidApiAttempts++;

  const url =
    `https://${RAPIDAPI_HOST}` +
    `/dl?id=${encodeURIComponent(
      videoId
    )}&cgeo=BR`;

  log(
    `[YT-API] Consultando: ${videoId}`
  );

  const response =
    await fetch(url, {
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
          RAPIDAPI_TIMEOUT
        ),
    });

  const text =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    throw new Error(
      `YT-API retornou resposta não-JSON (HTTP ${response.status}).`
    );
  }

  if (!response.ok) {
    throw new Error(
      `YT-API HTTP ${response.status}: ` +
        safeErrorText(
          data?.message ||
            "erro desconhecido"
        )
    );
  }

  const streams = [];

  function addStream(value) {
    if (
      !value ||
      typeof value !==
        "object"
    ) {
      return;
    }

    const urlValue =
      value.url ||
      value.downloadUrl ||
      value.download_url ||
      value.videoUrl ||
      value.video_url ||
      value.link;

    if (
      !urlValue ||
      typeof urlValue !==
        "string"
    ) {
      return;
    }

    if (
      !/^https?:\/\//i.test(
        urlValue
      )
    ) {
      return;
    }

    const mime =
      String(
        value.mimeType ||
          value.mime ||
          value.type ||
          ""
      ).toLowerCase();

    const audio =
      inferStreamAudio(
        value
      );

    const height =
      Number(
        value.height ||
          value.videoHeight ||
          value.resolution?.height ||
          0
      );

    const width =
      Number(
        value.width ||
          value.videoWidth ||
          value.resolution?.width ||
          0
      );

    const quality =
      String(
        value.qualityLabel ||
          value.quality ||
          value.resolution ||
          ""
      );

    streams.push({
      url: urlValue,

      mime,

      audio,

      height:
        Number.isFinite(
          height
        )
          ? height
          : 0,

      width:
        Number.isFinite(
          width
        )
          ? width
          : 0,

      quality,
    });
  }

  function walk(
    value,
    depth = 0
  ) {
    if (
      depth > 8 ||
      value == null
    ) {
      return;
    }

    if (
      Array.isArray(value)
    ) {
      for (
        const item of value
      ) {
        walk(
          item,
          depth + 1
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

    addStream(value);

    for (
      const nested of Object.values(
        value
      )
    ) {
      if (
        nested &&
        (
          Array.isArray(
            nested
          ) ||
          typeof nested ===
            "object"
        )
      ) {
        walk(
          nested,
          depth + 1
        );
      }
    }
  }

  walk(data);

  const unique = [];

  const seen = new Set();

  for (
    const stream of streams
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

  if (!unique.length) {
    throw new Error(
      "YT-API não retornou streams."
    );
  }

  const candidates =
    unique.filter(
      (stream) =>
        stream.audio === true ||
        (
          stream.audio === null &&
          /video\/mp4/i.test(
            stream.mime
          )
        )
    );

  const usable =
    candidates.length
      ? candidates
      : unique;

  usable.sort(
    (a, b) => {
      function score(
        stream
      ) {
        let value = 0;

        if (
          stream.audio === true
        ) {
          value +=
            1000000;
        }

        if (
          /video\/mp4/i.test(
            stream.mime
          )
        ) {
          value +=
            500000;
        }

        if (
          /video/i.test(
            stream.mime
          )
        ) {
          value +=
            100000;
        }

        value +=
          Math.min(
            stream.height ||
              0,
            2160
          ) * 100;

        value +=
          Math.min(
            stream.width ||
              0,
            3840
          );

        return value;
      }

      return (
        score(b) -
        score(a)
      );
    }
  );

  log(
    `[YT-API] Streams encontradas: ${unique.length}`
  );

  log(
    `[YT-API] Candidatas A/V: ${candidates.length}`
  );

  log(
    `[YT-API] Streams com áudio detectado: ${
      unique.filter(
        (s) =>
          s.audio === true
      ).length
    }`
  );

  return {
    all: unique,

    candidates:
      usable,

    raw: data,
  };
}

/* ============================================================
   TESTE DE STREAM
   ============================================================ */

async function testarStream(
  url
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      STREAM_TEST_TIMEOUT
    );

  try {
    const response =
      await fetch(url, {
        method: "GET",

        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36",

          Accept:
            "*/*",

          "Accept-Language":
            "en-US,en;q=0.9",

          Referer:
            "https://www.youtube.com/",

          Origin:
            "https://www.youtube.com",

          Range:
            "bytes=0-1023",
        },

        redirect: "follow",

        signal:
          controller.signal,
      });

    const result = {
      ok:
        response.status >=
          200 &&
        response.status <
          300,

      status:
        response.status,

      contentType:
        response.headers.get(
          "content-type"
        ) || "",

      contentLength:
        response.headers.get(
          "content-length"
        ) || "",

      finalUrl:
        response.url,
    };

    try {
      await response.body?.cancel();
    } catch {}

    return result;
  } catch (err) {
    return {
      ok: false,

      status: 0,

      error:
        err.message ||
        String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
   DOWNLOAD STREAM
   ============================================================ */

async function baixarStreamParaArquivo(
  url,
  outputPath
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      DOWNLOAD_TIMEOUT
    );

  try {
    const response =
      await fetch(url, {
        method: "GET",

        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36",

          Accept:
            "*/*",

          "Accept-Language":
            "en-US,en;q=0.9",

          Referer:
            "https://www.youtube.com/",

          Origin:
            "https://www.youtube.com",
        },

        redirect: "follow",

        signal:
          controller.signal,
      });

    if (!response.ok) {
      throw new Error(
        `Stream retornou HTTP ${response.status}.`
      );
    }

    if (!response.body) {
      throw new Error(
        "Stream não possui corpo."
      );
    }

    await pipeline(
      Readable.fromWeb(
        response.body
      ),
      fs.createWriteStream(
        outputPath
      )
    );

    if (
      !fileExists(
        outputPath
      )
    ) {
      throw new Error(
        "Arquivo não foi criado."
      );
    }

    const stat =
      fs.statSync(
        outputPath
      );

    if (
      stat.size < 1024
    ) {
      throw new Error(
        `Arquivo baixado é muito pequeno (${stat.size} bytes).`
      );
    }

    return {
      path: outputPath,

      size: stat.size,
    };
  } catch (err) {
    removeFile(
      outputPath
    );

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
   EXECUÇÃO DE PROCESSOS
   ============================================================ */

function executar(
  command,
  args,
  options = {}
) {
  return new Promise(
    (resolve, reject) => {
      log(
        `[Processo] ${command} ${args
          .map((arg) =>
            String(arg)
          )
          .join(" ")}`
      );

      const child =
        spawn(
          command,
          args,
          {
            cwd:
              options.cwd ||
              process.cwd(),

            env:
              process.env,

            stdio: [
              "ignore",
              "pipe",
              "pipe",
            ],
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

      child.on(
        "error",
        (err) => {
          reject(err);
        }
      );

      child.on(
        "close",
        (code) => {
          if (code === 0) {
            return resolve({
              code,
              stdout,
              stderr,
            });
          }

          const message =
            stderr.trim() ||
            stdout.trim() ||
            `processo terminou com código ${code}`;

          const err =
            new Error(
              message
            );

          err.code =
            code;

          reject(err);
        }
      );
    }
  );
}

/* ============================================================
   FFPROBE
   ============================================================ */

async function ffprobeDuration(
  filePath
) {
  try {
    const result =
      await executar(
        FFPROBE_PATH,
        [
          "-v",
          "error",

          "-show_entries",
          "format=duration",

          "-of",
          "default=noprint_wrappers=1:nokey=1",

          filePath,
        ]
      );

    const duration =
      Number(
        result.stdout.trim()
      );

    return Number.isFinite(
      duration
    ) &&
      duration > 0
      ? duration
      : null;
  } catch {
    return null;
  }
}

async function validarVideoOriginal(
  filePath
) {
  if (
    !fileExists(filePath)
  ) {
    throw new Error(
      "Arquivo original não foi encontrado."
    );
  }

  const stat =
    fs.statSync(
      filePath
    );

  if (
    stat.size < 1024
  ) {
    throw new Error(
      `Arquivo de vídeo inválido (${stat.size} bytes).`
    );
  }

  const duration =
    await ffprobeDuration(
      filePath
    );

  if (!duration) {
    throw new Error(
      "Arquivo não possui vídeo reproduzível."
    );
  }

  return duration;
}

/* ============================================================
   CORTE FFMPEG
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
      Number(start) || 0
    );

  const safeDuration =
    Math.max(
      1,
      Number(duration) || 1
    );

  await executar(
    FFMPEG_PATH,
    [
      "-y",

      "-hide_banner",

      "-loglevel",
      "error",

      "-ss",
      safeStart.toFixed(3),

      "-i",
      inputPath,

      "-t",
      safeDuration.toFixed(3),

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

      "-max_muxing_queue_size",
      "2048",

      outputPath,
    ]
  );

  if (
    !fileExists(
      outputPath
    )
  ) {
    throw new Error(
      "FFmpeg não gerou o MP4."
    );
  }

  const stat =
    fs.statSync(
      outputPath
    );

  if (
    stat.size <
    10 * 1024
  ) {
    throw new Error(
      `MP4 gerado é muito pequeno (${stat.size} bytes).`
    );
  }

  const outputDuration =
    await ffprobeDuration(
      outputPath
    );

  if (
    !outputDuration ||
    outputDuration <
      0.5
  ) {
    throw new Error(
      "MP4 gerado está sem duração válida."
    );
  }

  return {
    path: outputPath,

    size: stat.size,

    duration:
      outputDuration,
  };
}

/* ============================================================
   RAPIDAPI DOWNLOAD
   ============================================================ */

async function baixarViaRapidAPI(
  videoId,
  originalPath
) {
  const info =
    await consultarYTAPI(
      videoId
    );

  const candidates =
    info.candidates.slice(
      0,
      4
    );

  if (!candidates.length) {
    throw new Error(
      "YT-API não forneceu streams candidatas."
    );
  }

  let saw403 = false;

  for (
    const stream of candidates
  ) {
    log(
      `[Download] Testando stream: ${
        stream.quality ||
        stream.height ||
        "desconhecida"
      }`
    );

    const test =
      await testarStream(
        stream.url
      );

    if (
      test.status ===
      403
    ) {
      saw403 = true;

      warn(
        "[YT-API] Stream retornou HTTP 403."
      );

      continue;
    }

    if (
      !test.ok
    ) {
      continue;
    }

    try {
      await baixarStreamParaArquivo(
        stream.url,
        originalPath
      );

      await validarVideoOriginal(
        originalPath
      );

      metrics.rapidApiSuccesses++;

      log(
        "[YT-API] Download validado com sucesso."
      );

      return {
        path:
          originalPath,

        source:
          "rapidapi",
      };
    } catch (err) {
      warn(
        `[YT-API] Falha durante transferência: ${safeErrorText(
          err.message
        )}`
      );

      removeFile(
        originalPath
      );
    }
  }

  if (saw403) {
    throw new Error(
      "Todas as streams testadas pela YT-API retornaram HTTP 403."
    );
  }

  throw new Error(
    "Nenhuma stream da YT-API pôde ser baixada."
  );
}

/* ============================================================
   DOWNLOADER EXTERNO
   ============================================================ */

function externalHeaders() {
  const headers = {
    Accept:
      "*/*",
  };

  if (
    EXTERNAL_DOWNLOAD_METHOD ===
    "POST"
  ) {
    headers[
      "Content-Type"
    ] =
      "application/json";
  }

  if (
    EXTERNAL_DOWNLOAD_TOKEN
  ) {
    headers.Authorization =
      `Bearer ${EXTERNAL_DOWNLOAD_TOKEN}`;

    headers[
      "x-api-key"
    ] =
      EXTERNAL_DOWNLOAD_TOKEN;
  }

  return headers;
}

async function baixarViaServicoExterno(
  youtubeUrl,
  videoId,
  originalPath
) {
  if (
    !EXTERNAL_DOWNLOAD_URL
  ) {
    throw new Error(
      "EXTERNAL_DOWNLOAD_URL não configurada."
    );
  }

  metrics.externalDownloadAttempts++;

  log(
    `[External] Iniciando downloader externo para ${videoId}`
  );

  let requestUrl =
    EXTERNAL_DOWNLOAD_URL;

  const requestOptions = {
    method:
      EXTERNAL_DOWNLOAD_METHOD,

    headers:
      externalHeaders(),

    signal:
      AbortSignal.timeout(
        DOWNLOAD_TIMEOUT
      ),
  };

  if (
    EXTERNAL_DOWNLOAD_METHOD ===
    "GET"
  ) {
    const separator =
      requestUrl.includes("?")
        ? "&"
        : "?";

    requestUrl +=
      separator +
      "url=" +
      encodeURIComponent(
        youtubeUrl
      ) +
      "&videoId=" +
      encodeURIComponent(
        videoId
      );
  } else {
    requestOptions.body =
      JSON.stringify({
        url:
          youtubeUrl,

        videoId,

        output:
          "mp4",
      });
  }

  const response =
    await fetch(
      requestUrl,
      requestOptions
    );

  if (!response.ok) {
    const body =
      await response
        .text()
        .catch(
          () => ""
        );

    throw new Error(
      `Downloader externo HTTP ${response.status}: ${safeErrorText(
        body
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
   * Caso 1:
   * endpoint já devolve o MP4.
   */
  if (
    contentType.includes(
      "video/"
    ) ||
    contentType.includes(
      "application/octet-stream"
    )
  ) {
    if (
      !response.body
    ) {
      throw new Error(
        "Downloader externo não retornou corpo."
      );
    }

    await pipeline(
      Readable.fromWeb(
        response.body
      ),
      fs.createWriteStream(
        originalPath
      )
    );

    const duration =
      await validarVideoOriginal(
        originalPath
      );

    metrics.externalDownloadSuccesses++;

    log(
      "[External] MP4 recebido diretamente."
    );

    return {
      path:
        originalPath,

      source:
        "external",

      duration,
    };
  }

  /*
   * Caso 2:
   * endpoint devolve JSON contendo URL.
   */
  const text =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    throw new Error(
      "Downloader externo não retornou MP4 nem JSON."
    );
  }

  const downloadUrl =
    data?.url ||
    data?.downloadUrl ||
    data?.download_url ||
    data?.videoUrl ||
    data?.video_url ||
    data?.result?.url ||
    data?.data?.url;

  if (
    !downloadUrl
  ) {
    throw new Error(
      "Downloader externo não retornou URL do arquivo."
    );
  }

  await baixarStreamParaArquivo(
    downloadUrl,
    originalPath
  );

  const duration =
    await validarVideoOriginal(
      originalPath
    );

  metrics.externalDownloadSuccesses++;

  log(
    "[External] URL externa convertida em MP4 válido."
  );

  return {
    path:
      originalPath,

    source:
      "external",

    duration,
  };
}

/* ============================================================
   YT-DLP
   ============================================================ */

function ytdlpExiste() {
  try {
    return fileExists(
      YTDLP_PATH
    );
  } catch {
    return false;
  }
}

async function baixarComYtDlp(
  youtubeUrl,
  outputPath
) {
  metrics.ytdlpAttempts++;

  if (!ytdlpExiste()) {
    throw new Error(
      `yt-dlp não encontrado em ${YTDLP_PATH}`
    );
  }

  log(
    "[YT-DLP] Fallback ativado."
  );

  const args = [
    "--no-playlist",

    "--no-warnings",

    "--newline",

    "--restrict-filenames",

    "--retries",
    "3",

    "--fragment-retries",
    "3",

    "--socket-timeout",
    "30",

    "-f",
    "bv*+ba/b",

    "--merge-output-format",
    "mp4",

    "-o",
    outputPath,

    youtubeUrl,
  ];

  if (
    YTDLP_COOKIES_FILE &&
    fileExists(
      YTDLP_COOKIES_FILE
    )
  ) {
    args.splice(
      args.length - 1,
      0,
      "--cookies",
      YTDLP_COOKIES_FILE
    );

    log(
      "[YT-DLP] Cookies autorizados configurados."
    );
  }

  try {
    await executar(
      YTDLP_PATH,
      args
    );

    if (
      !fileExists(
        outputPath
      )
    ) {
      throw new Error(
        "yt-dlp finalizou sem gerar arquivo."
      );
    }

    await validarVideoOriginal(
      outputPath
    );

    metrics.ytdlpSuccesses++;

    log(
      "[YT-DLP] Vídeo validado com sucesso."
    );

    return {
      path:
        outputPath,

      source:
        "ytdlp",
    };
  } catch (err) {
    const message =
      String(
        err?.message ||
          err ||
          ""
      );

    if (
      /Sign in to confirm|not a bot|LOGIN_REQUIRED/i.test(
        message
      )
    ) {
      throw new Error(
        "O YouTube bloqueou o IP deste servidor com proteção anti-bot."
      );
    }

    if (
      /403|Forbidden/i.test(
        message
      )
    ) {
      throw new Error(
        "O YouTube retornou HTTP 403 ao yt-dlp."
      );
    }

    throw err;
  }
}

/* ============================================================
   PIPELINE PRINCIPAL
   ============================================================ */

async function obterVideoOriginal(
  youtubeUrl,
  videoId,
  originalPath
) {
  const failures = [];

  /*
   * 1. EXTERNAL
   */
  if (
    EXTERNAL_DOWNLOAD_URL
  ) {
    try {
      return await baixarViaServicoExterno(
        youtubeUrl,
        videoId,
        originalPath
      );
    } catch (err) {
      const message =
        safeErrorText(
          err.message ||
            err
        );

      failures.push(
        "external: " +
          message
      );

      warn(
        `[External] Falhou: ${message}`
      );

      removeFile(
        originalPath
      );
    }
  }

  /*
   * 2. RAPIDAPI
   */
  if (
    RAPIDAPI_KEY
  ) {
    try {
      return await baixarViaRapidAPI(
        videoId,
        originalPath
      );
    } catch (err) {
      const message =
        safeErrorText(
          err.message ||
            err
        );

      failures.push(
        "rapidapi: " +
          message
      );

      warn(
        `[YT-API] Falhou: ${message}`
      );

      removeFile(
        originalPath
      );
    }
  }

  /*
   * 3. YT-DLP
   */
  if (
    ytdlpExiste()
  ) {
    try {
      return await baixarComYtDlp(
        youtubeUrl,
        originalPath
      );
    } catch (err) {
      const message =
        safeErrorText(
          err.message ||
            err
        );

      failures.push(
        "yt-dlp: " +
          message
      );

      warn(
        `[YT-DLP] Falhou: ${message}`
      );

      removeFile(
        originalPath
      );
    }
  }

  const finalError =
    new Error(
      "Não foi possível obter o vídeo. " +
        failures.join(
          " | "
        )
    );

  finalError.code =
    "DOWNLOAD_SOURCE_UNAVAILABLE";

  throw finalError;
}

/* ============================================================
   REEMBOLSO
   ============================================================ */

function createRefundController(
  user,
  amount
) {
  let refunded = false;

  return {
    get refunded() {
      return refunded;
    },

    refund() {
      if (
        refunded ||
        amount <= 0
      ) {
        return false;
      }

      user.points += amount;

      user.updatedAt =
        Date.now();

      refunded = true;

      return true;
    },
  };
}

/* ============================================================
   ROTAS GERAIS
   ============================================================ */

app.use(
  (req, res, next) => {
    metrics.requests++;

    next();
  }
);

app.get(
  "/",
  (req, res) => {
    res.json({
      success: true,

      name:
        "ClipForge Pro",

      version:
        "13.0.4",

      status:
        "online",

      uptime:
        process.uptime(),

      time:
        new Date().toISOString(),
    });
  }
);

app.get(
  "/api/status",
  (req, res) => {
    res.json({
      success: true,

      name:
        "ClipForge Pro",

      version:
        "13.0.4",

      status:
        "online",

      uptime:
        process.uptime(),

      node:
        process.version,

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

      ytDlpAvailable:
        ytdlpExiste(),

      ffmpeg:
        FFMPEG_PATH,

      ffprobe:
        FFPROBE_PATH,

      externalDownloaderConfigured:
        Boolean(
          EXTERNAL_DOWNLOAD_URL
        ),

      externalDownloaderMethod:
        EXTERNAL_DOWNLOAD_METHOD,

      time:
        new Date().toISOString(),
    });
  }
);

/* ============================================================
   SESSÃO
   ============================================================ */

app.post(
  "/api/session",
  (req, res) => {
    const suppliedToken =
      getSuppliedUserToken(
        req
      );

    const payload =
      verifyUserToken(
        suppliedToken
      );

    let user;

    if (
      payload?.userId &&
      usuarios.has(
        payload.userId
      )
    ) {
      user =
        usuarios.get(
          payload.userId
        );
    } else {
      user =
        createUser();
    }

    const bonus =
      applyDailyBonus(
        user
      );

    const token =
      createUserToken(
        user.id
      );

    res.json({
      success: true,

      token,

      user:
        userPublic(
          user
        ),

      dailyBonus:
        bonus
          ? DAILY_POINTS
          : 0,
    });
  }
);

app.get(
  "/api/me",
  requireUser,
  (req, res) => {
    res.json({
      success: true,

      user:
        userPublic(
          req.user
        ),
    });
  }
);

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
      normalizeYouTubeUrl(
        req.body?.url ||
          req.body?.youtubeUrl ||
          req.body?.videoUrl
      );

    if (!youtubeUrl) {
      return res.status(400).json({
        success: false,

        error:
          "URL do YouTube inválida.",
      });
    }

    const videoId =
      extractYouTubeId(
        youtubeUrl
      );

    if (!videoId) {
      return res.status(400).json({
        success: false,

        error:
          "Não foi possível extrair o ID do vídeo.",
      });
    }

    try {
      log(
        "=========================================="
      );

      log(
        "[Análise] CLIPFORGE 13.0.4"
      );

      log(
        `[Análise] Usuário: ${req.user.id}`
      );

      log(
        `[Análise] Vídeo: ${videoId}`
      );

      const rawClips =
        await analisarComGemini(
          youtubeUrl,
          videoId
        );

      const clips =
        normalizarClips(
          rawClips
        );

      req.user.analyses =
        Number(
          req.user.analyses ||
            0
        ) + 1;

      req.user.updatedAt =
        Date.now();

      metrics.analyses++;

      if (!clips.length) {
        return res.status(422).json({
          success: false,

          error:
            "A IA não localizou trechos com duração adequada neste vídeo.",

          clips: [],
        });
      }

      return res.json({
        success: true,

        videoId,

        url:
          youtubeUrl,

        clips,

        user:
          userPublic(
            req.user
          ),
      });
    } catch (err) {
      metrics.geminiFailures++;

      const message =
        safeErrorText(
          err.message ||
            err
        );

      errorLog(
        `[Análise] Erro: ${message}`
      );

      return res.status(502).json({
        success: false,

        error:
          message ||
          "Falha na análise pela IA.",

        code:
          "GEMINI_ANALYSIS_FAILED",
      });
    }
  }
);

/* ============================================================
   DOWNLOAD
   ============================================================ */

app.post(
  "/api/download",
  requireUser,
  async (
    req,
    res
  ) => {
    const youtubeUrl =
      normalizeYouTubeUrl(
        req.body?.url ||
          req.body?.youtubeUrl ||
          req.body?.videoUrl
      );

    if (!youtubeUrl) {
      return res.status(400).json({
        success: false,

        error:
          "URL do YouTube inválida.",
      });
    }

    const videoId =
      extractYouTubeId(
        youtubeUrl
      );

    if (!videoId) {
      return res.status(400).json({
        success: false,

        error:
          "Vídeo do YouTube inválido.",
      });
    }

    const start =
      Math.max(
        0,
        numberOr(
          req.body?.start ??
            req.body?.inicio,
          0
        )
      );

    let duration =
      numberOr(
        req.body?.duration ??
          req.body?.duracao,
        DEFAULT_CLIP_DURATION
      );

    duration =
      clamp(
        duration,
        1,
        MAX_CLIP_DURATION
      );

    const vip =
      isVip(
        req.user
      );

    if (
      !vip &&
      req.user.points <
        DOWNLOAD_COST
    ) {
      return res.status(402).json({
        success: false,

        error:
          `Você precisa de ${DOWNLOAD_COST} pontos para baixar este corte.`,

        code:
          "INSUFFICIENT_POINTS",

        points:
          req.user.points,

        cost:
          DOWNLOAD_COST,
      });
    }

    const jobId =
      randomId("");

    const originalPath =
      path.join(
        TEMP_DIR,
        `${jobId}-original.mp4`
      );

    const clipPath =
      path.join(
        TEMP_DIR,
        `${jobId}-clip.mp4`
      );

    let charged = false;

    if (!vip) {
      req.user.points -=
        DOWNLOAD_COST;

      req.user.updatedAt =
        Date.now();

      charged = true;
    }

    const refund =
      createRefundController(
        req.user,
        charged
          ? DOWNLOAD_COST
          : 0
      );

    let renderCompleted =
      false;

    try {
      log(
        "=========================================="
      );

      log(
        "[Download] CLIPFORGE 13.0.4"
      );

      log(
        `[Download] Usuário: ${req.user.id}`
      );

      log(
        `[Download] VIP: ${vip}`
      );

      log(
        `[Download] Pontos cobrados: ${
          charged
            ? DOWNLOAD_COST
            : 0
        }`
      );

      log(
        `[Download] Vídeo: ${videoId}`
      );

      log(
        `[Download] Start: ${start}`
      );

      log(
        `[Download] Duration: ${duration}`
      );

      const acquired =
        await obterVideoOriginal(
          youtubeUrl,
          videoId,
          originalPath
        );

      const sourceDuration =
        acquired.duration ||
        (await validarVideoOriginal(
          originalPath
        ));

      log(
        `[Download] Duração real: ${sourceDuration.toFixed(
          2
        )}s`
      );

      if (
        start >=
        sourceDuration
      ) {
        throw new Error(
          `O início (${start}s) excede a duração do vídeo (${sourceDuration.toFixed(
            1
          )}s).`
        );
      }

      const safeStart =
        clamp(
          start,
          0,
          Math.max(
            0,
            sourceDuration -
              0.1
          )
        );

      const available =
        sourceDuration -
        safeStart;

      const renderDuration =
        Math.min(
          duration,
          available
        );

      if (
        renderDuration <
        1
      ) {
        throw new Error(
          "Não existe duração suficiente para gerar o corte."
        );
      }

      log(
        `[FFmpeg] Início ajustado: ${safeStart.toFixed(
          2
        )}s`
      );

      log(
        `[FFmpeg] Duração ajustada: ${renderDuration.toFixed(
          2
        )}s`
      );

      const result =
        await cortarVideo(
          originalPath,
          clipPath,
          safeStart,
          renderDuration
        );

      /*
       * Validação final independente.
       */
      const finalDuration =
        await validarVideoOriginal(
          clipPath
        );

      if (
        finalDuration <
        0.5
      ) {
        throw new Error(
          "O corte final não possui duração válida."
        );
      }

      renderCompleted =
        true;

      req.user.downloads =
        Number(
          req.user.downloads ||
            0
        ) + 1;

      req.user.updatedAt =
        Date.now();

      metrics.downloads++;

      const filename =
        `${safeFilename(
          req.body?.title ||
            req.body?.titulo ||
            "clipforge"
        )}.mp4`;

      res.status(200);

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Length",
        String(
          result.size
        )
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

      let streamStarted =
        false;

      stream.on(
        "data",
        () => {
          streamStarted =
            true;
        }
      );

      stream.on(
        "error",
        (err) => {
          errorLog(
            `[Download] Erro de transmissão: ${safeErrorText(
              err.message
            )}`
          );

          /*
           * Não devolve pontos depois que
           * o render já foi concluído.
           */
          if (
            !renderCompleted &&
            !streamStarted
          ) {
            refund.refund();
          }
        }
      );

      const cleanup =
        () => {
          removeFile(
            originalPath
          );

          removeFile(
            clipPath
          );
        };

      stream.on(
        "end",
        cleanup
      );

      res.on(
        "close",
        cleanup
      );

      stream.pipe(res);
    } catch (err) {
      metrics.downloadFailures++;

      const message =
        safeErrorText(
          err.message ||
            err
        );

      errorLog(
        `[Download] Erro: ${message}`
      );

      let refundedPoints = 0;

      /*
       * Reembolso somente se o render/download
       * não foi concluído.
       */
      if (
        !renderCompleted
      ) {
        if (
          refund.refund()
        ) {
          refundedPoints =
            charged
              ? DOWNLOAD_COST
              : 0;
        }
      }

      removeFile(
        originalPath
      );

      removeFile(
        clipPath
      );

      if (
        res.headersSent
      ) {
        return res.end();
      }

      const youtubeBlocked =
        /anti-bot|not a bot|LOGIN_REQUIRED|bloqueou o IP/i.test(
          message
        );

      const rapidApi403 =
        /403|Forbidden/i.test(
          message
        );

      return res.status(502).json({
        success: false,

        error:
          message ||
          "Falha ao gerar o corte.",

        code:
          "DOWNLOAD_FAILED",

        refundedPoints,

        points:
          req.user.points,

        diagnostics: {
          youtubeBlocked,

          rapidApi403,

          externalDownloaderConfigured:
            Boolean(
              EXTERNAL_DOWNLOAD_URL
            ),

          sourcePipeline:
            [
              EXTERNAL_DOWNLOAD_URL
                ? "external"
                : null,

              RAPIDAPI_KEY
                ? "rapidapi"
                : null,

              ytdlpExiste()
                ? "yt-dlp"
                : null,
            ].filter(Boolean),
        },
      });
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
        success: false,

        error:
          "ADMIN_PASSWORD não configurada.",
      });
    }

    if (
      password.length !==
        ADMIN_PASSWORD.length ||
      !crypto.timingSafeEqual(
        Buffer.from(
          password
        ),
        Buffer.from(
          ADMIN_PASSWORD
        )
      )
    ) {
      return res.status(401).json({
        success: false,

        error:
          "Senha inválida.",
      });
    }

    const token =
      createAdminToken();

    res.json({
      success: true,

      token,

      expiresIn:
        ADMIN_SESSION_HOURS *
        3600,
    });
  }
);

app.post(
  "/api/admin/logout",
  requireAdmin,
  (req, res) => {
    adminSessions.delete(
      req.adminToken
    );

    res.json({
      success: true,
    });
  }
);

app.get(
  "/api/admin/dashboard",
  requireAdmin,
  (req, res) => {
    const userList =
      Array.from(
        usuarios.values()
      );

    const vipUsers =
      userList.filter(
        (user) =>
          isVip(user)
      );

    const pointsTotal =
      userList.reduce(
        (acc, user) =>
          acc +
          Number(
            user.points || 0
          ),
        0
      );

    const approvedPayments =
      Array.from(
        pagamentos.values()
      ).filter(
        (payment) =>
          payment.status ===
          "approved"
      );

    res.json({
      success: true,

      metrics,

      users: {
        total:
          userList.length,

        vip:
          vipUsers.length,

        pointsTotal,
      },

      payments: {
        total:
          pagamentos.size,

        approved:
          approvedPayments.length,
      },

      config: {
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

        ytdlpAvailable:
          ytdlpExiste(),

        externalDownloaderConfigured:
          Boolean(
            EXTERNAL_DOWNLOAD_URL
          ),

        externalDownloaderMethod:
          EXTERNAL_DOWNLOAD_METHOD,
      },
    });
  }
);

/* ============================================================
   MERCADO PAGO
   ============================================================ */

async function mpRequest(
  endpoint,
  options = {}
) {
  if (
    !MP_ACCESS_TOKEN
  ) {
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
      }
    );

  const text =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    data = {
      raw: text,
    };
  }

  if (
    !response.ok
  ) {
    throw new Error(
      `Mercado Pago HTTP ${response.status}: ${safeErrorText(
        data?.message ||
          text
      )}`
    );
  }

  return data;
}

async function processarPagamentoAprovado(
  payment
) {
  if (!payment) {
    return null;
  }

  if (
    payment.status !==
      "approved" &&
    payment.status !==
      "authorized"
  ) {
    return null;
  }

  const reference =
    String(
      payment.external_reference ||
        ""
    );

  const match =
    reference.match(
      /^clipforge-(.+)-(\d+)$/
    );

  if (!match) {
    return null;
  }

  const userId =
    match[1];

  const user =
    usuarios.get(
      userId
    );

  if (!user) {
    return null;
  }

  const paymentId =
    String(
      payment.id
    );

  const existing =
    pagamentos.get(
      paymentId
    );

  if (
    existing?.processed
  ) {
    return user;
  }

  user.vip = true;

  user.vipUntil =
    Date.now() +
    30 *
      24 *
      60 *
      60 *
      1000;

  user.updatedAt =
    Date.now();

  pagamentos.set(
    paymentId,
    {
      id:
        paymentId,

      status:
        payment.status,

      userId,

      processed:
        true,

      amount:
        payment.transaction_amount,

      approvedAt:
        Date.now(),
    }
  );

  metrics.pixApproved++;

  return user;
}

/* ============================================================
   PIX CREATE
   ============================================================ */

app.post(
  "/api/pix/create",
  requireUser,
  async (
    req,
    res
  ) => {
    if (
      !MP_ACCESS_TOKEN
    ) {
      return res.status(503).json({
        success: false,

        error:
          "PIX desativado no momento.",
      });
    }

    try {
      const externalReference =
        `clipforge-${req.user.id}-${Date.now()}`;

      const payment =
        await mpRequest(
          "/v1/payments",
          {
            method:
              "POST",

            headers: {
              "X-Idempotency-Key":
                crypto.randomUUID(),
            },

            body:
              JSON.stringify({
                transaction_amount:
                  VIP_PRICE,

                description:
                  "ClipForge Pro - VIP",

                payment_method_id:
                  "pix",

                payer: {
                  email:
                    req.body?.email ||
                    MP_PAYER_EMAIL,
                },

                external_reference:
                  externalReference,
              }),
          }
        );

      pagamentos.set(
        String(
          payment.id
        ),
        {
          id:
            String(
              payment.id
            ),

          status:
            payment.status,

          userId:
            req.user.id,

          processed:
            false,

          createdAt:
            Date.now(),
        }
      );

      metrics.pixCreated++;

      const pixData =
        payment
          .point_of_interaction
          ?.transaction_data;

      res.json({
        success: true,

        paymentId:
          payment.id,

        status:
          payment.status,

        qrCode:
          pixData?.qr_code ||
          null,

        qrCodeBase64:
          pixData?.qr_code_base64 ||
          null,

        ticketUrl:
          pixData?.ticket_url ||
          null,

        amount:
          VIP_PRICE,
      });
    } catch (err) {
      errorLog(
        `[PIX] Erro de criação: ${safeErrorText(
          err.message
        )}`
      );

      res.status(502).json({
        success: false,

        error:
          safeErrorText(
            err.message
          ),
      });
    }
  }
);

/* ============================================================
   PIX STATUS
   ============================================================ */

app.get(
  "/api/pix/status/:paymentId",
  requireUser,
  async (
    req,
    res
  ) => {
    const paymentId =
      String(
        req.params.paymentId ||
          ""
      ).trim();

    if (!paymentId) {
      return res.status(400).json({
        success: false,

        error:
          "ID de pagamento inválido.",
      });
    }

    try {
      const payment =
        await mpRequest(
          `/v1/payments/${encodeURIComponent(
            paymentId
          )}`,
          {
            method:
              "GET",
          }
        );

      const stored =
        pagamentos.get(
          paymentId
        );

      if (
        stored &&
        stored.userId !==
          req.user.id
      ) {
        return res.status(403).json({
          success: false,

          error:
            "Acesso não autorizado.",
        });
      }

      const approvedUser =
        await processarPagamentoAprovado(
          payment
        );

      res.json({
        success: true,

        paymentId,

        status:
          payment.status,

        statusDetail:
          payment.status_detail ||
          null,

        approved:
          payment.status ===
          "approved",

        vip:
          approvedUser
            ? true
            : isVip(
                req.user
              ),

        user:
          userPublic(
            req.user
          ),
      });
    } catch (err) {
      res.status(502).json({
        success: false,

        error:
          safeErrorText(
            err.message
          ),
      });
    }
  }
);

/* ============================================================
   PIX WEBHOOK
   ============================================================ */

app.post(
  "/api/pix/webhook",
  async (
    req,
    res
  ) => {
    /*
     * Responde imediatamente ao Mercado Pago.
     */
    res.status(200).json({
      success: true,
    });

    try {
      const paymentId =
        req.body?.data?.id ||
        req.body?.id ||
        req.query?.id;

      if (!paymentId) {
        return;
      }

      const payment =
        await mpRequest(
          `/v1/payments/${encodeURIComponent(
            String(
              paymentId
            )
          )}`,
          {
            method:
              "GET",
          }
        );

      await processarPagamentoAprovado(
        payment
      );
    } catch (err) {
      errorLog(
        `[PIX] Webhook erro: ${safeErrorText(
          err.message
        )}`
      );
    }
  }
);

/* ============================================================
   CLEANUP
   ============================================================ */

function cleanupTemp() {
  try {
    if (
      !fs.existsSync(
        TEMP_DIR
      )
    ) {
      return;
    }

    const now =
      Date.now();

    for (
      const file of fs.readdirSync(
        TEMP_DIR
      )
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
          now -
            stat.mtimeMs >
          30 *
            60 *
            1000
        ) {
          fs.rmSync(
            fullPath,
            {
              force: true,
              recursive: true,
            }
          );
        }
      } catch {}
    }
  } catch (err) {
    warn(
      `[Cleanup] ${safeErrorText(
        err.message
      )}`
    );
  }
}

setInterval(
  cleanupTemp,
  15 *
    60 *
    1000
).unref();

setInterval(
  () => {
    const now =
      Date.now();

    for (
      const [
        token,
        session,
      ] of adminSessions
    ) {
      if (
        now >
        session.expiresAt
      ) {
        adminSessions.delete(
          token
        );
      }
    }
  },
  60 *
    60 *
    1000
).unref();

/* ============================================================
   404
   ============================================================ */

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,

      error:
        "Rota não encontrada.",

      path:
        req.path,
    });
  }
);

/* ============================================================
   ERRO GLOBAL
   ============================================================ */

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
    errorLog(
      "[Global Error]",
      err?.stack ||
        err
    );

    if (
      res.headersSent
    ) {
      return next(err);
    }

    res.status(500).json({
      success: false,

      error:
        "Erro interno do servidor.",
    });
  }
);

/* ============================================================
   START
   ============================================================ */

app.listen(
  PORT,
  () => {
    log("");

    log(
      "===================================================="
    );

    log(
      " CLIPFORGE PRO 13.0.4"
    );

    log(
      "===================================================="
    );

    log(
      ` Porta: ${PORT}`
    );

    log(
      ` Node: ${process.version}`
    );

    log(
      ` Gemini: ${
        GEMINI_API_KEY
          ? "CONFIGURADO"
          : "NÃO CONFIGURADO"
      }`
    );

    log(
      ` Gemini Model: ${GEMINI_MODEL}`
    );

    log(
      ` Gemini Endpoint: generateContent`
    );

    log(
      ` RapidAPI: ${
        RAPIDAPI_KEY
          ? "CONFIGURADO"
          : "NÃO CONFIGURADO"
      }`
    );

    log(
      ` yt-dlp: ${
        ytdlpExiste()
          ? YTDLP_PATH
          : "NÃO ENCONTRADO"
      }`
    );

    log(
      ` FFmpeg: ${FFMPEG_PATH}`
    );

    log(
      ` FFprobe: ${FFPROBE_PATH}`
    );

    log(
      ` Downloader externo: ${
        EXTERNAL_DOWNLOAD_URL
          ? "CONFIGURADO"
          : "NÃO CONFIGURADO"
      }`
    );

    log(
      ` External method: ${EXTERNAL_DOWNLOAD_METHOD}`
    );

    log(
      "===================================================="
    );

    log("");
  }
);