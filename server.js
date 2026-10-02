/**
 * ============================================================
 * CLIPFORGE PRO — BACKEND 13.2.0 COMPLETO
 * Node.js + Express
 *
 * Compatível com index.html V13.0.7
 *
 * PRINCIPAIS RECURSOS
 * ------------------------------------------------------------
 * - Upload direto de vídeos MP4
 * - Análise IA de vídeos enviados pelo usuário
 * - Gemini Files API + Interactions API
 * - Modelo principal: gemini-3.8-flash
 * - Fallbacks: gemini-3.7-flash, gemini-3.6-flash, gemini-3.5-flash
 * - Retry automático para 429
 * - Fallback em 503/500/502/504
 * - FFmpeg e FFprobe via pacotes NPM
 * - chmod 0o755 nos binários NPM
 * - FFmpeg corta diretamente o vídeo enviado
 * - YouTube continua disponível como modo secundário
 * - Downloader externo -> RapidAPI -> yt-dlp para YouTube
 * - Autenticação Bearer com fallback X-User-Id
 * - Mercado Pago / PIX
 * - Dashboard administrativo
 * - Limpeza automática de uploads temporários
 * - Sem dependência de dotenv
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
const { GoogleGenAI } = require("@google/genai");

const app = express();

/* ============================================================
   CONFIGURAÇÃO
============================================================ */

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";

const VERSION = "13.2.0";

const FREE_POINTS = Number(process.env.FREE_POINTS || 200);
const DAILY_POINTS = Number(process.env.DAILY_POINTS || 50);
const DOWNLOAD_COST = Number(process.env.DOWNLOAD_COST || 50);
const VIP_PRICE = Number(process.env.VIP_PRICE || 19.90);
const MAX_CLIPS = Number(process.env.MAX_CLIPS || 5);

/*
 * Limite do upload local.
 *
 * Padrão: 500 MB
 *
 * Pode alterar no Render:
 * MAX_UPLOAD_MB=1000
 */
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 500);
const MAX_UPLOAD_BYTES = Math.floor(MAX_UPLOAD_MB * 1024 * 1024);

/*
 * Tempo que um upload fica disponível no servidor.
 *
 * Padrão: 2 horas
 */
const UPLOAD_TTL_MS = Number(
  process.env.UPLOAD_TTL_MS || 2 * 60 * 60 * 1000
);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const ADMIN_TOKEN_TTL =
  24 * 60 * 60 * 1000;

const SESSION_TTL =
  30 * 24 * 60 * 60 * 1000;

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
  .filter(
    (v, i, arr) =>
      arr.indexOf(v) === i &&
      v !== GEMINI_MODEL
  );

const GEMINI_INTERACTIONS_URL =
  process.env.GEMINI_INTERACTIONS_URL ||
  "https://generativelanguage.googleapis.com/v1beta/interactions";

let geminiClient = null;

function getGeminiClient() {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY não configurada.");
  }

  if (!geminiClient) {
    geminiClient = new GoogleGenAI({
      apiKey: GEMINI_API_KEY,
    });
  }

  return geminiClient;
}

/* ============================================================
   RAPIDAPI / DOWNLOADERS — SOMENTE PARA YOUTUBE
============================================================ */

const RAPIDAPI_KEY =
  process.env.RAPIDAPI_KEY ||
  process.env.X_RAPIDAPI_KEY ||
  "";

const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST ||
  "youtube-media-downloader.p.rapidapi";

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

const MP_API =
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

/* ============================================================
   BINÁRIOS
============================================================ */

function findExecutable(candidates = []) {
  for (const candidate of candidates) {
    if (!candidate) continue;

    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {}
  }

  return null;
}

/* ---------------- FFmpeg ---------------- */

let resolvedFfmpeg = "";

try {
  resolvedFfmpeg =
    require("@ffmpeg-installer/ffmpeg").path;

  if (
    resolvedFfmpeg &&
    fs.existsSync(resolvedFfmpeg)
  ) {
    try {
      fs.chmodSync(
        resolvedFfmpeg,
        0o755
      );
    } catch {}
  }
} catch {}

if (
  !resolvedFfmpeg ||
  !fs.existsSync(resolvedFfmpeg)
) {
  resolvedFfmpeg =
    process.env.FFMPEG_PATH ||
    process.env.FFMPEG_BIN ||
    findExecutable([
      path.join(
        process.cwd(),
        "bin",
        "ffmpeg"
      ),
      path.join(
        process.cwd(),
        "ffmpeg"
      ),
    ]) ||
    "ffmpeg";
}

const FFMPEG_BIN = resolvedFfmpeg;

/* ---------------- FFprobe ---------------- */

let resolvedFfprobe = "";

try {
  resolvedFfprobe =
    require("@ffprobe-installer/ffprobe").path;

  if (
    resolvedFfprobe &&
    fs.existsSync(resolvedFfprobe)
  ) {
    try {
      fs.chmodSync(
        resolvedFfprobe,
        0o755
      );
    } catch {}
  }
} catch {}

if (
  !resolvedFfprobe ||
  !fs.existsSync(resolvedFfprobe)
) {
  resolvedFfprobe =
    process.env.FFPROBE_PATH ||
    process.env.FFPROBE_BIN ||
    findExecutable([
      path.join(
        process.cwd(),
        "bin",
        "ffprobe"
      ),
      path.join(
        process.cwd(),
        "ffprobe"
      ),
    ]) ||
    "ffprobe";
}

const FFPROBE_BIN = resolvedFfprobe;

/* ---------------- yt-dlp ---------------- */

const YTDLP_BIN =
  process.env.YTDLP_PATH ||
  process.env.YTDLP_BIN ||
  findExecutable([
    path.join(
      process.cwd(),
      "bin",
      "yt-dlp"
    ),
    path.join(
      process.cwd(),
      "yt-dlp"
    ),
  ]) ||
  "yt-dlp";

const YTDLP_COOKIES_FILE =
  process.env.YTDLP_COOKIES_FILE || "";

/* ============================================================
   MEMÓRIA
============================================================ */

const sessions = new Map();
const adminSessions = new Map();
const users = new Map();
const payments = new Map();

/*
 * Uploads locais.
 *
 * uploadId => {
 *   id,
 *   userId,
 *   path,
 *   originalName,
 *   size,
 *   duration,
 *   mimeType,
 *   createdAt,
 *   geminiFileName,
 *   geminiUri,
 *   geminiMimeType
 * }
 */
const uploads = new Map();

/* ============================================================
   MÉTRICAS
============================================================ */

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
      "OPTIONS",
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-User-Id",
    ],
  })
);

app.use(
  express.json({
    limit: "2mb",
  })
);

app.use(
  express.urlencoded({
    extended: false,
    limit: "1mb",
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
   MULTER — UPLOAD MP4
============================================================ */

const uploadStorage =
  multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, UPLOAD_DIR);
    },

    filename: (req, file, cb) => {
      const id =
        crypto.randomUUID();

      cb(
        null,
        `${id}.mp4`
      );
    },
  });

const videoUpload =
  multer({
    storage: uploadStorage,

    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,
    },

    fileFilter: (req, file, cb) => {
      const originalName =
        String(
          file.originalname || ""
        );

      const extension =
        path
          .extname(originalName)
          .toLowerCase();

      const mime =
        String(
          file.mimetype || ""
        ).toLowerCase();

      /*
       * Aceitamos MP4 normalmente.
       *
       * Alguns navegadores podem enviar
       * application/octet-stream, então
       * permitimos esse MIME quando a
       * extensão for .mp4.
       */
      const validExtension =
        extension === ".mp4";

      const validMime =
        mime === "video/mp4" ||
        mime === "application/mp4" ||
        mime === "application/octet-stream";

      if (
        validExtension &&
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

  const v =
    String(value).trim();

  return /^[A-Za-z0-9_-]{6,128}$/.test(v)
    ? v
    : null;
}

function safeUploadId(value) {
  if (!value) return null;

  const v =
    String(value).trim();

  return /^[a-f0-9-]{20,100}$/i.test(v)
    ? v
    : null;
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
  let val =
    String(text || "");

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

async function safeRemove(
  filePath
) {
  if (!filePath) return;

  try {
    await fsp.rm(
      filePath,
      {
        force: true,
        recursive: true,
      }
    );
  } catch {}
}

async function cleanup(
  ...files
) {
  await Promise.all(
    files
      .filter(Boolean)
      .map((f) =>
        safeRemove(f)
      )
  );
}

/* ============================================================
   YOUTUBE HELPERS
============================================================ */

function youtubeIdFromUrl(value) {
  if (!value) return null;

  const input =
    String(value).trim();

  if (
    /^[A-Za-z0-9_-]{11}$/.test(
      input
    )
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
   USUÁRIOS & SESSÕES
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

    users.set(
      id,
      user
    );
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
    points: Math.max(
      0,
      Math.floor(
        user.points
      )
    ),
    vip: Boolean(
      user.vip
    ),
  };
}

function sessionUser(req) {
  const token =
    getBearer(req);

  if (!token) return null;

  const session =
    sessions.get(token);

  if (
    !session ||
    session.expiresAt < now()
  ) {
    if (session) {
      sessions.delete(token);
    }

    return null;
  }

  return (
    users.get(
      session.userId
    ) || null
  );
}

function requireUser(
  req,
  res,
  next
) {
  let user =
    sessionUser(req);

  /*
   * Compatibilidade com o frontend atual.
   */
  if (!user) {
    const id =
      safeUserId(
        req.headers[
          "x-user-id"
        ]
      );

    if (id) {
      user =
        users.get(id) ||
        null;
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
    session.expiresAt < now()
  ) {
    if (session) {
      adminSessions.delete(
        token
      );
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

      const child =
        spawn(
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
          stdout +=
            data.toString();

          if (
            stdout.length >
            500000
          ) {
            stdout =
              stdout.slice(
                -500000
              );
          }
        }
      );

      child.stderr?.on(
        "data",
        (data) => {
          stderr +=
            data.toString();

          if (
            stderr.length >
            500000
          ) {
            stderr =
              stderr.slice(
                -500000
              );
          }
        }
      );

      child.on(
        "error",
        (error) => {
          if (termTimer) {
            clearTimeout(
              termTimer
            );
          }

          if (killTimer) {
            clearTimeout(
              killTimer
            );
          }

          reject(error);
        }
      );

      child.on(
        "close",
        (code, signal) => {
          if (termTimer) {
            clearTimeout(
              termTimer
            );
          }

          if (killTimer) {
            clearTimeout(
              killTimer
            );
          }

          resolve({
            code:
              Number.isInteger(
                code
              )
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
        Number.isFinite(
          timeout
        ) &&
        timeout > 0
      ) {
        termTimer =
          setTimeout(
            () => {
              timedOut =
                true;

              console.warn(
                `[Process] Timeout de ${timeout}ms: ${command}`
              );

              try {
                child.kill(
                  "SIGTERM"
                );
              } catch {}

              killTimer =
                setTimeout(
                  () => {
                    try {
                      child.kill(
                        "SIGKILL"
                      );
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
  const result =
    await spawnCapture(
      command,
      ["--version"],
      {
        timeout: 15000,
      }
    ).catch(() => ({
      code: -1,
    }));

  return result.code === 0;
}

async function ensureDirectories() {
  await fsp.mkdir(
    TEMP_ROOT,
    {
      recursive: true,
    }
  );

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

  await fsp.mkdir(
    UPLOAD_DIR,
    {
      recursive: true,
    }
  );
}

/* ============================================================
   FFPROBE
============================================================ */

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
    await fsp.stat(
      filePath
    );

  if (
    stat.size < 10000
  ) {
    throw new Error(
      `Arquivo muito pequeno (${stat.size} bytes).`
    );
  }

  const probe =
    await spawnCapture(
      FFPROBE_BIN,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration,format_name",
        "-of",
        "json",
        filePath,
      ],
      {
        timeout: 30000,
      }
    );

  if (
    probe.code !== 0
  ) {
    throw new Error(
      `FFprobe rejeitou o arquivo: ${redactSecrets(
        probe.stderr
      ).slice(-500)}`
    );
  }

  let data;

  try {
    data =
      JSON.parse(
        probe.stdout
      );
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
    !Number.isFinite(
      duration
    ) ||
    duration <= 0
  ) {
    throw new Error(
      "Duração de vídeo inválida."
    );
  }

  return {
    duration,
    size: stat.size,
    format:
      data?.format
        ?.format_name ||
      "",
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
    safeUploadId(
      uploadId
    );

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

  if (
    item.userId !== userId
  ) {
    throw new Error(
      "Esse vídeo não pertence a esta conta."
    );
  }

  if (
    !fs.existsSync(
      item.path
    )
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

  let removed = 0;

  for (
    const [
      id,
      item,
    ] of uploads.entries()
  ) {
    if (
      item.createdAt <
      cutoff
    ) {
      await safeRemove(
        item.path
      );

      uploads.delete(id);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(
      `[Upload] ${removed} upload(s) temporário(s) removido(s).`
    );
  }
}

/*
 * Limpeza periódica.
 */
const uploadCleanupTimer =
  setInterval(
    () => {
      cleanupExpiredUploads()
        .catch((error) =>
          console.error(
            "[Upload Cleanup]",
            error
          )
        );
    },
    10 * 60 * 1000
  );

uploadCleanupTimer.unref?.();

/* ============================================================
   GEMINI — SCHEMA
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
   GEMINI — NORMALIZAÇÃO DOS CLIPS
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
      .map((clip, index) => {
        const start =
          Math.max(
            0,
            parseNumber(
              clip.start,
              0
            )
          );

        const requestedDuration =
          parseNumber(
            clip.duration,
            parseNumber(
              clip.end,
              start + 50
            ) - start
          );

        const duration =
          clamp(
            requestedDuration,
            20,
            60
          );

        return {
          start: Number(
            start.toFixed(2)
          ),

          end: Number(
            (
              start +
              duration
            ).toFixed(2)
          ),

          duration: Number(
            duration.toFixed(2)
          ),

          title: String(
            clip.title ||
              `Corte #${index + 1}`
          ).slice(0, 140),

          description:
            String(
              clip.description ||
                "Destaque selecionado por IA"
            ).slice(0, 500),

          score: clamp(
            Math.round(
              parseNumber(
                clip.score,
                80
              )
            ),
            0,
            100
          ),
        };
      })
      .filter(
        (clip) =>
          clip.duration >= 20 &&
          clip.duration <= 60
      )
      .slice(
        0,
        MAX_CLIPS
      );

  if (!clips.length) {
    throw new Error(
      "Gemini não encontrou cortes válidos."
    );
  }

  return clips;
}

/* ============================================================
   GEMINI — PARSE
============================================================ */

function parseGeminiOutput(
  outputText,
  model
) {
  let outText =
    String(
      outputText || ""
    )
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
      JSON.parse(
        outText
      );
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

    try {
      parsed =
        JSON.parse(
          match[0]
        );
    } catch {
      throw new Error(
        `Gemini (${model}) retornou JSON inválido.`
      );
    }
  }

  return normalizeGeminiClips(
    parsed
  );
}

/* ============================================================
   GEMINI — PROMPT
============================================================ */

function buildClipPrompt(
  duration
) {
  return `
Você é o motor de seleção de cortes do ClipForge Pro.

Analise integralmente o vídeo enviado.

Duração aproximada do vídeo:
${Number(duration).toFixed(2)} segundos.

Sua tarefa é encontrar até ${MAX_CLIPS} momentos excelentes para Shorts, TikTok e Reels.

Cada corte deve ter entre 20 e 60 segundos.

PRIORIZE:
- falas de impacto;
- frases que prendem atenção;
- histórias completas;
- momentos emocionais;
- opiniões fortes;
- revelações;
- momentos engraçados;
- informações úteis;
- perguntas e respostas interessantes;
- ganchos que façam a pessoa continuar assistindo;
- contexto suficiente para o corte funcionar sozinho.

EVITE:
- introduções vazias;
- silêncio;
- pausas longas;
- trechos sem contexto;
- cortes no meio de frases;
- começo ou fim abrupto;
- momentos sem valor para redes sociais.

IMPORTANTE SOBRE OS TEMPOS:
- Os valores "start" e "end" devem corresponder aos segundos reais do vídeo.
- Não invente timestamps.
- Use timestamps dentro da duração real do vídeo.
- "duration" deve ser aproximadamente end - start.
- Sempre produza cortes entre 20 e 60 segundos.

Para cada corte retorne:
- start
- end
- duration
- title
- description
- score de 0 a 100

Retorne SOMENTE o JSON de acordo com o schema solicitado.
`.trim();
}

/* ============================================================
   GEMINI — REST PARA YOUTUBE
============================================================ */

async function requestGeminiYoutubeModel(
  model,
  url,
  prompt
) {
  const body = {
    model,

    store: false,

    input: [
      {
        type: "video",
        uri: url,
      },

      {
        type: "text",
        text: prompt,
      },
    ],

    generation_config: {
      thinking_level:
        "low",
    },

    response_format: {
      type: "text",
      mime_type:
        "application/json",
      schema:
        CLIPS_SCHEMA,
    },
  };

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      120000
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
  } catch (error) {
    if (
      error?.name ===
      "AbortError"
    ) {
      const timeoutError =
        new Error(
          `Gemini (${model}) excedeu o tempo limite de 120 segundos.`
        );

      timeoutError.status =
        504;

      timeoutError.model =
        model;

      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }

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

  if (!response.ok) {
    const detail =
      data?.error?.message ||
      data?.message ||
      "Erro na API Gemini.";

    const error =
      new Error(
        `Gemini HTTP ${response.status}: ${detail}`
      );

    error.status =
      response.status;

    error.model =
      model;

    error.geminiDetail =
      detail;

    throw error;
  }

  let outputText =
    data?.output_text ||
    data?.outputText ||
    data?.text ||
    "";

  if (
    !outputText &&
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
          const content of
            step.content
        ) {
          if (
            content?.text
          ) {
            outputText +=
              content.text +
              "\n";
          }
        }
      }
    }
  }

  if (!outputText) {
    outputText =
      JSON.stringify(data);
  }

  const clips =
    parseGeminiOutput(
      outputText,
      model
    );

  return {
    clips,
    model,
    fallback:
      model !==
      GEMINI_MODEL,
  };
}

/* ============================================================
   GEMINI — FILES API
============================================================ */

async function uploadVideoToGemini(
  filePath
) {
  const client =
    getGeminiClient();

  console.log(
    `[Gemini Files] Enviando vídeo: ${path.basename(
      filePath
    )}`
  );

  const uploaded =
    await client.files.upload(
      {
        file: filePath,

        config: {
          mimeType:
            "video/mp4",
        },
      }
    );

  if (
    !uploaded ||
    !uploaded.name ||
    !uploaded.uri
  ) {
    throw new Error(
      "Gemini Files API não retornou uma referência válida."
    );
  }

  metrics.geminiFileUploads++;

  console.log(
    `[Gemini Files] Upload criado: ${uploaded.name}`
  );

  let current =
    uploaded;

  const startedAt =
    now();

  /*
   * O Gemini precisa processar o vídeo
   * antes de usá-lo na Interaction.
   */
  while (
    String(
      current.state || ""
    ).toUpperCase() ===
    "PROCESSING"
  ) {
    if (
      now() - startedAt >
      10 * 60 * 1000
    ) {
      throw new Error(
        "Gemini demorou mais de 10 minutos para processar o vídeo."
      );
    }

    console.log(
      "[Gemini Files] Vídeo ainda processando..."
    );

    await sleep(3000);

    current =
      await client.files.get(
        {
          name:
            uploaded.name,
        }
      );
  }

  const state =
    String(
      current.state || ""
    ).toUpperCase();

  if (
    state === "FAILED"
  ) {
    throw new Error(
      "Gemini falhou ao processar o vídeo enviado."
    );
  }

  if (
    state &&
    state !== "ACTIVE"
  ) {
    throw new Error(
      `Gemini retornou estado de arquivo inesperado: ${state}`
    );
  }

  console.log(
    `[Gemini Files] Vídeo pronto: ${current.uri}`
  );

  return {
    name:
      current.name ||
      uploaded.name,

    uri:
      current.uri ||
      uploaded.uri,

    mimeType:
      current.mimeType ||
      uploaded.mimeType ||
      "video/mp4",
  };
}

/* ============================================================
   GEMINI — INTERACTION PARA ARQUIVO LOCAL
============================================================ */

async function requestGeminiUploadedModel(
  model,
  geminiFile,
  prompt
) {
  const client =
    getGeminiClient();

  const interaction =
    await client.interactions.create(
      {
        model,

        store: false,

        input: [
          {
            type: "video",

            uri:
              geminiFile.uri,

            mime_type:
              geminiFile.mimeType ||
              "video/mp4",

            /*
             * Agentic é apropriado para
             * encontrar momentos em vídeos
             * longos porque o modelo pode
             * navegar pela timeline.
             */
            processing:
              "agentic",
          },

          {
            type: "text",
            text: prompt,
          },
        ],

        generation_config: {
          thinking_level:
            "low",
        },

        response_format: {
          type: "text",
          mime_type:
            "application/json",
          schema:
            CLIPS_SCHEMA,
        },
      }
    );

  const outputText =
    interaction?.output_text ||
    "";

  const clips =
    parseGeminiOutput(
      outputText,
      model
    );

  return {
    clips,
    model,
    fallback:
      model !==
      GEMINI_MODEL,
  };
}

/* ============================================================
   GEMINI — FALLBACK DE MODELOS PARA YOUTUBE
============================================================ */

async function analyzeYoutubeWithGemini(
  url
) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY não configurada."
    );
  }

  const prompt =
    buildClipPrompt(
      0
    ) +
    `\n\nVídeo do YouTube:\n${url}`;

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
        await requestGeminiYoutubeModel(
          model,
          url,
          prompt
        );

      if (
        model !==
        GEMINI_MODEL
      ) {
        metrics.geminiFallbacks++;
      }

      console.log(
        `[Gemini] Sucesso com ${model}.`
      );

      return result;
    } catch (error) {
      lastError =
        error;

      const status =
        Number(
          error?.status || 0
        );

      console.warn(
        `[Gemini] ${model} falhou: HTTP ${
          status || "N/A"
        } — ${error.message}`
      );

      if (
        status === 400 ||
        status === 401 ||
        status === 403
      ) {
        throw error;
      }

      if (
        status === 503
      ) {
        console.warn(
          `[Gemini] ${model} sob alta demanda (503). Mudando para próximo modelo...`
        );

        if (
          i <
          models.length - 1
        ) {
          await sleep(600);
          continue;
        }

        break;
      }

      if (
        status === 429
      ) {
        metrics.geminiRetries++;

        console.warn(
          "[Gemini] 429. Retry em 2s..."
        );

        await sleep(
          2000
        );

        try {
          const retryResult =
            await requestGeminiYoutubeModel(
              model,
              url,
              prompt
            );

          if (
            model !==
            GEMINI_MODEL
          ) {
            metrics.geminiFallbacks++;
          }

          console.log(
            `[Gemini] Retry bem-sucedido com ${model}.`
          );

          return retryResult;
        } catch (
          retryError
        ) {
          lastError =
            retryError;

          if (
            i <
            models.length - 1
          ) {
            await sleep(600);
            continue;
          }

          break;
        }
      }

      if (
        i <
        models.length - 1
      ) {
        await sleep(600);
        continue;
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
   GEMINI — FALLBACK DE MODELOS PARA UPLOAD
============================================================ */

async function analyzeUploadedWithGemini(
  uploadItem
) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY não configurada."
    );
  }

  const sourceInfo =
    await validateVideoFile(
      uploadItem.path
    );

  const prompt =
    buildClipPrompt(
      sourceInfo.duration
    );

  /*
   * Evita reenviar o mesmo arquivo
   * para o Gemini caso a análise seja
   * repetida enquanto o upload estiver
   * vivo.
   */
  let geminiFile;

  if (
    uploadItem.geminiFileName &&
    uploadItem.geminiUri
  ) {
    geminiFile = {
      name:
        uploadItem.geminiFileName,

      uri:
        uploadItem.geminiUri,

      mimeType:
        uploadItem.geminiMimeType ||
        "video/mp4",
    };

    console.log(
      `[Gemini Files] Reutilizando arquivo ${geminiFile.name}`
    );
  } else {
    geminiFile =
      await uploadVideoToGemini(
        uploadItem.path
      );

    uploadItem.geminiFileName =
      geminiFile.name;

    uploadItem.geminiUri =
      geminiFile.uri;

    uploadItem.geminiMimeType =
      geminiFile.mimeType;
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
      `[Gemini Upload] Tentando ${model} (${i + 1}/${models.length})...`
    );

    try {
      const result =
        await requestGeminiUploadedModel(
          model,
          geminiFile,
          prompt
        );

      if (
        model !==
        GEMINI_MODEL
      ) {
        metrics.geminiFallbacks++;
      }

      console.log(
        `[Gemini Upload] Sucesso com ${model}.`
      );

      return result;
    } catch (error) {
      lastError =
        error;

      const status =
        Number(
          error?.status ||
          error?.code ||
          0
        );

      console.warn(
        `[Gemini Upload] ${model} falhou: HTTP ${
          status || "N/A"
        } — ${error.message}`
      );

      if (
        status === 400 ||
        status === 401 ||
        status === 403
      ) {
        throw error;
      }

      if (
        status === 503
      ) {
        console.warn(
          `[Gemini Upload] ${model} sob alta demanda.`
        );

        if (
          i <
          models.length - 1
        ) {
          await sleep(600);
          continue;
        }

        break;
      }

      if (
        status === 429
      ) {
        metrics.geminiRetries++;

        console.warn(
          "[Gemini Upload] 429. Retry em 2s..."
        );

        await sleep(
          2000
        );

        try {
          const retryResult =
            await requestGeminiUploadedModel(
              model,
              geminiFile,
              prompt
            );

          if (
            model !==
            GEMINI_MODEL
          ) {
            metrics.geminiFallbacks++;
          }

          return retryResult;
        } catch (
          retryError
        ) {
          lastError =
            retryError;

          if (
            i <
            models.length - 1
          ) {
            await sleep(600);
            continue;
          }

          break;
        }
      }

      if (
        i <
        models.length - 1
      ) {
        await sleep(600);
        continue;
      }
    }
  }

  throw (
    lastError ||
    new Error(
      "Gemini não conseguiu analisar o vídeo enviado."
    )
  );
}

/* ============================================================
   DOWNLOAD ORIGINAL DO YOUTUBE
 *
 * SOMENTE usado quando o usuário escolher
 * trabalhar com uma URL do YouTube.
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

  const failures = [];

  /* ---------------- Downloader externo ---------------- */

  if (
    EXTERNAL_DOWNLOAD_URL
  ) {
    try {
      console.log(
        "[YouTube Download] Downloader externo..."
      );

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
        !response.ok ||
        !response.body
      ) {
        throw new Error(
          `HTTP ${response.status}`
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

      await validateVideoFile(
        outputPath
      );

      console.log(
        "[YouTube Download] Downloader externo OK."
      );

      return outputPath;
    } catch (error) {
      failures.push(
        `Externo: ${error.message}`
      );

      await safeRemove(
        outputPath
      );
    }
  }

  /* ---------------- RapidAPI ---------------- */

  if (RAPIDAPI_KEY) {
    try {
      console.log(
        "[YouTube Download] RapidAPI..."
      );

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
            },

            signal:
              AbortSignal.timeout(
                60000
              ),
          }
        );

      if (
        response.status ===
        403
      ) {
        throw new Error(
          "RapidAPI HTTP 403: cota excedida ou chave expirada."
        );
      }

      if (
        !response.ok
      ) {
        throw new Error(
          `RapidAPI HTTP ${response.status}`
        );
      }

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
            const key of
              Object.keys(
                value
              )
          ) {
            collectUrls(
              value[key]
            );
          }
        };

      collectUrls(data);

      const uniqueUrls =
        [
          ...new Set(
            urls
          ),
        ];

      if (
        !uniqueUrls.length
      ) {
        throw new Error(
          "RapidAPI respondeu sem URLs de mídia."
        );
      }

      let downloaded =
        false;

      for (
        const streamUrl of
          uniqueUrls.slice(
            0,
            5
          )
      ) {
        try {
          const streamResponse =
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
            !streamResponse.ok ||
            !streamResponse.body
          ) {
            continue;
          }

          await safeRemove(
            outputPath
          );

          await pipeline(
            Readable.fromWeb(
              streamResponse.body
            ),
            fs.createWriteStream(
              outputPath
            )
          );

          await validateVideoFile(
            outputPath
          );

          downloaded =
            true;

          break;
        } catch {
          await safeRemove(
            outputPath
          );
        }
      }

      if (!downloaded) {
        throw new Error(
          "Nenhum stream RapidAPI foi validado pelo FFprobe."
        );
      }

      console.log(
        "[YouTube Download] RapidAPI OK."
      );

      return outputPath;
    } catch (error) {
      failures.push(
        `RapidAPI: ${error.message}`
      );

      await safeRemove(
        outputPath
      );
    }
  }

  /* ---------------- yt-dlp ---------------- */

  try {
    console.log(
      "[YouTube Download] yt-dlp..."
    );

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
      result.timedOut
    ) {
      throw new Error(
        "yt-dlp excedeu o tempo limite."
      );
    }

    if (
      result.code !== 0
    ) {
      const stderr =
        redactSecrets(
          result.stderr
        );

      if (
        /sign in to confirm|not a bot|confirm you are not a bot/i.test(
          stderr
        )
      ) {
        throw new Error(
          "O YouTube bloqueou o acesso por proteção anti-bot."
        );
      }

      throw new Error(
        `yt-dlp código ${result.code}: ${stderr.slice(
          -600
        )}`
      );
    }

    await validateVideoFile(
      outputPath
    );

    console.log(
      "[YouTube Download] yt-dlp OK."
    );

    return outputPath;
  } catch (error) {
    failures.push(
      `yt-dlp: ${error.message}`
    );

    await safeRemove(
      outputPath
    );
  }

  throw new Error(
    `Todos os métodos de download do YouTube falharam: ${failures.join(
      " | "
    )}`
  );
}

/* ============================================================
   FFMPEG RENDER
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
    result.timedOut
  ) {
    throw new Error(
      "FFmpeg excedeu o tempo limite de 3 minutos."
    );
  }

  if (
    result.code !== 0
  ) {
    throw new Error(
      `FFmpeg erro: ${redactSecrets(
        result.stderr
      ).slice(-1000)}`
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
      "FFmpeg gerou arquivo MP4 inválido."
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

        ffmpegClips:
          true,

        youtube:
          true,
      },
    });
  }
);

/* ============================================================
   HEALTH
============================================================ */

app.get(
  "/health",
  async (req, res) => {
    const [
      yt,
      ff,
      probe,
    ] = await Promise.all([
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

      uploadMp4:
        true,

      maxUploadMB:
        MAX_UPLOAD_MB,

      uploadTTLMinutes:
        Math.floor(
          UPLOAD_TTL_MS /
            60000
        ),

      geminiConfigured:
        Boolean(
          GEMINI_API_KEY
        ),

      geminiModel:
        GEMINI_MODEL,

      geminiFallbacks:
        GEMINI_FALLBACK_MODELS,

      rapidApiConfigured:
        Boolean(
          RAPIDAPI_KEY
        ),

      rapidApiHost:
        RAPIDAPI_HOST,

      ytDlpCookiesConfigured:
        Boolean(
          YTDLP_COOKIES_FILE
        ),

      ytDlpCookiesFileExists:
        Boolean(
          YTDLP_COOKIES_FILE &&
            fs.existsSync(
              YTDLP_COOKIES_FILE
            )
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
   AUTH
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

      return res.json({
        ok: true,

        token,

        user:
          publicUser(
            user
          ),
      });
    } catch {
      metrics.errors++;

      return jsonError(
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
   UPLOAD DE MP4
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
      async (error) => {
        if (error) {
          metrics.errors++;

          if (
            error.code ===
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
            error.message ||
              "Falha no upload do vídeo."
          );
        }

        if (
          !req.file
        ) {
          return jsonError(
            res,
            400,
            "Nenhum arquivo MP4 foi enviado."
          );
        }

        const filePath =
          req.file.path;

        try {
          console.log(
            `[Upload] Recebendo ${req.file.originalname} (${req.file.size} bytes)...`
          );

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

            geminiFileName:
              "",

            geminiUri:
              "",

            geminiMimeType:
              "video/mp4",
          };

          uploads.set(
            uploadId,
            item
          );

          metrics.uploads++;

          console.log(
            `[Upload] OK ${uploadId} — ${info.duration.toFixed(
              2
            )}s`
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
        } catch (error) {
          metrics.errors++;

          await safeRemove(
            filePath
          );

          console.error(
            "[Upload]",
            error.message
          );

          return jsonError(
            res,
            400,
            error.message ||
              "O arquivo enviado não é um vídeo válido."
          );
        }
      }
    );
  }
);

/* ============================================================
   CONSULTAR UPLOAD
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

      return res.json({
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

          geminiReady:
            Boolean(
              upload.geminiUri
            ),
        },

        user:
          publicUser(
            req.user
          ),
      });
    } catch (error) {
      return jsonError(
        res,
        404,
        error.message
      );
    }
  }
);

/* ============================================================
   EXCLUIR UPLOAD
============================================================ */

app.delete(
  "/api/upload/:id",
  requireUser,
  async (req, res) => {
    try {
      const upload =
        getOwnedUpload(
          req.params.id,
          req.user.id
        );

      await safeRemove(
        upload.path
      );

      uploads.delete(
        upload.id
      );

      return res.json({
        ok: true,
        deleted:
          true,
      });
    } catch (error) {
      return jsonError(
        res,
        404,
        error.message
      );
    }
  }
);

/* ============================================================
   ANALISAR
 *
 * Aceita:
 *
 * 1. YouTube:
 * {
 *   "url": "https://youtube.com/..."
 * }
 *
 * 2. Upload:
 * {
 *   "uploadId": "..."
 * }
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

    /*
     * ---------------- UPLOAD ----------------
     */

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
          `[Analyze Upload] ${upload.id}`
        );

        const result =
          await analyzeUploadedWithGemini(
            upload
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
      } catch (error) {
        metrics.errors++;

        console.error(
          "[Gemini Upload]",
          error.message
        );

        return jsonError(
          res,
          502,
          error.message ||
            "Não foi possível analisar o vídeo enviado."
        );
      }
    }

    /*
     * ---------------- YOUTUBE ----------------
     */

    const videoId =
      youtubeIdFromUrl(
        inputUrl
      );

    if (!videoId) {
      return jsonError(
        res,
        400,
        "Envie um uploadId válido ou um link do YouTube válido."
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
      const result =
        await analyzeYoutubeWithGemini(
          url
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
    } catch (error) {
      metrics.errors++;

      console.error(
        "[Gemini YouTube]",
        error.message
      );

      return jsonError(
        res,
        502,
        error.message ||
          "Não foi possível analisar o vídeo."
      );
    }
  }
);

/* ============================================================
   ANALISAR UPLOAD — ALIAS
 *
 * Endpoint explícito para o frontend novo.
 *
 * POST:
 * {
 *   "uploadId": "..."
 * }
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

      const result =
        await analyzeUploadedWithGemini(
          upload
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
    } catch (error) {
      metrics.errors++;

      console.error(
        "[Analyze Upload]",
        error.message
      );

      return jsonError(
        res,
        502,
        error.message ||
          "Não foi possível analisar o vídeo enviado."
      );
    }
  }
);

/* ============================================================
   DOWNLOAD / RENDER
 *
 * Aceita:
 *
 * UPLOAD:
 * {
 *   uploadId,
 *   start,
 *   duration
 * }
 *
 * YOUTUBE:
 * {
 *   url,
 *   start,
 *   duration
 * }
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

    const duration =
      parseNumber(
        req.body?.duration,
        NaN
      );

    if (
      !Number.isFinite(
        start
      ) ||
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
        duration
      ) ||
      duration < 1 ||
      duration > 90
    ) {
      return jsonError(
        res,
        400,
        "Duração inválida (1-90s)."
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
        `Você não tem pontos suficientes (${DOWNLOAD_COST} necessários).`
      );
    }

    /*
     * Identifica a origem.
     */

    let sourceType =
      "";

    let uploadItem =
      null;

    let youtubeVideoId =
      null;

    if (uploadId) {
      try {
        uploadItem =
          getOwnedUpload(
            uploadId,
            req.user.id
          );

        sourceType =
          "upload";
      } catch (error) {
        return jsonError(
          res,
          404,
          error.message
        );
      }
    } else {
      youtubeVideoId =
        youtubeIdFromUrl(
          inputUrl
        );

      if (
        !youtubeVideoId
      ) {
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

    let charged =
      false;

    try {
      console.log(
        `[Render] Job ${jobId} — origem: ${sourceType}`
      );

      let sourceFile;

      /*
       * ======================================================
       * UPLOAD LOCAL
       * ======================================================
       */

      if (
        sourceType ===
        "upload"
      ) {
        sourceFile =
          uploadItem.path;

        console.log(
          `[Render] Usando vídeo enviado: ${uploadItem.originalName}`
        );
      }

      /*
       * ======================================================
       * YOUTUBE
       * ======================================================
       */

      else {
        const url =
          youtubeUrl(
            inputUrl
          );

        console.log(
          "[Render] Baixando vídeo do YouTube..."
        );

        sourceFile =
          await downloadOriginalVideo(
            url,
            youtubeVideoId,
            workDir
          );
      }

      /*
       * ======================================================
       * VALIDAR VÍDEO
       * ======================================================
       */

      const sourceInfo =
        await validateVideoFile(
          sourceFile
        );

      if (
        start >=
        sourceInfo.duration
      ) {
        throw new Error(
          `Início (${start}s) além da duração (${sourceInfo.duration.toFixed(
            2
          )}s).`
        );
      }

      /*
       * Nunca deixamos o corte
       * ultrapassar o vídeo.
       */

      const safeDuration =
        Math.min(
          duration,
          Math.max(
            1,
            sourceInfo.duration -
              start
          )
        );

      /*
       * ======================================================
       * FFMPEG
       * ======================================================
       */

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
          "MP4 final inválido."
        );
      }

      /*
       * ======================================================
       * COBRAR SOMENTE DEPOIS
       * DO RENDER TER DADO CERTO
       * ======================================================
       */

      if (
        !req.user.vip
      ) {
        req.user.points -=
          DOWNLOAD_COST;

        charged =
          true;
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

      /*
       * ======================================================
       * NOME DO ARQUIVO
       * ======================================================
       */

      let filename;

      if (
        sourceType ===
        "upload"
      ) {
        const base =
          path
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
            .slice(
              0,
              60
            );

        filename =
          `clipforge_${base}_${Math.floor(
            start
          )}s.mp4`;
      } else {
        filename =
          `clipforge_${youtubeVideoId}_${Math.floor(
            start
          )}s.mp4`;
      }

      /*
       * ======================================================
       * STREAM DO MP4
       * ======================================================
       */

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

      let cleaned =
        false;

      const safeCleanDir =
        async () => {
          if (cleaned) {
            return;
          }

          cleaned =
            true;

          await cleanup(
            workDir
          );
        };

      stream.on(
        "error",
        async (error) => {
          console.error(
            "[Download Stream]",
            error
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
    } catch (error) {
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
        error.message ||
          "Erro ao renderizar o vídeo."
      );
    }
  }
);

/* ============================================================
   MERCADO PAGO / PIX
============================================================ */

async function mercadoPagoRequest(
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
      `${MP_API}${endpoint}`,
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

  const data =
    await response
      .json()
      .catch(
        () => null
      );

  if (
    !response.ok
  ) {
    throw new Error(
      data?.message ||
        `Mercado Pago HTTP ${response.status}`
    );
  }

  return data;
}

app.post(
  "/api/pix/criar",
  requireUser,
  async (req, res) => {
    if (
      !MP_ACCESS_TOKEN
    ) {
      return jsonError(
        res,
        503,
        "Pix não configurado."
      );
    }

    try {
      const payment =
        await mercadoPagoRequest(
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
          tx.qr_code || "",

        qr_code_base64:
          tx.qr_code_base64 ||
          "",

        ticket_url:
          tx.ticket_url || "",

        amount:
          VIP_PRICE,
      });
    } catch (error) {
      metrics.errors++;

      return jsonError(
        res,
        502,
        error.message ||
          "Erro criando Pix."
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

    if (
      !localPayment
    ) {
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
      const payment =
        await mercadoPagoRequest(
          `/v1/payments/${encodeURIComponent(
            paymentId
          )}`,
          {
            method:
              "GET",
          }
        );

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
    } catch (error) {
      metrics.errors++;

      return jsonError(
        res,
        502,
        error.message ||
          "Erro consultando Pix."
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
    if (
      !ADMIN_PASSWORD
    ) {
      return jsonError(
        res,
        503,
        "ADMIN_PASSWORD não configurada."
      );
    }

    const password =
      String(
        req.body?.password ||
          ""
      );

    if (
      password !==
      ADMIN_PASSWORD
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
      const user of
        users.values()
    ) {
      if (
        user.vip
      ) {
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
   404
============================================================ */

app.use(
  (req, res) =>
    jsonError(
      res,
      404,
      "Endpoint não encontrado."
    )
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
    metrics.errors++;

    console.error(
      "[Server Error]",
      err
    );

    if (
      !res.headersSent
    ) {
      jsonError(
        res,
        500,
        "Erro interno do servidor."
      );
    }
  }
);

/* ============================================================
   START SERVER
============================================================ */

async function startServer() {
  try {
    await ensureDirectories();

    /*
     * Limpa uploads antigos que eventualmente
     * tenham ficado no disco após reinício.
     */
    await cleanupExpiredUploads();

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
        )
      }`
    );

    console.log(
      `Upload MP4: ATIVO — limite ${MAX_UPLOAD_MB} MB`
    );

    console.log(
      `Upload TTL: ${Math.floor(
        UPLOAD_TTL_MS /
          60000
      )} minutos`
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
      `RapidAPI: ${
        RAPIDAPI_KEY
          ? "CONFIGURADA"
          : "NÃO CONFIGURADA"
      }`
    );

    console.log(
      `Cookies yt-dlp: ${
        YTDLP_COOKIES_FILE
          ? YTDLP_COOKIES_FILE
          : "NÃO CONFIGURADOS"
      }`
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

    if (!ffOk) {
      console.warn(
        "[Startup] ATENÇÃO: FFmpeg não está disponível."
      );
    }

    if (!probeOk) {
      console.warn(
        "[Startup] ATENÇÃO: FFprobe não está disponível."
      );
    }

    app.listen(
      PORT,
      HOST,
      () => {
        console.log(
          `ClipForge Pro Backend ${VERSION} online em http://${HOST}:${PORT}`
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