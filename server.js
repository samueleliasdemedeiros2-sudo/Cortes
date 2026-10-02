/**
 * ============================================================
 * CLIPFORGE PRO
 * Backend 13.0.8
 * ============================================================
 *
 * Node.js + Express
 *
 * PRINCIPAIS RECURSOS:
 * - Gemini Interactions API
 * - Gemini 3.8 Flash
 * - Análise multimodal direta de URLs públicas do YouTube
 * - Structured Output JSON
 * - Downloader Externo
 * - RapidAPI
 * - yt-dlp fallback
 * - Validação real de vídeo com FFprobe
 * - FFmpeg H.264 + AAC
 * - MP4 compatível com navegador/mobile
 * - CORS para Netlify/Vercel
 * - Autenticação por sessão
 * - Sistema de pontos
 * - Mercado Pago PIX
 * - Dashboard administrativo
 * - Limpeza automática
 *
 * PIPELINE DE DOWNLOAD:
 *
 * Downloader externo
 *        ↓
 * validação FFprobe
 *        ↓ falhou
 * RapidAPI
 *        ↓
 * validação FFprobe
 *        ↓ falhou
 * yt-dlp
 *        ↓
 * validação FFprobe
 *        ↓
 * FFmpeg
 *        ↓
 * MP4 H.264 + AAC
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
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

/* ============================================================
   CONFIGURAÇÃO
   ============================================================ */

const APP_VERSION = "13.0.8";

const app = express();

const PORT = Number(
  process.env.PORT || 10000
);

const HOST =
  process.env.HOST || "0.0.0.0";

const NODE_ENV =
  process.env.NODE_ENV || "production";

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
   DOWNLOADERS
   ============================================================ */

const RAPIDAPI_KEY =
  process.env.RAPIDAPI_KEY ||
  process.env.X_RAPIDAPI_KEY ||
  "";

const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST ||
  "youtube-media-downloader.p.rapidapi.com";

const EXTERNAL_DOWNLOAD_URL =
  process.env.EXTERNAL_DOWNLOAD_URL ||
  "";

const EXTERNAL_DOWNLOAD_TOKEN =
  process.env.EXTERNAL_DOWNLOAD_TOKEN ||
  "";

const YTDLP_PATH =
  process.env.YTDLP_PATH ||
  path.join(
    process.cwd(),
    "bin",
    "yt-dlp"
  );

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
   CORS
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

const TEMP_ROOT =
  path.join(
    os.tmpdir(),
    "clipforge-pro"
  );

const DOWNLOAD_DIR =
  path.join(
    TEMP_ROOT,
    "downloads"
  );

const OUTPUT_DIR =
  path.join(
    TEMP_ROOT,
    "outputs"
  );

/* ============================================================
   MEMÓRIA
   ============================================================ */

const users = new Map();
const sessions = new Map();
const adminSessions = new Map();
const payments = new Map();

/* ============================================================
   MÉTRICAS
   ============================================================ */

const metrics = {
  startedAt:
    new Date().toISOString(),

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
  externalDownloadFailures: 0,

  rapidApiAttempts: 0,
  rapidApiRateLimited: 0,
  rapidApiFailures: 0,

  ytdlpAttempts: 0,
  ytdlpFailures: 0,
  ytdlpAntiBot: 0,

  videoValidationAttempts: 0,
  videoValidationSuccess: 0,
  videoValidationFailures: 0,

  ffmpegAttempts: 0,
  ffmpegFailures: 0,

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

function randomId(prefix = "") {
  return (
    prefix +
    crypto
      .randomBytes(12)
      .toString("hex")
  );
}

function safeString(
  value,
  fallback = ""
) {
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
  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {
    return fallback;
  }

  return Math.min(
    max,
    Math.max(min, number)
  );
}

function sanitizeFilename(
  value
) {
  return safeString(
    value,
    "file"
  )
    .replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    )
    .slice(0, 150);
}

function redactSecrets(
  text
) {
  let value =
    safeString(text);

  const secrets = [
    GEMINI_API_KEY,
    RAPIDAPI_KEY,
    EXTERNAL_DOWNLOAD_TOKEN,
    MP_ACCESS_TOKEN,
    ADMIN_PASSWORD,
  ].filter(Boolean);

  for (
    const secret of secrets
  ) {
    try {
      value =
        value.replace(
          new RegExp(
            secret.replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&"
            ),
            "g"
          ),
          "[REDACTED]"
        );
    } catch {}
  }

  return value;
}

/* ============================================================
   YOUTUBE
   ============================================================ */

function extractYouTubeVideoId(
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

    const host =
      url.hostname.toLowerCase();

    if (
      host === "youtube.com" ||
      host === "www.youtube.com" ||
      host.endsWith(".youtube.com")
    ) {
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

      const match =
        url.pathname.match(
          /\/(shorts|embed|live)\/([a-zA-Z0-9_-]{11})/
        );

      if (match) {
        return match[2];
      }
    }

    if (
      host === "youtu.be" ||
      host === "www.youtu.be"
    ) {
      const id =
        url.pathname
          .replace(/^\/+/, "")
          .split("/")[0];

      if (
        /^[a-zA-Z0-9_-]{11}$/.test(
          id
        )
      ) {
        return id;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeYouTubeUrl(
  input
) {
  const videoId =
    extractYouTubeVideoId(
      input
    );

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
   ARQUIVOS
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

async function safeRemove(
  file
) {
  if (!file) {
    return;
  }

  try {
    await fsp.rm(
      file,
      {
        recursive: true,
        force: true,
      }
    );
  } catch {}
}

async function cleanupOldFiles() {
  const directories = [
    DOWNLOAD_DIR,
    OUTPUT_DIR,
  ];

  const cutoff =
    Date.now() -
    60 *
      60 *
      1000;

  for (
    const dir of directories
  ) {
    try {
      const entries =
        await fsp.readdir(
          dir,
          {
            withFileTypes: true,
          }
        );

      for (
        const entry of entries
      ) {
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
   VALIDAÇÃO DE ARQUIVO
   ============================================================ */

/**
 * Validação básica por assinatura.
 *
 * Um MP4 normalmente possui a assinatura "ftyp"
 * dentro dos primeiros 32 bytes.
 *
 * Não usamos isso sozinha:
 * FFprobe também precisa reconhecer o arquivo.
 */

async function looksLikeMp4(
  filePath
) {
  try {
    const handle =
      await fsp.open(
        filePath,
        "r"
      );

    const buffer =
      Buffer.alloc(64);

    const result =
      await handle.read(
        buffer,
        0,
        buffer.length,
        0
      );

    await handle.close();

    const text =
      result.buffer
        .slice(
          0,
          result.bytesRead
        )
        .toString(
          "latin1"
        );

    return text.includes(
      "ftyp"
    );
  } catch {
    return false;
  }
}

/**
 * Verifica se a resposta parece HTML/JSON de erro.
 */

async function looksLikeTextError(
  filePath
) {
  try {
    const handle =
      await fsp.open(
        filePath,
        "r"
      );

    const buffer =
      Buffer.alloc(512);

    const result =
      await handle.read(
        buffer,
        0,
        buffer.length,
        0
      );

    await handle.close();

    const text =
      result.buffer
        .slice(
          0,
          result.bytesRead
        )
        .toString(
          "utf8"
        )
        .trim()
        .toLowerCase();

    if (
      text.startsWith(
        "<!doctype"
      ) ||
      text.startsWith(
        "<html"
      ) ||
      text.startsWith(
        "{"
      ) ||
      text.startsWith(
        "["
      )
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Validação REAL usando FFprobe.
 *
 * Essa função é chamada antes de considerar
 * qualquer downloader como bem-sucedido.
 */

async function validateVideoFile(
  filePath,
  options = {}
) {
  metrics.videoValidationAttempts++;

  if (
    !filePath ||
    !fs.existsSync(
      filePath
    )
  ) {
    metrics.videoValidationFailures++;

    throw new Error(
      "Arquivo de vídeo não foi criado."
    );
  }

  const stat =
    await fsp.stat(
      filePath
    );

  if (
    stat.size < 10000
  ) {
    metrics.videoValidationFailures++;

    throw new Error(
      `Arquivo baixado muito pequeno: ${stat.size} bytes.`
    );
  }

  if (
    await looksLikeTextError(
      filePath
    )
  ) {
    metrics.videoValidationFailures++;

    throw new Error(
      "O downloader retornou HTML/JSON em vez de um arquivo de vídeo."
    );
  }

  const probe =
    await runCommand(
      FFPROBE_PATH,
      [
        "-v",
        "error",

        "-show_entries",
        "format=format_name,duration,size",

        "-show_streams",

        "-of",
        "json",

        filePath,
      ],
      {
        timeout: 60000,
      }
    );

  if (
    probe.code !== 0
  ) {
    metrics.videoValidationFailures++;

    throw new Error(
      `FFprobe rejeitou o arquivo baixado: ${redactSecrets(
        probe.stderr
      ).slice(-1200)}`
    );
  }

  let data;

  try {
    data =
      JSON.parse(
        probe.stdout
      );
  } catch {
    metrics.videoValidationFailures++;

    throw new Error(
      "FFprobe retornou dados inválidos."
    );
  }

  const streams =
    Array.isArray(
      data.streams
    )
      ? data.streams
      : [];

  const videoStream =
    streams.find(
      (stream) =>
        stream &&
        stream.codec_type ===
          "video"
    );

  const audioStream =
    streams.find(
      (stream) =>
        stream &&
        stream.codec_type ===
          "audio"
    );

  const duration =
    Number(
      data?.format?.duration
    );

  if (
    !videoStream
  ) {
    metrics.videoValidationFailures++;

    throw new Error(
      "Arquivo baixado não possui stream de vídeo válida."
    );
  }

  if (
    !Number.isFinite(
      duration
    ) ||
    duration <= 0
  ) {
    metrics.videoValidationFailures++;

    throw new Error(
      "Vídeo baixado não possui duração válida."
    );
  }

  const formatName =
    safeString(
      data?.format?.format_name
    );

  const result = {
    valid: true,

    size:
      stat.size,

    duration,

    format:
      formatName,

    videoCodec:
      safeString(
        videoStream.codec_name
      ),

    audioCodec:
      audioStream
        ? safeString(
            audioStream.codec_name
          )
        : null,

    width:
      Number(
        videoStream.width
      ) || null,

    height:
      Number(
        videoStream.height
      ) || null,

    hasAudio:
      Boolean(
        audioStream
      ),

    isMp4:
      formatName
        .toLowerCase()
        .split(",")
        .includes("mov") ||
      formatName
        .toLowerCase()
        .split(",")
        .includes("mp4") ||
      (await looksLikeMp4(
        filePath
      )),
  };

  if (
    options.requireAudio &&
    !audioStream
  ) {
    metrics.videoValidationFailures++;

    throw new Error(
      "Vídeo válido, porém sem faixa de áudio."
    );
  }

  metrics.videoValidationSuccess++;

  return result;
}

/* ============================================================
   USUÁRIOS
   ============================================================ */

function getOrCreateUser(
  userId
) {
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

      points: 200,

      vip: false,

      lastAnalysisAt:
        null,

      lastDownloadAt:
        null,
    };

    users.set(
      id,
      user
    );
  }

  return user;
}

/* ============================================================
   SESSÕES
   ============================================================ */

function createSession(
  userId
) {
  const token =
    randomId("sess_");

  sessions.set(
    token,
    {
      userId,

      createdAt:
        now(),

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

function getSessionUser(
  req
) {
  const authorization =
    req.headers.authorization ||
    "";

  if (
    !authorization.startsWith(
      "Bearer "
    )
  ) {
    return null;
  }

  const token =
    authorization
      .slice(7)
      .trim();

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

function resolveRequestUser(
  req
) {
  const sessionUser =
    getSessionUser(req);

  if (sessionUser) {
    return sessionUser;
  }

  const userId =
    req.headers["x-user-id"] ||
    (
      req.body &&
      (
        req.body.userId ||
        req.body.user_id
      )
    );

  if (userId) {
    return getOrCreateUser(
      safeString(userId)
    );
  }

  return null;
}

function requireUser(
  req,
  res,
  next
) {
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

/* ============================================================
   ADMIN
   ============================================================ */

function createAdminSession() {
  const token =
    randomId("admin_");

  adminSessions.set(
    token,
    {
      createdAt:
        now(),

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

function requireAdmin(
  req,
  res,
  next
) {
  const authorization =
    req.headers.authorization ||
    "";

  if (
    !authorization.startsWith(
      "Bearer "
    )
  ) {
    return res.status(401).json({
      ok: false,

      error:
        "Acesso administrativo não autorizado.",
    });
  }

  const token =
    authorization
      .slice(7)
      .trim();

  const session =
    adminSessions.get(token);

  if (
    !session ||
    session.expiresAt < now()
  ) {
    if (session) {
      adminSessions.delete(
        token
      );
    }

    return res.status(401).json({
      ok: false,

      error:
        "Sessão administrativa expirada ou inválida.",
    });
  }

  req.admin = true;

  next();
}

/* ============================================================
   CORS
   ============================================================ */

const corsOptions = {
  origin(
    origin,
    callback
  ) {
    if (!origin) {
      return callback(
        null,
        true
      );
    }

    if (
      NODE_ENV !==
        "production" &&
      (
        origin.startsWith(
          "http://localhost:"
        ) ||
        origin.startsWith(
          "http://127.0.0.1:"
        )
      )
    ) {
      return callback(
        null,
        true
      );
    }

    if (
      ALLOWED_ORIGINS.includes(
        origin
      ) ||
      origin.endsWith(
        ".netlify.app"
      ) ||
      origin.endsWith(
        ".vercel.app"
      )
    ) {
      return callback(
        null,
        true
      );
    }

    /*
     * Mantido permissivo para não quebrar
     * o frontend atual durante testes.
     */
    return callback(
      null,
      true
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

app.disable(
  "x-powered-by"
);

app.use(
  cors(corsOptions)
);

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
  (
    req,
    res,
    next
  ) => {
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
    },

    summary: {
      type: "string",
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
  maxClips = 5,
  minDuration = 20,
  maxDuration = 60,
}) {
  return `
Você é o motor de cortes com IA do ClipForge Pro.

Analise cuidadosamente o vídeo do YouTube fornecido.

Objetivo:
encontrar os melhores momentos para cortes verticais
para YouTube Shorts, TikTok e Instagram Reels.

ID DO VÍDEO:
${videoId}

QUANTIDADE:
Retorne no máximo ${maxClips} cortes.

DURAÇÃO:
Cada corte deve ter entre ${minDuration} e ${maxDuration} segundos.

CRITÉRIOS:

1. Priorize momentos com alto potencial de retenção.
2. Procure ganchos fortes.
3. Procure frases impactantes.
4. Procure histórias completas.
5. Procure humor.
6. Procure revelações.
7. Procure opiniões interessantes.
8. Procure momentos emocionais.
9. Evite trechos sem contexto.
10. Evite pausas longas.
11. Evite começar no meio de uma frase.
12. Evite terminar no meio de uma frase.
13. Preserve o contexto necessário.
14. Os timestamps devem corresponder ao vídeo real.
15. Nunca invente timestamps.
16. O score deve variar de 0 a 100.
17. Priorize momentos que façam sentido isoladamente como Short/Reel/TikTok.
18. Não escolha vários trechos praticamente iguais.
19. Evite períodos de silêncio ou introduções longas.
20. Se houver uma frase forte seguida de uma conclusão, prefira manter o contexto completo.

IMPORTANTE:

Os campos start e end devem ser números em segundos.

Exemplo:

{
  "start": 125.5,
  "end": 174.2
}

Retorne somente os dados solicitados pelo schema.

Não escreva explicações fora do JSON.
`.trim();
}

/* ============================================================
   GEMINI OUTPUT
   ============================================================ */

function extractGeminiOutputText(
  data
) {
  if (!data) {
    return "";
  }

  if (
    typeof data.output_text ===
      "string" &&
    data.output_text.trim()
  ) {
    return data.output_text.trim();
  }

  if (
    typeof data.outputText ===
      "string" &&
    data.outputText.trim()
  ) {
    return data.outputText.trim();
  }

  if (
    Array.isArray(
      data.outputs
    )
  ) {
    for (
      const output of
        data.outputs
    ) {
      if (!output) continue;

      if (
        typeof output.text ===
          "string" &&
        output.text.trim()
      ) {
        return output.text.trim();
      }

      if (
        Array.isArray(
          output.content
        )
      ) {
        for (
          const content of
            output.content
        ) {
          if (
            typeof content?.text ===
              "string" &&
            content.text.trim()
          ) {
            return content.text.trim();
          }
        }
      }
    }
  }

  if (
    Array.isArray(data.steps)
  ) {
    for (
      const step of data.steps
    ) {
      if (!step) continue;

      if (
        typeof step.text ===
          "string" &&
        step.text.trim()
      ) {
        return step.text.trim();
      }

      if (
        Array.isArray(
          step.content
        )
      ) {
        for (
          const content of
            step.content
        ) {
          if (
            typeof content?.text ===
              "string" &&
            content.text.trim()
          ) {
            return content.text.trim();
          }
        }
      }

      if (
        step.type ===
          "model_output" &&
        Array.isArray(
          step.content
        )
      ) {
        const text =
          step.content
            .filter(
              (content) =>
                content?.type ===
                  "text" &&
                typeof content.text ===
                  "string"
            )
            .map(
              (content) =>
                content.text
            )
            .join("")
            .trim();

        if (text) {
          return text;
        }
      }
    }
  }

  if (
    Array.isArray(
      data.candidates
    )
  ) {
    const candidate =
      data.candidates[0];

    if (
      candidate?.content?.parts
    ) {
      return candidate.content.parts
        .map(
          (part) =>
            part?.text || ""
        )
        .join("")
        .trim();
    }
  }

  return "";
}

/* ============================================================
   JSON
   ============================================================ */

function extractJsonFromText(
  text
) {
  if (!text) {
    return null;
  }

  let value =
    String(text).trim();

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

  try {
    return JSON.parse(
      value
    );
  } catch {}

  const first =
    value.indexOf("{");

  const last =
    value.lastIndexOf("}");

  if (
    first !== -1 &&
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
   NORMALIZAÇÃO DOS CORTES
   ============================================================ */

function normalizarClips(
  clips,
  options = {}
) {
  if (
    !Array.isArray(clips)
  ) {
    return [];
  }

  const requestedMin =
    Number(
      options.minDuration ||
        20
    );

  const requestedMax =
    Number(
      options.maxDuration ||
        60
    );

  const minDuration =
    Math.min(
      requestedMin,
      requestedMax
    );

  const maxDuration =
    Math.max(
      requestedMin,
      requestedMax
    );

  const maxClips =
    Number(
      options.maxClips ||
        5
    );

  const normalized = [];

  for (
    const clip of clips
  ) {
    if (!clip) {
      continue;
    }

    let start =
      Number(
        clip.start ??
          clip.inicio ??
          0
      );

    let end =
      Number(
        clip.end ??
          clip.fim ??
          start + 50
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
        minDuration;
    }

    if (
      duration >
      maxDuration
    ) {
      end =
        start +
        maxDuration;

      duration =
        maxDuration;
    }

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
            "Corte selecionado"
        ).slice(
          0,
          140
        ),

      description:
        safeString(
          clip.description ||
            ""
        ).slice(
          0,
          500
        ),

      score:
        clampNumber(
          clip.score,
          0,
          100,
          80
        ),

      reason:
        safeString(
          clip.reason ||
            "Destaque selecionado por IA"
        ).slice(
          0,
          500
        ),
    });
  }

  normalized.sort(
    (a, b) =>
      b.score - a.score
  );

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

    if (!overlap) {
      result.push(
        clip
      );
    }

    if (
      result.length >=
      maxClips
    ) {
      break;
    }
  }

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
      "GEMINI_API_KEY não configurada no servidor."
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

  /**
   * Interactions API:
   *
   * input pode conter texto + vídeo.
   *
   * O response_format abaixo solicita JSON
   * estruturado de acordo com o schema.
   */

  const body = {
    model:
      GEMINI_MODEL,

    input: [
      {
        type: "text",
        text: prompt,
      },

      {
        type: "video",
        uri: youtubeUrl,
        mime_type: "video/mp4",
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

            Accept:
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
        ? JSON.parse(
            rawText
          )
        : null;
  } catch {}

  if (!response.ok) {
    metrics.geminiFailures++;

    throw new Error(
      `Gemini HTTP ${response.status}: ${redactSecrets(
        rawText
      ).slice(
        0,
        1200
      )}`
    );
  }

  const outputText =
    extractGeminiOutputText(
      data
    );

  if (!outputText) {
    metrics.geminiFailures++;

    throw new Error(
      "Gemini não retornou texto estruturado válido."
    );
  }

  const parsed =
    extractJsonFromText(
      outputText
    );

  if (!parsed) {
    metrics.geminiFailures++;

    throw new Error(
      "Não foi possível extrair o JSON dos cortes da resposta do Gemini."
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
   PROCESSOS
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

            windowsHide: true,
          }
        );

      let stdout = "";
      let stderr = "";

      child.stdout.on(
        "data",
        (chunk) => {
          stdout +=
            chunk.toString();

          if (
            stdout.length >
            2_000_000
          ) {
            stdout =
              stdout.slice(
                -2_000_000
              );
          }
        }
      );

      child.stderr.on(
        "data",
        (chunk) => {
          stderr +=
            chunk.toString();

          if (
            stderr.length >
            2_000_000
          ) {
            stderr =
              stderr.slice(
                -2_000_000
              );
          }
        }
      );

      let finished =
        false;

      const timeout =
        setTimeout(
          () => {
            if (finished) {
              return;
            }

            finished = true;

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
          if (finished) {
            return;
          }

          finished = true;

          clearTimeout(
            timeout
          );

          reject(error);
        }
      );

      child.on(
        "close",
        (code) => {
          if (finished) {
            return;
          }

          finished = true;

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
        "format=duration,format_name",

        "-of",
        "json",

        inputPath,
      ],
      {
        timeout: 60000,
      }
    );

  if (
    result.code !== 0
  ) {
    return {
      duration: null,
      format: null,
    };
  }

  try {
    const data =
      JSON.parse(
        result.stdout
      );

    const duration =
      Number(
        data?.format?.duration
      );

    return {
      duration:
        Number.isFinite(
          duration
        )
          ? duration
          : null,

      format:
        data?.format
          ?.format_name ||
        null,
    };
  } catch {
    return {
      duration: null,
      format: null,
    };
  }
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
  metrics.ffmpegAttempts++;

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

  console.log(
    `[FFmpeg] Início=${safeStart.toFixed(
      2
    )}s duração=${safeDuration.toFixed(
      2
    )}s`
  );

  const result =
    await runCommand(
      FFMPEG_PATH,
      [
        "-y",

        "-hide_banner",

        "-loglevel",
        "error",

        /*
         * Busca rápida para cortes.
         */
        "-ss",
        safeStart.toFixed(3),

        "-i",
        inputPath,

        "-t",
        safeDuration.toFixed(3),

        /*
         * Mapeia vídeo obrigatório.
         * Áudio opcional.
         */
        "-map",
        "0:v:0",

        "-map",
        "0:a:0?",

        /*
         * H.264 amplamente compatível.
         */
        "-c:v",
        "libx264",

        "-preset",
        "veryfast",

        "-crf",
        "23",

        "-pix_fmt",
        "yuv420p",

        /*
         * Áudio AAC.
         */
        "-c:a",
        "aac",

        "-b:a",
        "128k",

        "-ar",
        "44100",

        /*
         * Compatibilidade com navegadores.
         */
        "-movflags",
        "+faststart",

        "-avoid_negative_ts",
        "make_zero",

        outputPath,
      ],
      {
        timeout: 300000,
      }
    );

  if (
    result.code !== 0
  ) {
    metrics.ffmpegFailures++;

    throw new Error(
      `FFmpeg falhou: ${redactSecrets(
        result.stderr
      ).slice(-1800)}`
    );
  }

  if (
    !fs.existsSync(
      outputPath
    )
  ) {
    metrics.ffmpegFailures++;

    throw new Error(
      "FFmpeg terminou sem criar o arquivo MP4."
    );
  }

  const stat =
    await fsp.stat(
      outputPath
    );

  if (
    stat.size < 10000
  ) {
    metrics.ffmpegFailures++;

    throw new Error(
      "FFmpeg finalizou, mas gerou um arquivo corrompido ou vazio."
    );
  }

  /*
   * Validação final do MP4.
   */
  try {
    const validation =
      await validateVideoFile(
        outputPath
      );

    console.log(
      `[FFmpeg] MP4 validado: ${validation.size} bytes | ${validation.duration.toFixed(
        2
      )}s | ${validation.videoCodec} | áudio=${
        validation.hasAudio
          ? "sim"
          : "não"
      }`
    );
  } catch (error) {
    metrics.ffmpegFailures++;

    throw new Error(
      `MP4 final inválido após FFmpeg: ${error.message}`
    );
  }

  console.log(
    `[FFmpeg] Corte criado com sucesso: ${stat.size} bytes`
  );

  return outputPath;
}

/* ============================================================
   STREAM DOWNLOAD HELPER
   ============================================================ */

async function saveResponseToFile(
  response,
  outputPath
) {
  if (!response.body) {
    throw new Error(
      "Resposta não possui corpo de download."
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
    !fs.existsSync(
      outputPath
    )
  ) {
    throw new Error(
      "Arquivo não foi criado após o download."
    );
  }
}

/* ============================================================
   DOWNLOADER EXTERNO
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
              "application/json, video/mp4, video/*, application/octet-stream",

            ...(EXTERNAL_DOWNLOAD_TOKEN
              ? {
                  Authorization:
                    `Bearer ${EXTERNAL_DOWNLOAD_TOKEN}`,
                }
              : {}),
          },

          body:
            JSON.stringify({
              url: youtubeUrl,
              videoId,
              output: "mp4",
            }),

          signal:
            AbortSignal.timeout(
              180000
            ),
        }
      );
  } catch (error) {
    metrics.externalDownloadFailures++;

    throw new Error(
      `Downloader externo conexão: ${error.message}`
    );
  }

  if (
    !response.ok
  ) {
    metrics.externalDownloadFailures++;

    const errorText =
      await response
        .text()
        .catch(
          () => ""
        );

    throw new Error(
      `Downloader externo HTTP ${response.status}: ${redactSecrets(
        errorText
      ).slice(0, 800)}`
    );
  }

  const contentType =
    (
      response.headers.get(
        "content-type"
      ) || ""
    ).toLowerCase();

  /*
   * CASO 1:
   * O serviço devolveu diretamente o vídeo.
   */
  if (
    contentType.includes(
      "video/"
    ) ||
    contentType.includes(
      "application/octet-stream"
    )
  ) {
    await saveResponseToFile(
      response,
      outputPath
    );

    try {
      const validation =
        await validateVideoFile(
          outputPath
        );

      console.log(
        `[External] Vídeo validado: ${validation.size} bytes`
      );

      return outputPath;
    } catch (error) {
      metrics.externalDownloadFailures++;

      await safeRemove(
        outputPath
      );

      throw new Error(
        `Downloader externo retornou arquivo inválido: ${error.message}`
      );
    }
  }

  /*
   * CASO 2:
   * O serviço devolveu JSON com URL.
   */

  let data;

  try {
    data =
      await response.json();
  } catch (error) {
    metrics.externalDownloadFailures++;

    throw new Error(
      `Downloader externo não retornou JSON válido: ${error.message}`
    );
  }

  const downloadUrl =
    data?.url ||
    data?.downloadUrl ||
    data?.download_url ||
    data?.result?.url ||
    data?.result?.downloadUrl ||
    data?.data?.url ||
    data?.data?.downloadUrl ||
    data?.video?.url ||
    data?.video?.downloadUrl;

  if (!downloadUrl) {
    metrics.externalDownloadFailures++;

    throw new Error(
      "Downloader externo não retornou URL de download."
    );
  }

  let downloadResponse;

  try {
    downloadResponse =
      await fetch(
        downloadUrl,
        {
          method: "GET",

          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",

            Accept:
              "video/mp4,video/*,application/octet-stream,*/*",
          },

          redirect:
            "follow",

          signal:
            AbortSignal.timeout(
              180000
            ),
        }
      );
  } catch (error) {
    metrics.externalDownloadFailures++;

    throw new Error(
      `Stream externo conexão: ${error.message}`
    );
  }

  if (
    !downloadResponse.ok
  ) {
    metrics.externalDownloadFailures++;

    throw new Error(
      `Stream externo HTTP ${downloadResponse.status}`
    );
  }

  await saveResponseToFile(
    downloadResponse,
    outputPath
  );

  try {
    const validation =
      await validateVideoFile(
        outputPath
      );

    console.log(
      `[External] Stream validado: ${validation.size} bytes`
    );

    return outputPath;
  } catch (error) {
    metrics.externalDownloadFailures++;

    await safeRemove(
      outputPath
    );

    throw new Error(
      `Stream externo retornou arquivo inválido: ${error.message}`
    );
  }
}

/* ============================================================
   RAPIDAPI
   ============================================================ */

async function downloadWithRapidApi({
  videoId,
  outputPath,
}) {
  if (!RAPIDAPI_KEY) {
    throw new Error(
      "RapidAPI não configurada."
    );
  }

  metrics.rapidApiAttempts++;

  const endpoint =
    `https://${RAPIDAPI_HOST}/dl?id=${encodeURIComponent(
      videoId
    )}&cgeo=BR`;

  console.log(
    `[RapidAPI] Solicitando vídeo ${videoId}...`
  );

  let response;

  try {
    response =
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
  } catch (error) {
    metrics.rapidApiFailures++;

    throw new Error(
      `RapidAPI conexão: ${error.message}`
    );
  }

  /*
   * 429 = rate limit.
   */
  if (
    response.status === 429
  ) {
    metrics.rapidApiRateLimited++;

    const retryAfter =
      response.headers.get(
        "retry-after"
      );

    throw new Error(
      `RapidAPI_RATE_LIMITED${
        retryAfter
          ? ` (Retry-After: ${retryAfter})`
          : ""
      }`
    );
  }

  if (
    !response.ok
  ) {
    metrics.rapidApiFailures++;

    const errorText =
      await response
        .text()
        .catch(
          () => ""
        );

    throw new Error(
      `RapidAPI HTTP ${response.status}: ${redactSecrets(
        errorText
      ).slice(0, 800)}`
    );
  }

  let data;

  try {
    data =
      await response.json();
  } catch (error) {
    metrics.rapidApiFailures++;

    throw new Error(
      `RapidAPI retornou resposta inválida: ${error.message}`
    );
  }

  /*
   * ==========================================================
   * Encontrar URLs de mídia.
   * ==========================================================
   */

  const candidates = [];

  function collectUrls(
    value,
    parentKey = ""
  ) {
    if (!value) {
      return;
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
        candidates.push({
          url: value,
          source:
            parentKey,
        });
      }

      return;
    }

    if (
      Array.isArray(value)
    ) {
      for (
        const item of value
      ) {
        collectUrls(
          item,
          parentKey
        );
      }

      return;
    }

    if (
      typeof value ===
      "object"
    ) {
      for (
        const [
          key,
          item,
        ] of Object.entries(
          value
        )
      ) {
        if (
          typeof item ===
            "string" &&
          /^https?:\/\//i.test(
            item
          )
        ) {
          candidates.push({
            url: item,
            source: key,
          });
        } else {
          collectUrls(
            item,
            key
          );
        }
      }
    }
  }

  collectUrls(data);

  /*
   * Remove URLs duplicadas.
   */
  const uniqueCandidates =
    [
      ...new Map(
        candidates.map(
          (item) => [
            item.url,
            item,
          ]
        )
      ).values(),
    ];

  /*
   * Ordena candidatas com palavras mais relacionadas
   * a vídeo/download primeiro.
   */
  uniqueCandidates.sort(
    (a, b) => {
      const score =
        (item) => {
          const source =
            safeString(
              item.source
            ).toLowerCase();

          let value = 0;

          if (
            source.includes(
              "download"
            )
          ) {
            value += 5;
          }

          if (
            source.includes(
              "video"
            )
          ) {
            value += 4;
          }

          if (
            source.includes(
              "mp4"
            )
          ) {
            value += 4;
          }

          if (
            source.includes(
              "stream"
            )
          ) {
            value += 3;
          }

          if (
            source.includes(
              "url"
            )
          ) {
            value += 1;
          }

          return value;
        };

      return (
        score(b) -
        score(a)
      );
    }
  );

  console.log(
    `[RapidAPI] URLs encontradas: ${uniqueCandidates.length}`
  );

  if (
    !uniqueCandidates.length
  ) {
    metrics.rapidApiFailures++;

    throw new Error(
      "RapidAPI não forneceu URLs de mídia."
    );
  }

  let lastError =
    "Nenhuma stream acessível.";

  /*
   * Limita o número de candidatas para evitar
   * ficar testando URLs irrelevantes.
   */
  const candidatesToTest =
    uniqueCandidates.slice(
      0,
      20
    );

  for (
    const candidate of
      candidatesToTest
  ) {
    try {
      console.log(
        `[RapidAPI] Testando stream: ${
          candidate.source ||
          "url"
        }`
      );

      const streamResponse =
        await fetch(
          candidate.url,
          {
            method: "GET",

            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",

              Accept:
                "video/mp4,video/*,application/octet-stream,*/*",
            },

            redirect:
              "follow",

            signal:
              AbortSignal.timeout(
                120000
              ),
          }
        );

      console.log(
        `[RapidAPI] Stream HTTP ${streamResponse.status}`
      );

      if (
        !streamResponse.ok
      ) {
        lastError =
          `Stream HTTP ${streamResponse.status}`;

        continue;
      }

      if (
        !streamResponse.body
      ) {
        lastError =
          "Stream sem corpo.";

        continue;
      }

      await saveResponseToFile(
        streamResponse,
        outputPath
      );

      try {
        const validation =
          await validateVideoFile(
            outputPath
          );

        console.log(
          `[RapidAPI] Download validado: ${validation.size} bytes | ${validation.duration.toFixed(
            2
          )}s`
        );

        return outputPath;
      } catch (validationError) {
        lastError =
          `Arquivo inválido: ${validationError.message}`;

        await safeRemove(
          outputPath
        );

        continue;
      }
    } catch (error) {
      lastError =
        error.message;

      await safeRemove(
        outputPath
      );
    }
  }

  metrics.rapidApiFailures++;

  throw new Error(
    `RapidAPI não conseguiu baixar um vídeo válido: ${lastError}`
  );
}

/* ============================================================
   YT-DLP
   ============================================================ */

async function downloadWithYtDlp({
  youtubeUrl,
  outputPath,
}) {
  metrics.ytdlpAttempts++;

  if (
    !fs.existsSync(
      YTDLP_PATH
    )
  ) {
    metrics.ytdlpFailures++;

    throw new Error(
      `yt-dlp não encontrado em ${YTDLP_PATH}`
    );
  }

  const args = [
    "--no-playlist",

    "--no-warnings",

    "--newline",

    "--restrict-filenames",

    "--no-check-certificates",

    /*
     * Prioriza MP4 + M4A.
     * Depois tenta um MP4 único.
     * Por último aceita melhor formato disponível.
     */
    "-f",
    "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",

    "--merge-output-format",
    "mp4",

    "-o",
    outputPath,
  ];

  if (
    YTDLP_COOKIES_FILE &&
    fs.existsSync(
      YTDLP_COOKIES_FILE
    )
  ) {
    args.push(
      "--cookies",
      YTDLP_COOKIES_FILE
    );

    console.log(
      "[YT-DLP] Cookies configurados."
    );
  }

  args.push(
    youtubeUrl
  );

  console.log(
    `[YT-DLP] Executável: ${YTDLP_PATH}`
  );

  console.log(
    "[YT-DLP] Iniciando fallback..."
  );

  const result =
    await runCommand(
      YTDLP_PATH,
      args,
      {
        timeout: 300000,
      }
    );

  const combined =
    `${result.stdout}\n${result.stderr}`;

  if (
    result.code !== 0
  ) {
    metrics.ytdlpFailures++;

    if (
      /sign in to confirm|not a bot|login_required|cookies-from-browser|cookies for the authentication|confirm you're not a bot/i.test(
        combined
      )
    ) {
      metrics.ytdlpAntiBot++;

      throw new Error(
        "O YouTube bloqueou o yt-dlp com proteção anti-bot. O servidor precisa de uma fonte de download alternativa ou cookies válidos do YouTube."
      );
    }

    if (
      /\b403\b/.test(
        combined
      )
    ) {
      throw new Error(
        "O YouTube retornou HTTP 403 ao yt-dlp."
      );
    }

    throw new Error(
      `yt-dlp código ${result.code}: ${redactSecrets(
        result.stderr
      ).slice(-1600)}`
    );
  }

  if (
    !fs.existsSync(
      outputPath
    )
  ) {
    metrics.ytdlpFailures++;

    throw new Error(
      "yt-dlp terminou sem gerar o arquivo MP4."
    );
  }

  try {
    const validation =
      await validateVideoFile(
        outputPath
      );

    console.log(
      `[YT-DLP] Vídeo validado: ${validation.size} bytes | ${validation.duration.toFixed(
        2
      )}s | ${validation.videoCodec}`
    );

    return outputPath;
  } catch (error) {
    metrics.ytdlpFailures++;

    await safeRemove(
      outputPath
    );

    throw new Error(
      `yt-dlp gerou arquivo inválido: ${error.message}`
    );
  }
}

/* ============================================================
   PIPELINE DE DOWNLOAD
   ============================================================ */

async function downloadOriginalVideo({
  youtubeUrl,
  videoId,
}) {
  const outputPath =
    path.join(
      DOWNLOAD_DIR,
      `${sanitizeFilename(
        videoId
      )}-${Date.now()}.mp4`
    );

  const failures = [];

  /*
   * ==========================================================
   * 1. DOWNLOADER EXTERNO
   * ==========================================================
   */

  if (
    EXTERNAL_DOWNLOAD_URL
  ) {
    try {
      console.log(
        "[Download] 1/3 Tentando downloader externo..."
      );

      await downloadWithExternalService({
        youtubeUrl,
        videoId,
        outputPath,
      });

      console.log(
        "[Download] Downloader externo funcionou e o vídeo foi validado."
      );

      return {
        path:
          outputPath,

        method:
          "external",
      };
    } catch (error) {
      const message =
        error.message;

      failures.push(
        `Externo: ${message}`
      );

      console.log(
        `[Download] Externo falhou: ${message}`
      );

      await safeRemove(
        outputPath
      );
    }
  }

  /*
   * ==========================================================
   * 2. RAPIDAPI
   * ==========================================================
   */

  if (
    RAPIDAPI_KEY
  ) {
    try {
      console.log(
        "[Download] 2/3 Tentando RapidAPI..."
      );

      await downloadWithRapidApi({
        videoId,
        outputPath,
      });

      console.log(
        "[Download] RapidAPI funcionou e o vídeo foi validado."
      );

      return {
        path:
          outputPath,

        method:
          "rapidapi",
      };
    } catch (error) {
      const message =
        error.message;

      failures.push(
        `RapidAPI: ${message}`
      );

      if (
        message.startsWith(
          "RapidAPI_RATE_LIMITED"
        )
      ) {
        console.log(
          "[Download] RapidAPI está limitada (429). Pulando imediatamente para yt-dlp..."
        );
      } else {
        console.log(
          `[Download] RapidAPI falhou: ${message}`
        );
      }

      await safeRemove(
        outputPath
      );
    }
  }

  /*
   * ==========================================================
   * 3. YT-DLP
   * ==========================================================
   */

  try {
    console.log(
      "[Download] 3/3 Ativando fallback yt-dlp..."
    );

    await downloadWithYtDlp({
      youtubeUrl,
      outputPath,
    });

    console.log(
      "[Download] yt-dlp funcionou e o vídeo foi validado."
    );

    return {
      path:
        outputPath,

      method:
        "yt-dlp",
    };
  } catch (error) {
    const message =
      error.message;

    failures.push(
      `yt-dlp: ${message}`
    );

    await safeRemove(
      outputPath
    );

    /*
     * ========================================================
     * ERRO FINAL
     * ========================================================
     */

    const hasRateLimit =
      failures.some(
        (item) =>
          item.includes(
            "RapidAPI_RATE_LIMITED"
          )
      );

    const hasAntiBot =
      failures.some(
        (item) =>
          item.includes(
            "proteção anti-bot"
          )
      );

    if (
      hasRateLimit &&
      hasAntiBot
    ) {
      throw new Error(
        "Não foi possível baixar o vídeo. A RapidAPI atingiu o limite de requisições (429) e o YouTube bloqueou o yt-dlp por proteção anti-bot. Configure EXTERNAL_DOWNLOAD_URL ou forneça cookies válidos do YouTube em YTDLP_COOKIES_FILE."
      );
    }

    throw new Error(
      `Todos os métodos de download falharam. ${failures.join(
        " | "
      )}`
    );
  }
}

/* ============================================================
   HEALTH
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

      frontend: {
        configured:
          Boolean(
            FRONTEND_URL
          ),

        url:
          FRONTEND_URL ||
          null,

        allowedOrigins:
          ALLOWED_ORIGINS,
      },

      downloaders: {
        external:
          Boolean(
            EXTERNAL_DOWNLOAD_URL
          ),

        rapidapi:
          Boolean(
            RAPIDAPI_KEY
          ),

        ytdlp:
          fs.existsSync(
            YTDLP_PATH
          ),

        cookies:
          Boolean(
            YTDLP_COOKIES_FILE &&
            fs.existsSync(
              YTDLP_COOKIES_FILE
            )
          ),

        ffmpeg:
          FFMPEG_PATH,

        ffprobe:
          FFPROBE_PATH,
      },

      metrics,
    });
  }
);

/* ============================================================
   LOGIN
   ============================================================ */

app.post(
  "/api/auth/login",
  (req, res) => {
    const userId =
      safeString(
        req.body?.userId ||
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
    res.json({
      ok: true,

      user:
        req.user,
    });
  }
);

/* ============================================================
   ANALISAR
   ============================================================ */

app.post(
  "/api/analisar",
  async (req, res) => {
    metrics.analyses++;

    const user =
      resolveRequestUser(req) ||
      getOrCreateUser(
        randomId("user_")
      );

    const rawUrl =
      req.body?.url ||
      req.body?.youtubeUrl ||
      req.body?.videoUrl;

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
        req.body?.maxClips,
        1,
        10,
        5
      );

    let minDuration =
      clampNumber(
        req.body?.minDuration,
        10,
        120,
        20
      );

    let maxDuration =
      clampNumber(
        req.body?.maxDuration,
        20,
        180,
        60
      );

    if (
      maxDuration <
      minDuration
    ) {
      const temp =
        minDuration;

      minDuration =
        maxDuration;

      maxDuration =
        temp;
    }

    console.log(
      "=========================================="
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

    console.log(
      `[Análise] Clips: ${maxClips}`
    );

    console.log(
      `[Análise] Duração: ${minDuration}-${maxDuration}s`
    );

    console.log(
      `[Gemini] Modelo: ${GEMINI_MODEL}`
    );

    try {
      const result =
        await analisarComGemini({
          youtubeUrl:
            normalized.url,

          videoId:
            normalized.videoId,

          maxClips,

          minDuration,

          maxDuration,
        });

      user.analyses++;

      user.lastAnalysisAt =
        new Date().toISOString();

      metrics.analysisSuccess++;

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
        },
      });
    } catch (error) {
      metrics.analysisFailures++;

      console.error(
        `[Análise] Erro: ${redactSecrets(
          error.message
        )}`
      );

      return res.status(500).json({
        ok: false,

        error:
          redactSecrets(
            error.message
          ) ||
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
   DOWNLOAD / RENDER
   ============================================================ */

app.post(
  "/api/download",
  async (req, res) => {
    metrics.downloads++;

    const user =
      resolveRequestUser(req) ||
      getOrCreateUser(
        randomId("user_")
      );

    const rawUrl =
      req.body?.url ||
      req.body?.youtubeUrl ||
      req.body?.videoUrl;

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
        req.body?.start ??
          req.body?.inicio,

        0,
        86400,
        0
      );

    const duration =
      clampNumber(
        req.body?.duration ??
          req.body?.duracao,

        1,
        180,
        60
      );

    let original =
      null;

    let clipPath =
      null;

    try {
      console.log(
        "=========================================="
      );

      console.log(
        `[Download] CLIPFORGE ${APP_VERSION}`
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
        `[Download] Duração solicitada: ${duration}s`
      );

      original =
        await downloadOriginalVideo({
          youtubeUrl:
            normalized.url,

          videoId:
            normalized.videoId,
        });

      console.log(
        `[Download] Método escolhido: ${original.method}`
      );

      /*
       * Validação adicional antes do FFmpeg.
       */
      const originalValidation =
        await validateVideoFile(
          original.path
        );

      console.log(
        `[Download] Original validado: ${originalValidation.size} bytes | ${originalValidation.duration.toFixed(
          2
        )}s`
      );

      let actualDuration =
        duration;

      if (
        Number.isFinite(
          originalValidation.duration
        )
      ) {
        if (
          start >=
          originalValidation.duration
        ) {
          throw new Error(
            "O tempo inicial solicitado está além da duração total do vídeo."
          );
        }

        actualDuration =
          Math.min(
            actualDuration,
            originalValidation.duration -
              start
          );
      }

      if (
        actualDuration <= 0
      ) {
        throw new Error(
          "A duração calculada do corte é inválida."
        );
      }

      const filename =
        `clip-${sanitizeFilename(
          normalized.videoId
        )}-${Date.now()}.mp4`;

      clipPath =
        path.join(
          OUTPUT_DIR,
          filename
        );

      console.log(
        `[FFmpeg] Renderizando ${filename}...`
      );

      await renderClip({
        inputPath:
          original.path,

        outputPath:
          clipPath,

        start,

        duration:
          actualDuration,
      });

      user.downloads++;

      user.lastDownloadAt =
        new Date().toISOString();

      metrics.downloadSuccess++;

      console.log(
        `[Download] Corte pronto: ${filename}`
      );

      /*
       * O original pode ser apagado antes do envio,
       * pois o MP4 final já está pronto.
       */
      await safeRemove(
        original.path
      );

      original = null;

      return res.download(
        clipPath,
        filename,
        async (error) => {
          await safeRemove(
            clipPath
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

      await safeRemove(
        clipPath
      );

      if (original) {
        await safeRemove(
          original.path
        );
      }

      console.error(
        `[Download] Erro: ${redactSecrets(
          error.message
        )}`
      );

      return res.status(500).json({
        ok: false,

        error:
          redactSecrets(
            error.message
          ) ||
          "Falha ao renderizar o corte.",

        code:
          "DOWNLOAD_FAILED",

        version:
          APP_VERSION,
      });
    }
  }
);

/* ============================================================
   MERCADO PAGO - PIX
   ============================================================ */

app.post(
  "/api/pix/criar",
  async (req, res) => {
    const user =
      resolveRequestUser(req) ||
      getOrCreateUser(
        randomId("user_")
      );

    if (!MP_ACCESS_TOKEN) {
      return res.status(503).json({
        ok: false,

        error:
          "Mercado Pago não configurado.",
      });
    }

    const amount =
      Number(
        req.body?.amount ??
          req.body?.valor ??
          19.9
      );

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return res.status(400).json({
        ok: false,

        error:
          "Valor inválido.",
      });
    }

    try {
      const externalReference =
        `clipforge-${user.id}-${randomId()}`;

      const mpRes =
        await fetch(
          "https://api.mercadopago.com/v1/payments",
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${MP_ACCESS_TOKEN}`,

              "Content-Type":
                "application/json",

              "X-Idempotency-Key":
                randomId("mp_"),
            },

            body:
              JSON.stringify({
                transaction_amount:
                  Number(
                    amount.toFixed(
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
                  email:
                    `user-${user.id}@clipforge.local`,
                },
              }),
          }
        );

      const data =
        await mpRes.json();

      if (
        !mpRes.ok
      ) {
        throw new Error(
          data.message ||
            "Erro Mercado Pago."
        );
      }

      const transactionData =
        data
          .point_of_interaction
          ?.transaction_data ||
        {};

      const paymentId =
        String(
          data.id
        );

      payments.set(
        paymentId,
        {
          id:
            paymentId,

          userId:
            user.id,

          status:
            data.status,

          externalReference,

          createdAt:
            new Date().toISOString(),
        }
      );

      metrics.pixCreated++;

      return res.json({
        ok: true,

        id:
          paymentId,

        paymentId,

        status:
          data.status,

        qr_code:
          transactionData.qr_code,

        qrCode:
          transactionData.qr_code,

        qr_code_base64:
          transactionData.qr_code_base64,

        qrCodeBase64:
          transactionData.qr_code_base64,

        ticket_url:
          transactionData.ticket_url,

        ticketUrl:
          transactionData.ticket_url,
      });
    } catch (error) {
      metrics.pixRejected++;

      console.error(
        `[Mercado Pago] ${redactSecrets(
          error.message
        )}`
      );

      return res.status(500).json({
        ok: false,

        error:
          redactSecrets(
            error.message
          ) ||
          "Erro ao criar pagamento PIX.",
      });
    }
  }
);

/* ============================================================
   MERCADO PAGO - STATUS
   ============================================================ */

app.get(
  "/api/pix/status/:id",
  async (req, res) => {
    if (!MP_ACCESS_TOKEN) {
      return res.status(503).json({
        ok: false,

        error:
          "Mercado Pago não configurado.",
      });
    }

    const paymentId =
      encodeURIComponent(
        req.params.id
      );

    try {
      const response =
        await fetch(
          `https://api.mercadopago.com/v1/payments/${paymentId}`,
          {
            headers: {
              Authorization:
                `Bearer ${MP_ACCESS_TOKEN}`,
            },

            signal:
              AbortSignal.timeout(
                30000
              ),
          }
        );

      const data =
        await response.json();

      if (
        !response.ok
      ) {
        throw new Error(
          data.message ||
            `Mercado Pago HTTP ${response.status}`
        );
      }

      if (
        data.status ===
        "approved"
      ) {
        const payment =
          payments.get(
            String(
              req.params.id
            )
          );

        if (
          payment?.userId
        ) {
          const user =
            users.get(
              payment.userId
            );

          if (user) {
            if (!user.vip) {
              metrics.pixApproved++;
            }

            user.vip = true;

            payment.status =
              "approved";
          }
        }
      }

      return res.json({
        ok: true,

        id:
          data.id,

        status:
          data.status,

        approved:
          data.status ===
          "approved",
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,

        error:
          redactSecrets(
            error.message
          ) ||
          "Erro ao consultar pagamento.",
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
    if (!ADMIN_PASSWORD) {
      return res.status(503).json({
        ok: false,

        error:
          "ADMIN_PASSWORD não definida.",
      });
    }

    const {
      username,
      password,
    } =
      req.body || {};

    if (
      username !==
        ADMIN_USER ||
      password !==
        ADMIN_PASSWORD
    ) {
      return res.status(401).json({
        ok: false,

        error:
          "Credenciais inválidas.",
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
    res.json({
      ok: true,

      version:
        APP_VERSION,

      server: {
        uptime:
          process.uptime(),

        node:
          process.version,

        platform:
          process.platform,

        memory:
          process.memoryUsage(),
      },

      configuration: {
        gemini:
          Boolean(
            GEMINI_API_KEY
          ),

        rapidapi:
          Boolean(
            RAPIDAPI_KEY
          ),

        externalDownloader:
          Boolean(
            EXTERNAL_DOWNLOAD_URL
          ),

        ytdlp:
          fs.existsSync(
            YTDLP_PATH
          ),

        ffmpeg:
          FFMPEG_PATH,

        ffprobe:
          FFPROBE_PATH,

        mercadoPago:
          Boolean(
            MP_ACCESS_TOKEN
          ),
      },

      metrics,

      usersCount:
        users.size,

      sessionsCount:
        sessions.size,

      paymentsCount:
        payments.size,
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
      redactSecrets(
        error?.stack ||
          error?.message ||
          String(error)
      )
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    res.status(500).json({
      ok: false,

      error:
        redactSecrets(
          error?.message
        ) ||
        "Erro interno do servidor.",
    });
  }
);

/* ============================================================
   START
   ============================================================ */

async function startServer() {
  await ensureDirectories();

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
    30 *
      60 *
      1000
  );

  /*
   * Verificações de ferramentas.
   *
   * Não interrompem o servidor caso alguma
   * ferramenta esteja ausente.
   */
  console.log(
    ""
  );

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
    `Gemini Endpoint: ${GEMINI_ENDPOINT}`
  );

  console.log(
    "Gemini API: Interactions API"
  );

  console.log(
    `RapidAPI: ${
      RAPIDAPI_KEY
        ? "CONFIGURADO"
        : "NÃO CONFIGURADO"
    }`
  );

  console.log(
    `yt-dlp: ${
      fs.existsSync(
        YTDLP_PATH
      )
        ? YTDLP_PATH
        : "NÃO ENCONTRADO"
    }`
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
    `Frontend URL: ${
      FRONTEND_URL ||
      "não definida"
    }`
  );

  console.log(
    `YTDLP cookies: ${
      YTDLP_COOKIES_FILE &&
      fs.existsSync(
        YTDLP_COOKIES_FILE
      )
        ? "CONFIGURADOS"
        : "NÃO CONFIGURADOS"
    }`
  );

  console.log(
    "===================================================="
  );

  console.log(
    "[Gemini] Análise direta de URLs públicas do YouTube ativa."
  );

  console.log(
    "[Download] Externo -> RapidAPI -> yt-dlp fallback ativo."
  );

  console.log(
    "[Download] Todo arquivo baixado passa por validação FFprobe."
  );

  console.log(
    "[Download] Arquivos HTML/JSON disfarçados de MP4 são rejeitados."
  );

  console.log(
    "[Download] RapidAPI 429 será tratado como rate limit."
  );

  console.log(
    "[FFmpeg] Saída final H.264 + AAC + yuv420p + faststart."
  );

  console.log(
    "===================================================="
  );

  console.log(
    ""
  );

  app.listen(
    PORT,
    HOST,
    () => {
      console.log(
        `CLIPFORGE PRO ${APP_VERSION} online em http://${HOST}:${PORT}`
      );
    }
  );
}

startServer()
  .catch(
    (error) => {
      console.error(
        "[FATAL] Erro ao iniciar servidor:",
        redactSecrets(
          error?.stack ||
            error?.message ||
            String(error)
        )
      );

      process.exit(1);
    }
  );