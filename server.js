/**
 * ============================================================
 * CLIPFORGE PRO — BACKEND 13.2.8
 * Node.js + Express
 *
 * CORREÇÕES PRINCIPAIS:
 * ------------------------------------------------------------
 * - Gemini Files API REST corrigida
 * - Normalização segura de files/{id}
 * - Polling com validação HTTP real
 * - Detecção explícita de FAILED
 * - Logs detalhados do processamento Gemini
 * - Upload do MP4 via stream, sem carregar arquivo inteiro
 *   na memória
 * - Timeout independente para upload e processamento
 * - Mantém compatibilidade com frontend 13.x
 * - /api/download retorna MP4 binário diretamente
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
const multer = require("multer");

const app = express();

/* ============================================================
   CONFIGURAÇÃO GERAL
============================================================ */

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";

const VERSION = "13.2.8";

const FREE_POINTS = Number(process.env.FREE_POINTS || 200);
const DAILY_POINTS = Number(process.env.DAILY_POINTS || 50);
const DOWNLOAD_COST = Number(process.env.DOWNLOAD_COST || 50);
const VIP_PRICE = Number(process.env.VIP_PRICE || 19.90);
const MAX_CLIPS = Number(process.env.MAX_CLIPS || 5);

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 150);
const MAX_UPLOAD_BYTES = Math.floor(MAX_UPLOAD_MB * 1024 * 1024);

const UPLOAD_TTL_MS = Number(
  process.env.UPLOAD_TTL_MS || 2 * 60 * 60 * 1000
);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const ADMIN_TOKEN_TTL = 24 * 60 * 60 * 1000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

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

const GEMINI_FALLBACK_MODELS = (
  process.env.GEMINI_FALLBACK_MODELS ||
  "gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash"
)
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean)
  .filter((v, i, arr) => arr.indexOf(v) === i)
  .filter((v) => v !== GEMINI_MODEL);

const GEMINI_INTERACTIONS_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

const GEMINI_FILES_UPLOAD_URL =
  "https://generativelanguage.googleapis.com/upload/v1beta/files";

const GEMINI_FILES_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/files";

/*
 * Timeouts específicos.
 *
 * Upload:
 * - 15 min para enviar o arquivo ao Gemini.
 *
 * Polling:
 * - 10 min aguardando ACTIVE.
 *
 * Interactions:
 * - 120 segundos por análise.
 */
const GEMINI_UPLOAD_TIMEOUT_MS =
  Number(process.env.GEMINI_UPLOAD_TIMEOUT_MS || 15 * 60 * 1000);

const GEMINI_FILE_PROCESS_TIMEOUT_MS =
  Number(
    process.env.GEMINI_FILE_PROCESS_TIMEOUT_MS ||
    10 * 60 * 1000
  );

const GEMINI_POLL_INTERVAL_MS =
  Number(process.env.GEMINI_POLL_INTERVAL_MS || 3000);

const GEMINI_INTERACTION_TIMEOUT_MS =
  Number(
    process.env.GEMINI_INTERACTION_TIMEOUT_MS ||
    120000
  );

function getGeminiErrorStatus(err) {
  const candidates = [
    err?.status,
    err?.code,
    err?.response?.status,
    err?.response?.statusCode,
    err?.error?.status,
    err?.error?.code,
  ];

  for (const value of candidates) {
    const n = Number(value);

    if (
      Number.isFinite(n) &&
      n >= 100 &&
      n <= 599
    ) {
      return n;
    }
  }

  const message = String(err?.message || "");

  const match = message.match(
    /\b(400|401|403|404|408|409|429|500|502|503|504)\b/
  );

  return match ? Number(match[1]) : 0;
}

/* ============================================================
   RAPIDAPI / DOWNLOADERS
============================================================ */

const RAPIDAPI_KEY =
  process.env.RAPIDAPI_KEY ||
  process.env.X_RAPIDAPI_KEY ||
  "";

const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST ||
  "youtube-media-downloader.p.rapidapi.com";

const EXTERNAL_DOWNLOAD_URL =
  process.env.EXTERNAL_DOWNLOAD_URL || "";

const EXTERNAL_DOWNLOAD_TOKEN =
  process.env.EXTERNAL_DOWNLOAD_TOKEN || "";

/* ============================================================
   MERCADO PAGO
============================================================ */

const MP_ACCESS_TOKEN =
  process.env.MP_ACCESS_TOKEN ||
  process.env.MERCADOPAGO_ACCESS_TOKEN ||
  "";

const MP_API_URL =
  process.env.MP_API_URL ||
  "https://api.mercadopago.com";

/* ============================================================
   DIRETÓRIOS
============================================================ */

const TEMP_ROOT =
  path.join(os.tmpdir(), "clipforge-pro");

const DOWNLOAD_DIR =
  path.join(TEMP_ROOT, "downloads");

const OUTPUT_DIR =
  path.join(TEMP_ROOT, "outputs");

const UPLOAD_DIR =
  path.join(TEMP_ROOT, "uploads");

const YTDLP_COOKIES_FILE =
  process.env.YTDLP_COOKIES_FILE ||
  path.join(TEMP_ROOT, "youtube-cookies.txt");

/* ============================================================
   ESTADO EM MEMÓRIA
============================================================ */

const sessions = new Map();
const adminSessions = new Map();
const users = new Map();
const payments = new Map();
const uploads = new Map();

const metrics = {
  requests: 0,

  uploads: 0,

  analyses: 0,
  uploadAnalyses: 0,
  youtubeAnalyses: 0,

  downloads: 0,
  uploadDownloads: 0,
  youtubeDownloads: 0,

  pixCreated: 0,
  pixApproved: 0,

  geminiRetries: 0,
  geminiFallbacks: 0,
  geminiFileUploads: 0,

  errors: 0,
};

/* ============================================================
   EXPRESS / CORS
============================================================ */

app.disable("x-powered-by");

app.set("trust proxy", 1);

app.use(
  cors({
    origin: true,
    credentials: false,

    methods: [
      "GET",
      "POST",
      "DELETE",
      "OPTIONS",
    ],

    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-User-Id",
    ],

    exposedHeaders: [
      "Content-Disposition",
      "Content-Length",
    ],
  })
);

app.use(
  express.json({
    limit: "10mb",
  })
);

app.use(
  express.urlencoded({
    extended: false,
    limit: "10mb",
  })
);

app.use((req, res, next) => {
  metrics.requests++;

  res.setHeader(
    "X-ClipForge-Version",
    VERSION
  );

  next();
});

/* ============================================================
   MULTER
============================================================ */

const uploadStorage =
  multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, UPLOAD_DIR);
    },

    filename: (req, file, cb) => {
      cb(
        null,
        `${crypto.randomUUID()}.mp4`
      );
    },
  });

const videoUpload = multer({
  storage: uploadStorage,

  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },

  fileFilter: (req, file, cb) => {
    const originalName =
      String(file.originalname || "")
        .toLowerCase();

    const mime =
      String(file.mimetype || "")
        .toLowerCase();

    const validExtension =
      originalName.endsWith(".mp4");

    const validMime =
      mime === "video/mp4" ||
      mime === "application/mp4" ||
      mime === "application/octet-stream" ||
      mime.startsWith("video/");

    if (
      validExtension ||
      validMime
    ) {
      return cb(null, true);
    }

    return cb(
      new Error(
        "Somente arquivos MP4 são aceitos."
      )
    );
  },
});

/* ============================================================
   HELPERS
============================================================ */

function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

function randomToken(bytes = 32) {
  return crypto
    .randomBytes(bytes)
    .toString("hex");
}

function safeUserId(value) {
  if (!value) return null;

  const v = String(value).trim();

  return /^[A-Za-z0-9_-]{6,128}$/.test(v)
    ? v
    : null;
}

function safeUploadId(value) {
  if (!value) return null;

  const v = String(value).trim();

  return /^[a-f0-9-]{20,100}$/i.test(v)
    ? v
    : null;
}

function parseNumber(
  value,
  fallback = 0
) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function clamp(
  value,
  min,
  max
) {
  return Math.min(
    max,
    Math.max(min, value)
  );
}

function jsonError(
  res,
  status,
  message,
  extra = {}
) {
  return res
    .status(status)
    .json({
      error: message,
      ...extra,
    });
}

function redactSecrets(text) {
  let val = String(text || "");

  const secrets = [
    GEMINI_API_KEY,
    RAPIDAPI_KEY,
    MP_ACCESS_TOKEN,
    ADMIN_PASSWORD,
  ].filter(Boolean);

  for (const secret of secrets) {
    try {
      val = val.replace(
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

  return val;
}

async function safeRemove(filePath) {
  if (!filePath) return;

  try {
    await fsp.rm(filePath, {
      force: true,
      recursive: true,
    });
  } catch {}
}

async function cleanup(...files) {
  await Promise.all(
    files
      .filter(Boolean)
      .map((file) => safeRemove(file))
  );
}

/* ============================================================
   YOUTUBE
============================================================ */

function youtubeIdFromUrl(value) {
  if (!value) return null;

  const input = String(value).trim();

  if (
    /^[A-Za-z0-9_-]{11}$/.test(input)
  ) {
    return input;
  }

  const patterns = [
    /(?:youtube\.com\/watch\?[^#]*?v=)([A-Za-z0-9_-]{11})/i,
    /(?:youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/i,
    /(?:youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/i,
    /(?:youtube\.com\/live\/)([A-Za-z0-9_-]{11})/i,
    /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/i,
  ];

  for (const pattern of patterns) {
    const match =
      input.match(pattern);

    if (match) {
      return match[1];
    }
  }

  return null;
}

function youtubeUrl(value) {
  const id =
    youtubeIdFromUrl(value);

  return id
    ? `https://www.youtube.com/watch?v=${id}`
    : null;
}

/* ============================================================
   PROCESSOS
============================================================ */

function spawnCapture(
  command,
  args,
  options = {}
) {
  return new Promise(
    (resolve, reject) => {
      const {
        timeout = 0,
        ...spawnOptions
      } = options;

      const child = spawn(
        command,
        args,
        {
          windowsHide: true,
          ...spawnOptions,
        }
      );

      let stdout = "";
      let stderr = "";

      let timedOut = false;

      let termTimer = null;
      let killTimer = null;

      child.stdout?.on(
        "data",
        (data) => {
          stdout += data.toString();

          if (stdout.length > 500000) {
            stdout =
              stdout.slice(-500000);
          }
        }
      );

      child.stderr?.on(
        "data",
        (data) => {
          stderr += data.toString();

          if (stderr.length > 500000) {
            stderr =
              stderr.slice(-500000);
          }
        }
      );

      child.on(
        "error",
        (err) => {
          if (termTimer) {
            clearTimeout(termTimer);
          }

          if (killTimer) {
            clearTimeout(killTimer);
          }

          reject(err);
        }
      );

      child.on(
        "close",
        (code, signal) => {
          if (termTimer) {
            clearTimeout(termTimer);
          }

          if (killTimer) {
            clearTimeout(killTimer);
          }

          resolve({
            code:
              Number.isInteger(code)
                ? code
                : -1,

            signal:
              signal || null,

            stdout,
            stderr,
            timedOut,
          });
        }
      );

      if (
        Number.isFinite(timeout) &&
        timeout > 0
      ) {
        termTimer = setTimeout(
          () => {
            timedOut = true;

            console.warn(
              `[Process] Timeout de ${timeout}ms: ${command}`
            );

            try {
              child.kill("SIGTERM");
            } catch {}

            killTimer = setTimeout(
              () => {
                try {
                  child.kill("SIGKILL");
                } catch {}
              },
              4000
            );
          },
          timeout
        );
      }
    }
  );
}

async function commandExists(
  command
) {
  try {
    const isYtDlp =
      String(command)
        .toLowerCase()
        .includes("yt-dlp");

    const testArgs = isYtDlp
      ? ["--version"]
      : ["-version"];

    const result =
      await spawnCapture(
        command,
        testArgs,
        {
          timeout: 15000,
        }
      );

    return result.code === 0;
  } catch {
    return false;
  }
}

let FFMPEG_BIN = "ffmpeg";
let FFPROBE_BIN = "ffprobe";
let YTDLP_BIN = "yt-dlp";

async function resolveExecutable(
  label,
  candidates
) {
  for (const candidate of candidates) {
    if (!candidate) continue;

    const val =
      String(candidate).trim();

    if (!val) continue;

    if (fs.existsSync(val)) {
      try {
        fs.chmodSync(
          val,
          0o755
        );
      } catch {}
    }

    if (
      await commandExists(val)
    ) {
      console.log(
        `[Binary] ${label} encontrado: ${val}`
      );

      return val;
    }
  }

  return null;
}

async function resolveBinaries() {
  let installerFfmpeg = null;
  let staticFfmpeg = null;
  let installerFfprobe = null;

  try {
    installerFfmpeg =
      require(
        "@ffmpeg-installer/ffmpeg"
      ).path;
  } catch {}

  try {
    staticFfmpeg =
      require("ffmpeg-static");
  } catch {}

  try {
    installerFfprobe =
      require(
        "@ffprobe-installer/ffprobe"
      ).path;
  } catch {}

  FFMPEG_BIN =
    (await resolveExecutable(
      "FFmpeg",
      [
        path.join(
          process.cwd(),
          "bin",
          "ffmpeg"
        ),

        process.env.FFMPEG_PATH,
        process.env.FFMPEG_BIN,

        installerFfmpeg,
        staticFfmpeg,

        "ffmpeg",
      ]
    )) || "ffmpeg";

  FFPROBE_BIN =
    (await resolveExecutable(
      "FFprobe",
      [
        path.join(
          process.cwd(),
          "bin",
          "ffprobe"
        ),

        process.env.FFPROBE_PATH,
        process.env.FFPROBE_BIN,

        installerFfprobe,

        "ffprobe",
      ]
    )) || "ffprobe";

  YTDLP_BIN =
    (await resolveExecutable(
      "yt-dlp",
      [
        path.join(
          process.cwd(),
          "bin",
          "yt-dlp"
        ),

        process.env.YTDLP_PATH,
        process.env.YTDLP_BIN,

        path.join(
          process.cwd(),
          "yt-dlp"
        ),

        "yt-dlp",
      ]
    )) || "yt-dlp";
}

/* ============================================================
   DIRETÓRIOS
============================================================ */

async function ensureDirectories() {
  await fsp.mkdir(
    TEMP_ROOT,
    { recursive: true }
  );

  await fsp.mkdir(
    DOWNLOAD_DIR,
    { recursive: true }
  );

  await fsp.mkdir(
    OUTPUT_DIR,
    { recursive: true }
  );

  await fsp.mkdir(
    UPLOAD_DIR,
    { recursive: true }
  );
}

/* ============================================================
   VALIDAÇÃO DE VÍDEO
============================================================ */

async function probeVideoDetails(
  filePath
) {
  const probe =
    await spawnCapture(
      FFPROBE_BIN,
      [
        "-v",
        "error",

        "-show_entries",
        "format=duration,format_name",

        "-show_entries",
        "stream=index,codec_type,codec_name,width,height",

        "-of",
        "json",

        filePath,
      ],
      {
        timeout: 30000,
      }
    );

  if (probe.code !== 0) {
    throw new Error(
      `FFprobe rejeitou o arquivo: ${
        redactSecrets(
          probe.stderr
        ).slice(-700)
      }`
    );
  }

  let data;

  try {
    data =
      JSON.parse(probe.stdout);
  } catch {
    throw new Error(
      "FFprobe retornou dados inválidos."
    );
  }

  const duration =
    Number(
      data?.format?.duration
    );

  if (
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    throw new Error(
      "Duração de vídeo inválida."
    );
  }

  const streams =
    Array.isArray(data?.streams)
      ? data.streams
      : [];

  const videoStream =
    streams.find(
      (s) =>
        s?.codec_type === "video"
    );

  const audioStream =
    streams.find(
      (s) =>
        s?.codec_type === "audio"
    );

  return {
    duration,

    format:
      data?.format?.format_name ||
      null,

    videoCodec:
      videoStream?.codec_name ||
      null,

    width:
      Number(videoStream?.width) ||
      null,

    height:
      Number(videoStream?.height) ||
      null,

    audioCodec:
      audioStream?.codec_name ||
      null,
  };
}

async function validateVideoFile(
  filePath
) {
  if (
    !filePath ||
    !fs.existsSync(filePath)
  ) {
    throw new Error(
      "Arquivo não encontrado."
    );
  }

  const stat =
    await fsp.stat(filePath);

  if (stat.size < 10000) {
    throw new Error(
      `Arquivo muito pequeno (${stat.size} bytes).`
    );
  }

  const details =
    await probeVideoDetails(
      filePath
    );

  return {
    duration: details.duration,
    size: stat.size,
    ...details,
  };
}

/* ============================================================
   UPLOADS
============================================================ */

function getOwnedUpload(
  uploadId,
  userId
) {
  const id =
    safeUploadId(uploadId);

  if (!id) {
    throw new Error(
      "uploadId inválido."
    );
  }

  const item =
    uploads.get(id);

  if (!item) {
    throw new Error(
      "Upload não encontrado ou expirado."
    );
  }

  if (item.userId !== userId) {
    throw new Error(
      "Esse vídeo não pertence a esta conta."
    );
  }

  if (
    !fs.existsSync(item.path)
  ) {
    uploads.delete(id);

    throw new Error(
      "O arquivo enviado não está mais disponível."
    );
  }

  return item;
}

async function cleanupExpiredUploads() {
  const cutoff =
    now() - UPLOAD_TTL_MS;

  for (
    const [id, item]
    of uploads.entries()
  ) {
    if (
      item.createdAt < cutoff
    ) {
      await safeRemove(
        item.path
      );

      uploads.delete(id);
    }
  }
}

setInterval(
  () => {
    cleanupExpiredUploads()
      .catch(console.error);
  },
  10 * 60 * 1000
).unref?.();

/* ============================================================
   AUTENTICAÇÃO
============================================================ */

function ensureUser(userId) {
  const id =
    safeUserId(userId) ||
    crypto.randomUUID();

  let user =
    users.get(id);

  if (!user) {
    user = {
      id,

      points: FREE_POINTS,

      vip: false,

      createdAt: now(),

      lastDailyClaim: now(),

      downloads: 0,

      analyses: 0,
    };

    users.set(id, user);
  }

  claimDailyPoints(user);

  return user;
}

function claimDailyPoints(user) {
  const day =
    new Date()
      .toISOString()
      .slice(0, 10);

  const prev =
    user.lastDailyClaim
      ? new Date(
          user.lastDailyClaim
        )
          .toISOString()
          .slice(0, 10)
      : "";

  if (day !== prev) {
    user.points += DAILY_POINTS;

    user.lastDailyClaim =
      now();
  }
}

function publicUser(user) {
  return {
    id: user.id,

    points:
      Math.max(
        0,
        Math.floor(
          user.points
        )
      ),

    vip:
      Boolean(user.vip),
  };
}

function getBearer(req) {
  const header =
    req.headers.authorization ||
    "";

  return header
    .toLowerCase()
    .startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
}

function requireUser(
  req,
  res,
  next
) {
  let user = null;

  const token =
    getBearer(req);

  if (token) {
    const session =
      sessions.get(token);

    if (
      session &&
      session.expiresAt > now()
    ) {
      user =
        users.get(
          session.userId
        ) || null;
    }
  }

  if (!user) {
    const legacyId =
      safeUserId(
        req.headers["x-user-id"]
      );

    if (legacyId) {
      user =
        users.get(
          legacyId
        ) || null;
    }
  }

  if (!user) {
    return jsonError(
      res,
      401,
      "Sessão inválida ou expirada."
    );
  }

  req.user = user;

  next();
}

function requireAdmin(
  req,
  res,
  next
) {
  const token =
    getBearer(req);

  const session =
    adminSessions.get(token);

  if (
    !session ||
    session.expiresAt <= now()
  ) {
    if (session) {
      adminSessions.delete(token);
    }

    return jsonError(
      res,
      401,
      "Sessão administrativa expirada ou inválida."
    );
  }

  next();
}

/* ============================================================
   GEMINI SCHEMA
============================================================ */

const CLIPS_SCHEMA = {
  type: "object",

  properties: {
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

          duration: {
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
        },

        required: [
          "start",
          "end",
          "duration",
          "title",
          "description",
          "score",
        ],
      },
    },
  },

  required: [
    "clips",
  ],
};

/* ============================================================
   NORMALIZAÇÃO GEMINI
============================================================ */

function normalizeGeminiClips(
  parsed
) {
  if (
    !parsed ||
    !Array.isArray(
      parsed.clips
    )
  ) {
    throw new Error(
      "Gemini não retornou a lista de clips."
    );
  }

  const clips =
    parsed.clips
      .map((c, i) => {
        const start =
          Math.max(
            0,
            parseNumber(
              c.start,
              0
            )
          );

        const rawDur =
          parseNumber(
            c.duration,
            parseNumber(
              c.end,
              start + 50
            ) - start
          );

        const duration =
          clamp(
            rawDur,
            20,
            60
          );

        return {
          start:
            Number(
              start.toFixed(2)
            ),

          end:
            Number(
              (
                start +
                duration
              ).toFixed(2)
            ),

          duration:
            Number(
              duration.toFixed(2)
            ),

          title:
            String(
              c.title ||
              `Corte #${i + 1}`
            ).slice(0, 140),

          description:
            String(
              c.description ||
              "Destaque selecionado por IA"
            ).slice(0, 500),

          score:
            clamp(
              Math.round(
                parseNumber(
                  c.score,
                  80
                )
              ),
              0,
              100
            ),
        };
      })
      .filter(
        (c) =>
          c.duration >= 20 &&
          c.duration <= 60
      )
      .slice(0, MAX_CLIPS);

  if (!clips.length) {
    throw new Error(
      "Gemini não encontrou cortes válidos."
    );
  }

  return clips;
}

function parseGeminiOutput(
  outputText,
  model
) {
  let outText =
    String(outputText || "")
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

  if (!outText) {
    throw new Error(
      `Gemini (${model}) não retornou conteúdo.`
    );
  }

  let parsed;

  try {
    parsed =
      JSON.parse(outText);
  } catch {
    const match =
      outText.match(
        /\{[\s\S]*\}/
      );

    if (!match) {
      throw new Error(
        `Gemini (${model}) não retornou JSON estruturado.`
      );
    }

    parsed =
      JSON.parse(match[0]);
  }

  return normalizeGeminiClips(
    parsed
  );
}

function buildClipPrompt(
  duration
) {
  return `
Você é o motor de seleção de cortes do ClipForge Pro.

Analise integralmente o vídeo enviado.

Duração aproximada:
${Number(duration || 0).toFixed(2)} segundos.

Encontre até ${MAX_CLIPS} momentos ideais para Shorts, TikTok e Reels.

Cada corte deve ter entre 20 e 60 segundos.

Priorize:

- falas de impacto;
- ganchos fortes;
- momentos emocionais;
- informações surpreendentes;
- narrativas completas;
- contexto preservado;
- começo que desperte interesse;
- final que faça sentido.

Evite:

- introduções vazias;
- silêncios longos;
- trechos sem contexto;
- cortes no meio de frases;
- momentos sem potencial de retenção.

Retorne SOMENTE o JSON estruturado de acordo com o schema solicitado.
`.trim();
}

/* ============================================================
   GEMINI FILES API
============================================================ */

/*
 * O Gemini pode retornar:
 *
 * files/abc123
 *
 * ou:
 *
 * abc123
 *
 * Para a chamada:
 *
 * GET /v1beta/files/abc123
 *
 * precisamos utilizar apenas o ID.
 */
function normalizeGeminiFileName(
  value
) {
  if (!value) return null;

  let name =
    String(value).trim();

  name =
    name.replace(
      /^\/+/,
      ""
    );

  name =
    name.replace(
      /^files\//i,
      ""
    );

  name =
    name.replace(
      /\/+$/,
      ""
    );

  if (!name) {
    return null;
  }

  return name;
}

function getGeminiFileStatusUrl(
  fileName
) {
  const id =
    normalizeGeminiFileName(
      fileName
    );

  if (!id) {
    throw new Error(
      "Nome do arquivo Gemini inválido."
    );
  }

  return `${GEMINI_FILES_API_URL}/${encodeURIComponent(id)}`;
}

/*
 * Extrai estado do objeto retornado pela Files API.
 */
function getGeminiFileState(
  data
) {
  const candidates = [
    data?.state,
    data?.file?.state,
    data?.resource?.state,
  ];

  for (const candidate of candidates) {
    if (candidate) {
      return String(candidate)
        .trim()
        .toUpperCase();
    }
  }

  return "";
}

/*
 * Extrai erro do Gemini Files API.
 */
function getGeminiFileError(
  data
) {
  return (
    data?.error?.message ||
    data?.error?.status ||
    data?.file?.error?.message ||
    data?.file?.error ||
    data?.message ||
    ""
  );
}

/*
 * Upload resumable + stream.
 */
async function uploadVideoToGemini(
  filePath
) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY não configurada."
    );
  }

  if (
    !filePath ||
    !fs.existsSync(filePath)
  ) {
    throw new Error(
      "Arquivo para Gemini não encontrado."
    );
  }

  const stat =
    await fsp.stat(filePath);

  if (!stat.size) {
    throw new Error(
      "Arquivo para Gemini está vazio."
    );
  }

  console.log(
    "===================================================="
  );

  console.log(
    `[Gemini Files] Iniciando upload: ${path.basename(filePath)}`
  );

  console.log(
    `[Gemini Files] Tamanho: ${(stat.size / 1024 / 1024).toFixed(2)} MB`
  );

  console.log(
    `[Gemini Files] Upload resumable: ATIVO`
  );

  /* --------------------------------------------------------
     ETAPA 1 — iniciar sessão resumable
  -------------------------------------------------------- */

  let initRes;

  try {
    initRes =
      await fetch(
        GEMINI_FILES_UPLOAD_URL,
        {
          method: "POST",

          headers: {
            "x-goog-api-key":
              GEMINI_API_KEY,

            "X-Goog-Upload-Protocol":
              "resumable",

            "X-Goog-Upload-Command":
              "start",

            "X-Goog-Upload-Header-Content-Length":
              String(stat.size),

            "X-Goog-Upload-Header-Content-Type":
              "video/mp4",

            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            file: {
              display_name:
                path.basename(
                  filePath
                ),
            },
          }),

          signal:
            AbortSignal.timeout(
              60000
            ),
        }
      );
  } catch (err) {
    if (
      err?.name ===
      "TimeoutError"
    ) {
      throw new Error(
        "Gemini Files demorou mais de 60 segundos para iniciar o upload."
      );
    }

    throw err;
  }

  if (!initRes.ok) {
    const errText =
      await initRes
        .text()
        .catch(() => "");

    throw new Error(
      `Falha ao iniciar upload Gemini: HTTP ${initRes.status} — ${
        redactSecrets(
          errText
        ).slice(-700)
      }`
    );
  }

  const uploadUrl =
    initRes.headers.get(
      "x-goog-upload-url"
    );

  if (!uploadUrl) {
    throw new Error(
      "Header x-goog-upload-url não retornado pelo Gemini."
    );
  }

  console.log(
    "[Gemini Files] Sessão resumable criada."
  );

  /* --------------------------------------------------------
     ETAPA 2 — enviar arquivo por STREAM
  -------------------------------------------------------- */

  let uploadRes;

  const fileStream =
    fs.createReadStream(
      filePath
    );

  try {
    uploadRes =
      await fetch(
        uploadUrl,
        {
          method: "POST",

          headers: {
            "Content-Length":
              String(stat.size),

            "X-Goog-Upload-Offset":
              "0",

            "X-Goog-Upload-Command":
              "upload, finalize",
          },

          body: fileStream,

          /*
           * Necessário para enviar Readable
           * como body no Node fetch.
           */
          duplex: "half",

          signal:
            AbortSignal.timeout(
              GEMINI_UPLOAD_TIMEOUT_MS
            ),
        }
      );
  } catch (err) {
    try {
      fileStream.destroy();
    } catch {}

    if (
      err?.name ===
      "TimeoutError"
    ) {
      throw new Error(
        `Upload do vídeo ao Gemini excedeu ${Math.round(
          GEMINI_UPLOAD_TIMEOUT_MS / 60000
        )} minutos.`
      );
    }

    throw new Error(
      `Falha de rede durante upload Gemini: ${err.message}`
    );
  }

  if (!uploadRes.ok) {
    const errText =
      await uploadRes
        .text()
        .catch(() => "");

    throw new Error(
      `Erro ao enviar bytes para Gemini: HTTP ${uploadRes.status} — ${
        redactSecrets(
          errText
        ).slice(-700)
      }`
    );
  }

  let fileData;

  try {
    fileData =
      await uploadRes.json();
  } catch {
    throw new Error(
      "Gemini retornou uma resposta inválida após o upload."
    );
  }

  const fileObject =
    fileData?.file ||
    fileData?.resource ||
    fileData;

  const fileUri =
    fileObject?.uri;

  const originalFileName =
    fileObject?.name;

  if (
    !fileUri ||
    !originalFileName
  ) {
    console.error(
      "[Gemini Files] Resposta inesperada:"
    );

    console.error(
      JSON.stringify(
        fileData,
        null,
        2
      ).slice(-4000)
    );

    throw new Error(
      "Gemini Files API não retornou URI/nome válido do arquivo."
    );
  }

  const normalizedFileName =
    normalizeGeminiFileName(
      originalFileName
    );

  if (!normalizedFileName) {
    throw new Error(
      "Não foi possível normalizar o nome do arquivo Gemini."
    );
  }

  metrics.geminiFileUploads++;

  console.log(
    `[Gemini Files] Arquivo criado: ${originalFileName}`
  );

  console.log(
    `[Gemini Files] ID normalizado: ${normalizedFileName}`
  );

  console.log(
    `[Gemini Files] URI: ${fileUri}`
  );

  /* --------------------------------------------------------
     ETAPA 3 — polling até ACTIVE
  -------------------------------------------------------- */

  const startedAt =
    Date.now();

  let lastState = "";
  let pollCount = 0;

  while (true) {
    const elapsed =
      Date.now() -
      startedAt;

    if (
      elapsed >
      GEMINI_FILE_PROCESS_TIMEOUT_MS
    ) {
      throw new Error(
        `Gemini demorou mais de ${Math.round(
          GEMINI_FILE_PROCESS_TIMEOUT_MS / 60000
        )} minutos para processar o vídeo. Último estado: ${
          lastState || "DESCONHECIDO"
        }.`
      );
    }

    pollCount++;

    const statusUrl =
      getGeminiFileStatusUrl(
        normalizedFileName
      );

    let checkRes;

    try {
      checkRes =
        await fetch(
          statusUrl,
          {
            method: "GET",

            headers: {
              "x-goog-api-key":
                GEMINI_API_KEY,

              Accept:
                "application/json",
            },

            signal:
              AbortSignal.timeout(
                30000
              ),
          }
        );
    } catch (err) {
      console.warn(
        `[Gemini Files] Poll ${pollCount}: erro de rede: ${err.message}`
      );

      await sleep(
        GEMINI_POLL_INTERVAL_MS
      );

      continue;
    }

    const rawCheck =
      await checkRes
        .text()
        .catch(() => "");

    let checkData;

    try {
      checkData =
        rawCheck
          ? JSON.parse(rawCheck)
          : {};
    } catch {
      checkData = {
        raw: rawCheck,
      };
    }

    /*
     * IMPORTANTE:
     *
     * Antes o código ignorava 404/500 aqui.
     *
     * Agora qualquer HTTP não-2xx
     * vira erro explícito.
     */
    if (!checkRes.ok) {
      const detail =
        getGeminiFileError(
          checkData
        ) ||
        redactSecrets(
          rawCheck
        ).slice(-500) ||
        "Resposta sem detalhes.";

      throw new Error(
        `Gemini Files HTTP ${checkRes.status} ao consultar arquivo "${normalizedFileName}": ${detail}`
      );
    }

    const state =
      getGeminiFileState(
        checkData
      );

    const elapsedSeconds =
      Math.floor(
        elapsed / 1000
      );

    if (
      state !== lastState
    ) {
      console.log(
        `[Gemini Files] Estado mudou: ${
          lastState || "INICIAL"
        } → ${state || "DESCONHECIDO"} (${elapsedSeconds}s)`
      );

      lastState = state;
    } else {
      console.log(
        `[Gemini Files] Poll #${pollCount} — estado ${
          state || "DESCONHECIDO"
        } — ${elapsedSeconds}s`
      );
    }

    /* ------------------------------------------------------
       ACTIVE
    ------------------------------------------------------ */

    if (
      state === "ACTIVE"
    ) {
      console.log(
        `[Gemini Files] Vídeo pronto após ${elapsedSeconds}s.`
      );

      console.log(
        `[Gemini Files] URI final: ${fileUri}`
      );

      console.log(
        "===================================================="
      );

      return {
        uri: fileUri,

        name:
          originalFileName,

        id:
          normalizedFileName,

        mimeType:
          fileObject?.mimeType ||
          "video/mp4",
      };
    }

    /* ------------------------------------------------------
       FAILED
    ------------------------------------------------------ */

    if (
      state === "FAILED" ||
      state === "ERROR"
    ) {
      const detail =
        getGeminiFileError(
          checkData
        ) ||
        "Gemini informou falha no processamento do vídeo.";

      console.error(
        `[Gemini Files] PROCESSAMENTO FALHOU: ${detail}`
      );

      throw new Error(
        `Gemini falhou ao processar o vídeo: ${detail}`
      );
    }

    /* ------------------------------------------------------
       CANCELLED / EXPIRED
    ------------------------------------------------------ */

    if (
      state === "CANCELLED" ||
      state === "CANCELED" ||
      state === "EXPIRED"
    ) {
      throw new Error(
        `Gemini não concluiu o processamento. Estado: ${state}.`
      );
    }

    await sleep(
      GEMINI_POLL_INTERVAL_MS
    );
  }
}

/* ============================================================
   GEMINI INTERACTIONS
============================================================ */

async function requestGeminiInteraction(
  model,
  input,
  prompt
) {
  const body = {
    model,

    input: [
      ...input,

      {
        type: "text",
        text: prompt,
      },
    ],

    generation_config: {
      thinking_level:
        "low",

      response_mime_type:
        "application/json",

      response_schema:
        CLIPS_SCHEMA,
    },
  };

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => {
        controller.abort();
      },
      GEMINI_INTERACTION_TIMEOUT_MS
    );

  let response;

  try {
    response =
      await fetch(
        GEMINI_INTERACTIONS_URL,
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
            JSON.stringify(
              body
            ),

          signal:
            controller.signal,
        }
      );
  } catch (err) {
    if (
      err?.name ===
        "AbortError" ||
      err?.name ===
        "TimeoutError"
    ) {
      const e =
        new Error(
          `Gemini (${model}) excedeu o tempo limite de ${Math.round(
            GEMINI_INTERACTION_TIMEOUT_MS / 1000
          )} segundos.`
        );

      e.status = 504;

      throw e;
    }

    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text =
    await response
      .text()
      .catch(() => "");

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    const detail =
      data?.error?.message ||
      data?.message ||
      "Erro na API Gemini.";

    const err =
      new Error(
        `Gemini HTTP ${response.status}: ${detail}`
      );

    err.status =
      response.status;

    throw err;
  }

  let outText =
    data?.output_text ||
    data?.outputText ||
    data?.text ||
    "";

  if (
    !outText &&
    Array.isArray(
      data?.steps
    )
  ) {
    for (
      const step of data.steps
    ) {
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
            content?.text
          ) {
            outText +=
              content.text +
              "\n";
          }
        }
      }
    }
  }

  if (!outText) {
    outText =
      JSON.stringify(data);
  }

  return {
    clips:
      parseGeminiOutput(
        outText,
        model
      ),

    model,

    fallback:
      model !== GEMINI_MODEL,
  };
}

async function analyzeWithGeminiFallback(
  input,
  prompt
) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY não configurada."
    );
  }

  const models = [
    GEMINI_MODEL,
    ...GEMINI_FALLBACK_MODELS,
  ];

  let lastError =
    null;

  for (
    let i = 0;
    i < models.length;
    i++
  ) {
    const model =
      models[i];

    console.log(
      `[Gemini] Tentando ${model} (${i + 1}/${models.length})...`
    );

    try {
      const result =
        await requestGeminiInteraction(
          model,
          input,
          prompt
        );

      if (
        model !== GEMINI_MODEL
      ) {
        metrics.geminiFallbacks++;
      }

      console.log(
        `[Gemini] Sucesso com ${model}.`
      );

      return result;
    } catch (err) {
      lastError =
        err;

      const status =
        getGeminiErrorStatus(
          err
        );

      console.warn(
        `[Gemini] ${model} falhou: HTTP ${
          status || "N/A"
        } — ${err.message}`
      );

      /*
       * Esses erros não devem
       * tentar modelos diferentes.
       */
      if (
        status === 400 ||
        status === 401 ||
        status === 403
      ) {
        throw err;
      }

      if (
        i <
        models.length - 1
      ) {
        metrics.geminiRetries++;

        await sleep(600);
      }
    }
  }

  throw (
    lastError ||
    new Error(
      "Gemini indisponível no momento."
    )
  );
}

/* ============================================================
   DOWNLOAD DO YOUTUBE
============================================================ */

async function downloadOriginalVideo(
  url,
  videoId,
  workDir
) {
  const outputPath =
    path.join(
      workDir,
      "source.mp4"
    );

  /* --------------------------------------------------------
     Downloader externo
  -------------------------------------------------------- */

  if (
    EXTERNAL_DOWNLOAD_URL
  ) {
    try {
      const response =
        await fetch(
          EXTERNAL_DOWNLOAD_URL,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",

              ...(EXTERNAL_DOWNLOAD_TOKEN
                ? {
                    Authorization:
                      `Bearer ${EXTERNAL_DOWNLOAD_TOKEN}`,
                  }
                : {}),
            },

            body:
              JSON.stringify({
                url,
                videoId,
                output: "mp4",
              }),

            signal:
              AbortSignal.timeout(
                180000
              ),
          }
        );

      if (
        response.ok &&
        response.body
      ) {
        await pipeline(
          Readable.fromWeb(
            response.body
          ),
          fs.createWriteStream(
            outputPath
          )
        );

        await validateVideoFile(
          outputPath
        );

        return outputPath;
      }
    } catch {
      await safeRemove(
        outputPath
      );
    }
  }

  /* --------------------------------------------------------
     RapidAPI
  -------------------------------------------------------- */

  if (RAPIDAPI_KEY) {
    try {
      const endpoint =
        `https://${RAPIDAPI_HOST}/dl?id=${encodeURIComponent(
          videoId
        )}&cgeo=BR`;

      const response =
        await fetch(
          endpoint,
          {
            headers: {
              "x-rapidapi-key":
                RAPIDAPI_KEY,

              "x-rapidapi-host":
                RAPIDAPI_HOST,
            },

            signal:
              AbortSignal.timeout(
                60000
              ),
          }
        );

      if (response.ok) {
        const data =
          await response.json();

        const urls = [];

        const collectUrls =
          (value) => {
            if (
              !value ||
              typeof value !==
                "object"
            ) {
              return;
            }

            if (
              typeof value.url ===
                "string" &&
              value.url.startsWith(
                "http"
              )
            ) {
              urls.push(
                value.url
              );
            }

            for (
              const key of Object.keys(
                value
              )
            ) {
              collectUrls(
                value[key]
              );
            }
          };

        collectUrls(data);

        for (
          const streamUrl
          of [
            ...new Set(urls),
          ].slice(0, 5)
        ) {
          try {
            const streamRes =
              await fetch(
                streamUrl,
                {
                  signal:
                    AbortSignal.timeout(
                      120000
                    ),
                }
              );

            if (
              !streamRes.ok ||
              !streamRes.body
            ) {
              continue;
            }

            await pipeline(
              Readable.fromWeb(
                streamRes.body
              ),
              fs.createWriteStream(
                outputPath
              )
            );

            await validateVideoFile(
              outputPath
            );

            return outputPath;
          } catch {
            await safeRemove(
              outputPath
            );
          }
        }
      }
    } catch {
      await safeRemove(
        outputPath
      );
    }
  }

  /* --------------------------------------------------------
     yt-dlp
  -------------------------------------------------------- */

  try {
    const args = [
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "--restrict-filenames",
      "--no-check-certificates",

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
    }

    args.push(url);

    const result =
      await spawnCapture(
        YTDLP_BIN,
        args,
        {
          timeout: 300000,
        }
      );

    if (
      result.code === 0
    ) {
      await validateVideoFile(
        outputPath
      );

      return outputPath;
    }

    console.warn(
      `[yt-dlp] Falha: ${
        redactSecrets(
          result.stderr
        ).slice(-800)
      }`
    );
  } catch (err) {
    console.warn(
      `[yt-dlp] Exceção: ${err.message}`
    );

    await safeRemove(
      outputPath
    );
  }

  throw new Error(
    "Não foi possível baixar o vídeo original do YouTube."
  );
}

/* ============================================================
   FFMPEG
============================================================ */

async function renderClip(
  sourceFile,
  outputFile,
  start,
  duration
) {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",

    "-ss",
    String(start),

    "-i",
    sourceFile,

    "-t",
    String(duration),

    "-map",
    "0:v:0",

    "-map",
    "0:a:0?",

    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-crf",
    "22",

    "-c:a",
    "aac",

    "-b:a",
    "128k",

    "-pix_fmt",
    "yuv420p",

    "-movflags",
    "+faststart",

    "-avoid_negative_ts",
    "make_zero",

    "-y",
    outputFile,
  ];

  const result =
    await spawnCapture(
      FFMPEG_BIN,
      args,
      {
        timeout: 180000,
      }
    );

  if (
    result.code !== 0
  ) {
    throw new Error(
      `FFmpeg erro: ${
        redactSecrets(
          result.stderr
        ).slice(-1000)
      }`
    );
  }

  const stat =
    await fsp.stat(
      outputFile
    );

  if (
    !stat.size ||
    stat.size < 10000
  ) {
    throw new Error(
      "Arquivo MP4 renderizado inválido."
    );
  }

  return outputFile;
}

/* ============================================================
   ROTAS GERAIS
============================================================ */

app.get(
  "/",
  (req, res) => {
    res.json({
      name:
        "ClipForge Pro",

      version:
        VERSION,

      status:
        "online",

      features: {
        uploadMp4:
          true,

        geminiVideoAnalysis:
          true,

        geminiFiles:
          true,

        geminiInteractions:
          true,

        ffmpegClips:
          true,

        youtube:
          true,
      },
    });
  }
);

app.get(
  "/health",
  async (req, res) => {
    const [
      yt,
      ff,
      probe,
    ] =
      await Promise.all([
        commandExists(
          YTDLP_BIN
        ).catch(
          () => false
        ),

        commandExists(
          FFMPEG_BIN
        ).catch(
          () => false
        ),

        commandExists(
          FFPROBE_BIN
        ).catch(
          () => false
        ),
      ]);

    res.json({
      ok: true,

      version:
        VERSION,

      ytDlp:
        yt,

      ffmpeg:
        ff,

      ffprobe:
        probe,

      binaries: {
        ffmpeg:
          FFMPEG_BIN,

        ffprobe:
          FFPROBE_BIN,

        ytDlp:
          YTDLP_BIN,
      },

      geminiConfigured:
        Boolean(
          GEMINI_API_KEY
        ),

      geminiModel:
        GEMINI_MODEL,

      geminiFallbacks:
        GEMINI_FALLBACK_MODELS,

      geminiFilesApi:
        true,

      geminiInteractionsApi:
        true,

      geminiUploadTimeout:
        GEMINI_UPLOAD_TIMEOUT_MS,

      geminiFileProcessTimeout:
        GEMINI_FILE_PROCESS_TIMEOUT_MS,

      rapidApiConfigured:
        Boolean(
          RAPIDAPI_KEY
        ),

      mercadoPagoConfigured:
        Boolean(
          MP_ACCESS_TOKEN
        ),

      activeUploads:
        uploads.size,

      uptime:
        process.uptime(),

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
    try {
      const user =
        ensureUser(
          req.body?.userId
        );

      const token =
        randomToken(32);

      sessions.set(
        token,
        {
          userId:
            user.id,

          createdAt:
            now(),

          expiresAt:
            now() +
            SESSION_TTL,
        }
      );

      res.json({
        ok: true,

        token,

        user:
          publicUser(user),
      });
    } catch {
      metrics.errors++;

      jsonError(
        res,
        500,
        "Erro ao iniciar sessão."
      );
    }
  }
);

app.get(
  "/api/auth/me",
  requireUser,
  (req, res) => {
    claimDailyPoints(
      req.user
    );

    res.json({
      ok: true,

      user:
        publicUser(
          req.user
        ),
    });
  }
);

/* ============================================================
   UPLOAD MP4
============================================================ */

app.post(
  "/api/upload",
  requireUser,
  (req, res) => {
    videoUpload.single(
      "video"
    )(
      req,
      res,
      async (err) => {
        if (err) {
          metrics.errors++;

          if (
            err.code ===
            "LIMIT_FILE_SIZE"
          ) {
            return jsonError(
              res,
              413,
              `O vídeo ultrapassa o limite de ${MAX_UPLOAD_MB} MB.`
            );
          }

          return jsonError(
            res,
            400,
            err.message ||
              "Falha no upload do vídeo."
          );
        }

        if (!req.file) {
          return jsonError(
            res,
            400,
            "Nenhum arquivo MP4 foi enviado."
          );
        }

        const filePath =
          req.file.path;

        try {
          const info =
            await validateVideoFile(
              filePath
            );

          const uploadId =
            crypto.randomUUID();

          const item = {
            id:
              uploadId,

            userId:
              req.user.id,

            path:
              filePath,

            originalName:
              req.file.originalname,

            size:
              info.size,

            duration:
              info.duration,

            mimeType:
              "video/mp4",

            createdAt:
              now(),

            geminiFile:
              null,
          };

          uploads.set(
            uploadId,
            item
          );

          metrics.uploads++;

          console.log(
            `[Upload] Vídeo recebido: ${item.originalName}`
          );

          console.log(
            `[Upload] ID: ${uploadId}`
          );

          console.log(
            `[Upload] Duração: ${info.duration.toFixed(2)}s`
          );

          console.log(
            `[Upload] Tamanho: ${(info.size / 1024 / 1024).toFixed(2)} MB`
          );

          return res.json({
            ok: true,

            uploadId,

            sourceType:
              "upload",

            filename:
              item.originalName,

            size:
              item.size,

            duration:
              Number(
                item.duration.toFixed(
                  2
                )
              ),

            mimeType:
              item.mimeType,

            user:
              publicUser(
                req.user
              ),

            version:
              VERSION,
          });
        } catch (vErr) {
          metrics.errors++;

          await safeRemove(
            filePath
          );

          return jsonError(
            res,
            400,
            vErr.message ||
              "O arquivo enviado não é um vídeo válido."
          );
        }
      }
    );
  }
);

/* ============================================================
   CONSULTA UPLOAD
============================================================ */

app.get(
  "/api/upload/:id",
  requireUser,
  async (req, res) => {
    try {
      const upload =
        getOwnedUpload(
          req.params.id,
          req.user.id
        );

      res.json({
        ok: true,

        upload: {
          id:
            upload.id,

          filename:
            upload.originalName,

          size:
            upload.size,

          duration:
            Number(
              upload.duration.toFixed(
                2
              )
            ),

          mimeType:
            upload.mimeType,

          createdAt:
            upload.createdAt,
        },

        user:
          publicUser(
            req.user
          ),
      });
    } catch (err) {
      jsonError(
        res,
        404,
        err.message
      );
    }
  }
);

/* ============================================================
   ANÁLISE GEMINI
============================================================ */

app.post(
  "/api/analisar",
  requireUser,
  async (req, res) => {
    const uploadId =
      safeUploadId(
        req.body?.uploadId
      );

    const inputUrl =
      String(
        req.body?.url || ""
      ).trim();

    /* --------------------------------------------------------
       UPLOAD MP4
    -------------------------------------------------------- */

    if (uploadId) {
      try {
        const upload =
          getOwnedUpload(
            uploadId,
            req.user.id
          );

        metrics.analyses++;
        metrics.uploadAnalyses++;

        req.user.analyses++;

        console.log(
          `[Analysis] Iniciando análise do upload ${upload.id}`
        );

        /*
         * Só envia para o Gemini uma vez.
         */
        if (
          !upload.geminiFile
        ) {
          console.log(
            "[Analysis] Arquivo ainda não está no Gemini."
          );

          upload.geminiFile =
            await uploadVideoToGemini(
              upload.path
            );
        } else {
          console.log(
            "[Analysis] Reutilizando arquivo Gemini já processado."
          );
        }

        const prompt =
          buildClipPrompt(
            upload.duration
          );

        const input = [
          {
            type:
              "video",

            uri:
              upload.geminiFile
                .uri,

            mime_type:
              upload.geminiFile
                .mimeType,
          },
        ];

        console.log(
          "[Analysis] Enviando vídeo ao Gemini Interactions..."
        );

        const result =
          await analyzeWithGeminiFallback(
            input,
            prompt
          );

        console.log(
          `[Analysis] ${result.clips.length} cortes encontrados.`
        );

        return res.json({
          ok: true,

          sourceType:
            "upload",

          uploadId:
            upload.id,

          filename:
            upload.originalName,

          videoDuration:
            Number(
              upload.duration.toFixed(
                2
              )
            ),

          clips:
            result.clips,

          user:
            publicUser(
              req.user
            ),

          fallback:
            Boolean(
              result.fallback
            ),

          model:
            result.model,

          version:
            VERSION,
        });
      } catch (err) {
        metrics.errors++;

        console.error(
          `[Analysis Upload] ${err.message}`
        );

        return jsonError(
          res,
          502,
          err.message ||
            "Não foi possível analisar o vídeo enviado."
        );
      }
    }

    /* --------------------------------------------------------
       YOUTUBE
    -------------------------------------------------------- */

    const videoId =
      youtubeIdFromUrl(
        inputUrl
      );

    if (!videoId) {
      return jsonError(
        res,
        400,
        "Envie um uploadId ou um link do YouTube válido."
      );
    }

    const url =
      youtubeUrl(
        inputUrl
      );

    metrics.analyses++;
    metrics.youtubeAnalyses++;

    req.user.analyses++;

    try {
      const prompt =
        buildClipPrompt(0) +
        `\n\nVídeo do YouTube:\n${url}`;

      const input = [
        {
          type:
            "video",

          uri:
            url,
        },
      ];

      console.log(
        `[Analysis YouTube] Analisando ${videoId}...`
      );

      const result =
        await analyzeWithGeminiFallback(
          input,
          prompt
        );

      return res.json({
        ok: true,

        sourceType:
          "youtube",

        videoId,

        clips:
          result.clips,

        user:
          publicUser(
            req.user
          ),

        fallback:
          Boolean(
            result.fallback
          ),

        model:
          result.model,

        version:
          VERSION,
      });
    } catch (err) {
      metrics.errors++;

      console.error(
        `[Analysis YouTube] ${err.message}`
      );

      return jsonError(
        res,
        502,
        err.message ||
          "Não foi possível analisar o vídeo."
      );
    }
  }
);

/* ============================================================
   ANÁLISE UPLOAD — COMPATIBILIDADE
============================================================ */

app.post(
  "/api/analisar-upload",
  requireUser,
  async (req, res) => {
    const uploadId =
      safeUploadId(
        req.body?.uploadId
      );

    if (!uploadId) {
      return jsonError(
        res,
        400,
        "uploadId obrigatório."
      );
    }

    try {
      const upload =
        getOwnedUpload(
          uploadId,
          req.user.id
        );

      metrics.analyses++;
      metrics.uploadAnalyses++;

      req.user.analyses++;

      if (
        !upload.geminiFile
      ) {
        upload.geminiFile =
          await uploadVideoToGemini(
            upload.path
          );
      }

      const prompt =
        buildClipPrompt(
          upload.duration
        );

      const input = [
        {
          type:
            "video",

          uri:
            upload.geminiFile
              .uri,

          mime_type:
            upload.geminiFile
              .mimeType,
        },
      ];

      const result =
        await analyzeWithGeminiFallback(
          input,
          prompt
        );

      return res.json({
        ok: true,

        sourceType:
          "upload",

        uploadId:
          upload.id,

        filename:
          upload.originalName,

        videoDuration:
          Number(
            upload.duration.toFixed(
              2
            )
          ),

        clips:
          result.clips,

        user:
          publicUser(
            req.user
          ),

        fallback:
          Boolean(
            result.fallback
          ),

        model:
          result.model,

        version:
          VERSION,
      });
    } catch (err) {
      metrics.errors++;

      console.error(
        `[Analysis Upload Legacy] ${err.message}`
      );

      return jsonError(
        res,
        502,
        err.message ||
          "Não foi possível analisar o vídeo enviado."
      );
    }
  }
);

/* ============================================================
   DOWNLOAD / CORTE
============================================================ */

app.post(
  "/api/download",
  requireUser,
  async (req, res) => {
    const uploadId =
      safeUploadId(
        req.body?.uploadId
      );

    const inputUrl =
      String(
        req.body?.url || ""
      ).trim();

    const start =
      parseNumber(
        req.body?.start,
        NaN
      );

    const requestedDuration =
      parseNumber(
        req.body?.duration,
        NaN
      );

    if (
      !Number.isFinite(start) ||
      start < 0
    ) {
      return jsonError(
        res,
        400,
        "Tempo inicial inválido."
      );
    }

    if (
      !Number.isFinite(
        requestedDuration
      ) ||
      requestedDuration <= 0 ||
      requestedDuration > 90
    ) {
      return jsonError(
        res,
        400,
        "Duração inválida (0-90s)."
      );
    }

    if (
      !req.user.vip &&
      req.user.points <
        DOWNLOAD_COST
    ) {
      return jsonError(
        res,
        402,
        `Pontos insuficientes (${DOWNLOAD_COST} necessários).`
      );
    }

    let sourceType = "";

    let uploadItem =
      null;

    let youtubeVideoId =
      null;

    /* --------------------------------------------------------
       Fonte
    -------------------------------------------------------- */

    if (uploadId) {
      try {
        uploadItem =
          getOwnedUpload(
            uploadId,
            req.user.id
          );

        sourceType =
          "upload";
      } catch (err) {
        return jsonError(
          res,
          404,
          err.message
        );
      }
    } else {
      youtubeVideoId =
        youtubeIdFromUrl(
          inputUrl
        );

      if (!youtubeVideoId) {
        return jsonError(
          res,
          400,
          "Envie um uploadId ou uma URL válida do YouTube."
        );
      }

      sourceType =
        "youtube";
    }

    const jobId =
      crypto.randomUUID();

    const workDir =
      await fsp.mkdtemp(
        path.join(
          os.tmpdir(),
          `clipforge-${jobId}-`
        )
      );

    const outputFile =
      path.join(
        workDir,
        `clip-${jobId}.mp4`
      );

    let charged = false;

    try {
      let sourceFile;

      /* ------------------------------------------------------
         Fonte upload
      ------------------------------------------------------ */

      if (
        sourceType ===
        "upload"
      ) {
        sourceFile =
          uploadItem.path;
      }

      /* ------------------------------------------------------
         Fonte YouTube
      ------------------------------------------------------ */

      else {
        const url =
          youtubeUrl(
            inputUrl
          );

        sourceFile =
          await downloadOriginalVideo(
            url,
            youtubeVideoId,
            workDir
          );
      }

      /* ------------------------------------------------------
         Validar fonte
      ------------------------------------------------------ */

      const sourceInfo =
        await validateVideoFile(
          sourceFile
        );

      if (
        start >=
        sourceInfo.duration
      ) {
        throw new Error(
          `Início (${start}s) além da duração total (${sourceInfo.duration.toFixed(
            2
          )}s).`
        );
      }

      /*
       * Não permite ultrapassar
       * o final real do vídeo.
       */
      const availableDuration =
        sourceInfo.duration -
        start;

      const safeDuration =
        Math.min(
          requestedDuration,
          availableDuration
        );

      if (
        safeDuration <= 0
      ) {
        throw new Error(
          "O intervalo solicitado não possui duração válida."
        );
      }

      const safeEnd =
        start +
        safeDuration;

      console.log(
        `[Download] Corte: ${start.toFixed(
          2
        )}s → ${safeEnd.toFixed(
          2
        )}s (${safeDuration.toFixed(
          2
        )}s)`
      );

      /* ------------------------------------------------------
         Render
      ------------------------------------------------------ */

      await renderClip(
        sourceFile,
        outputFile,
        start,
        safeDuration
      );

      const stat =
        await fsp.stat(
          outputFile
        );

      if (
        !stat.size ||
        stat.size < 10000
      ) {
        throw new Error(
          "Arquivo MP4 renderizado inválido."
        );
      }

      /* ------------------------------------------------------
         Cobrança SOMENTE depois
         do render concluído
      ------------------------------------------------------ */

      if (
        !req.user.vip
      ) {
        req.user.points -=
          DOWNLOAD_COST;

        charged = true;
      }

      req.user.downloads++;

      metrics.downloads++;

      if (
        sourceType ===
        "upload"
      ) {
        metrics.uploadDownloads++;
      } else {
        metrics.youtubeDownloads++;
      }

      const filename =
        sourceType ===
        "upload"
          ? `clipforge_${path
              .basename(
                uploadItem.originalName,
                path.extname(
                  uploadItem.originalName
                )
              )
              .replace(
                /[^A-Za-z0-9_-]+/g,
                "_"
              )
              .slice(0, 60)}_${Math.floor(
              start
            )}s.mp4`
          : `clipforge_${youtubeVideoId}_${Math.floor(
              start
            )}s.mp4`;

      /* ------------------------------------------------------
         RESPOSTA MP4
      ------------------------------------------------------ */

      res.status(200);

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Length",
        String(stat.size)
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
          outputFile
        );

      let cleaned = false;

      const safeCleanDir =
        async () => {
          if (cleaned) return;

          cleaned = true;

          await cleanup(
            workDir
          );
        };

      stream.on(
        "error",
        async (streamError) => {
          console.error(
            "[Download Stream]",
            streamError
          );

          if (
            charged &&
            !req.user.vip
          ) {
            req.user.points +=
              DOWNLOAD_COST;
          }

          await safeCleanDir();
        }
      );

      res.on(
        "finish",
        safeCleanDir
      );

      res.on(
        "close",
        safeCleanDir
      );

      stream.pipe(res);
    } catch (err) {
      metrics.errors++;

      if (
        charged &&
        !req.user.vip
      ) {
        req.user.points +=
          DOWNLOAD_COST;
      }

      await cleanup(
        workDir
      );

      if (
        res.headersSent
      ) {
        return;
      }

      return jsonError(
        res,
        500,
        err.message ||
          "Erro ao processar e cortar o vídeo."
      );
    }
  }
);

/* ============================================================
   MERCADO PAGO / PIX
============================================================ */

app.post(
  "/api/pix/criar",
  requireUser,
  async (req, res) => {
    if (!MP_ACCESS_TOKEN) {
      return jsonError(
        res,
        503,
        "Pix não configurado."
      );
    }

    try {
      const payment =
        await fetch(
          `${MP_API_URL}/v1/payments`,
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${MP_ACCESS_TOKEN}`,

              "Content-Type":
                "application/json",

              "X-Idempotency-Key":
                crypto.randomUUID(),
            },

            body:
              JSON.stringify({
                transaction_amount:
                  Number(
                    VIP_PRICE.toFixed(
                      2
                    )
                  ),

                description:
                  "ClipForge Pro VIP",

                payment_method_id:
                  "pix",

                payer: {
                  email:
                    `cliente-${req.user.id}@clipforge.local`,
                },

                external_reference:
                  `clipforge_${req.user.id}_${crypto.randomUUID()}`,
              }),
          }
        ).then(
          (response) =>
            response.json()
        );

      const tx =
        payment
          ?.point_of_interaction
          ?.transaction_data ||
        {};

      payments.set(
        String(
          payment.id
        ),
        {
          id:
            String(
              payment.id
            ),

          userId:
            req.user.id,

          status:
            payment.status,

          createdAt:
            now(),
        }
      );

      metrics.pixCreated++;

      return res.json({
        ok: true,

        id:
          String(
            payment.id
          ),

        status:
          payment.status,

        qr_code:
          tx.qr_code ||
          "",

        qr_code_base64:
          tx.qr_code_base64 ||
          "",

        ticket_url:
          tx.ticket_url ||
          "",

        amount:
          VIP_PRICE,
      });
    } catch (err) {
      metrics.errors++;

      return jsonError(
        res,
        502,
        err.message ||
          "Erro ao gerar PIX."
      );
    }
  }
);

app.get(
  "/api/pix/status/:id",
  requireUser,
  async (req, res) => {
    const paymentId =
      String(
        req.params.id || ""
      );

    const localPayment =
      payments.get(
        paymentId
      );

    if (!localPayment) {
      return jsonError(
        res,
        404,
        "Pagamento não encontrado."
      );
    }

    if (
      localPayment.userId !==
      req.user.id
    ) {
      return jsonError(
        res,
        403,
        "Pagamento não pertence a esta conta."
      );
    }

    try {
      const response =
        await fetch(
          `${MP_API_URL}/v1/payments/${encodeURIComponent(
            paymentId
          )}`,
          {
            headers: {
              Authorization:
                `Bearer ${MP_ACCESS_TOKEN}`,
            },
          }
        );

      const payment =
        await response.json();

      if (!response.ok) {
        throw new Error(
          payment?.message ||
            `Mercado Pago HTTP ${response.status}`
        );
      }

      const approved =
        payment.status ===
        "approved";

      localPayment.status =
        payment.status;

      if (
        approved &&
        !req.user.vip
      ) {
        req.user.vip =
          true;

        metrics.pixApproved++;
      }

      return res.json({
        ok: true,

        id:
          paymentId,

        status:
          payment.status,

        approved,

        user:
          publicUser(
            req.user
          ),
      });
    } catch (err) {
      metrics.errors++;

      return jsonError(
        res,
        502,
        err.message ||
          "Erro ao consultar PIX."
      );
    }
  }
);

/* ============================================================
   ADMIN
============================================================ */

app.post(
  "/api/admin/login",
  (req, res) => {
    if (!ADMIN_PASSWORD) {
      return jsonError(
        res,
        503,
        "ADMIN_PASSWORD não configurada."
      );
    }

    if (
      String(
        req.body?.password || ""
      ) !== ADMIN_PASSWORD
    ) {
      return jsonError(
        res,
        401,
        "Senha administrativa incorreta."
      );
    }

    const token =
      randomToken(32);

    adminSessions.set(
      token,
      {
        createdAt:
          now(),

        expiresAt:
          now() +
          ADMIN_TOKEN_TTL,
      }
    );

    return res.json({
      ok: true,
      token,
    });
  }
);

app.get(
  "/api/admin/dashboard",
  requireAdmin,
  (req, res) => {
    let vipUsers = 0;

    let totalPoints = 0;

    let totalDownloads = 0;

    let totalAnalyses = 0;

    for (
      const user of users.values()
    ) {
      if (user.vip) {
        vipUsers++;
      }

      totalPoints +=
        Math.max(
          0,
          user.points
        );

      totalDownloads +=
        user.downloads;

      totalAnalyses +=
        user.analyses;
    }

    return res.json({
      ok: true,

      metrics: {
        ...metrics,

        users:
          users.size,

        vipUsers,

        totalPoints,

        totalDownloads,

        totalAnalyses,

        activeUploads:
          uploads.size,
      },

      version:
        VERSION,
    });
  }
);

/* ============================================================
   ERROR HANDLER
============================================================ */

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
    console.error(
      "[Express Error]",
      err
    );

    metrics.errors++;

    if (
      res.headersSent
    ) {
      return next(err);
    }

    return jsonError(
      res,
      500,
      "Erro interno do servidor."
    );
  }
);

/* ============================================================
   INICIALIZAÇÃO
============================================================ */

async function startServer() {
  try {
    await ensureDirectories();

    await cleanupExpiredUploads();

    await resolveBinaries();

    console.log(
      "===================================================="
    );

    console.log(
      `ClipForge Pro Backend ${VERSION} iniciando...`
    );

    console.log(
      `Node: ${process.version}`
    );

    console.log(
      `Gemini: ${GEMINI_MODEL}`
    );

    console.log(
      `Fallbacks: ${
        GEMINI_FALLBACK_MODELS.join(
          ", "
        ) ||
        "nenhum"
      }`
    );

    console.log(
      `Gemini Files API: ATIVA`
    );

    console.log(
      `Gemini Interactions API: ATIVA`
    );

    console.log(
      `Gemini upload por stream: ATIVO`
    );

    console.log(
      `Gemini polling: ${
        GEMINI_POLL_INTERVAL_MS
      }ms`
    );

    console.log(
      `Gemini processamento máximo: ${
        Math.round(
          GEMINI_FILE_PROCESS_TIMEOUT_MS /
            60000
        )
      } min`
    );

    console.log(
      `Upload MP4: ATIVO — limite ${MAX_UPLOAD_MB} MB`
    );

    console.log(
      `yt-dlp: ${YTDLP_BIN}`
    );

    console.log(
      `FFmpeg: ${FFMPEG_BIN}`
    );

    console.log(
      `FFprobe: ${FFPROBE_BIN}`
    );

    console.log(
      "===================================================="
    );

    const [
      ytOk,
      ffOk,
      probeOk,
    ] =
      await Promise.all([
        commandExists(
          YTDLP_BIN
        ),

        commandExists(
          FFMPEG_BIN
        ),

        commandExists(
          FFPROBE_BIN
        ),
      ]);

    console.log(
      `[Startup] yt-dlp: ${
        ytOk
          ? "OK"
          : "ERRO"
      }`
    );

    console.log(
      `[Startup] FFmpeg: ${
        ffOk
          ? "OK"
          : "ERRO"
      }`
    );

    console.log(
      `[Startup] FFprobe: ${
        probeOk
          ? "OK"
          : "ERRO"
      }`
    );

    console.log(
      `[Startup] Gemini API Key: ${
        GEMINI_API_KEY
          ? "CONFIGURADA"
          : "AUSENTE"
      }`
    );

    console.log(
      `[Startup] RapidAPI: ${
        RAPIDAPI_KEY
          ? "CONFIGURADA"
          : "AUSENTE"
      }`
    );

    console.log(
      `[Startup] Mercado Pago: ${
        MP_ACCESS_TOKEN
          ? "CONFIGURADO"
          : "AUSENTE"
      }`
    );

    app.listen(
      PORT,
      HOST,
      () => {
        console.log(
          `ClipForge Pro Backend ${VERSION} online em http://${HOST}:${PORT}`
        );

        console.log(
          "===================================================="
        );

        console.log(
          "CLIPFORGE PRO PRONTO."
        );

        console.log(
          "===================================================="
        );
      }
    );
  } catch (error) {
    console.error(
      "[Startup] Falha ao iniciar:",
      error
    );

    process.exit(1);
  }
}

startServer();