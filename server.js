/**
 * ============================================================
 * CLIPFORGE PRO — BACKEND 13.2.4 COMPLETO
 * Node.js + Express
 *
 * PRINCIPAIS RECURSOS
 * ------------------------------------------------------------
 * - Gemini REST nativo para Upload e Inferência
 * - Gemini Files API para MP4 (v1beta/files)
 * - Gemini Interactions API para YouTube
 * - URLs Gemini limpas e tratadas
 * - Fallback automático de modelos com tratamento 404/429/503/504
 * - Upload MP4 direto até 150 MB (independente de YouTube)
 * - FFmpeg e FFprobe com resolução real por teste de execução
 * - yt-dlp com suporte a cookies
 * - Mercado Pago PIX e Dashboard Administrativo
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
const VERSION = "13.2.4";

const FREE_POINTS = Number(process.env.FREE_POINTS || 200);
const DAILY_POINTS = Number(process.env.DAILY_POINTS || 50);
const DOWNLOAD_COST = Number(process.env.DOWNLOAD_COST || 50);
const VIP_PRICE = Number(process.env.VIP_PRICE || 19.90);
const MAX_CLIPS = Number(process.env.MAX_CLIPS || 5);

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 150);
const MAX_UPLOAD_BYTES = Math.floor(MAX_UPLOAD_MB * 1024 * 1024);
const UPLOAD_TTL_MS = Number(process.env.UPLOAD_TTL_MS || 2 * 60 * 60 * 1000);

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
  .filter((v, i, arr) => arr.indexOf(v) === i && v !== GEMINI_MODEL);

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
    if (Number.isFinite(n) && n >= 100 && n <= 599) {
      return n;
    }
  }

  const message = String(err?.message || "");
  const match = message.match(/\b(400|401|403|404|408|409|429|500|502|503|504)\b/);
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

const EXTERNAL_DOWNLOAD_URL = process.env.EXTERNAL_DOWNLOAD_URL || "";
const EXTERNAL_DOWNLOAD_TOKEN = process.env.EXTERNAL_DOWNLOAD_TOKEN || "";

/* ============================================================
   MERCADO PAGO
============================================================ */

const MP_ACCESS_TOKEN =
  process.env.MP_ACCESS_TOKEN ||
  process.env.MERCADOPAGO_ACCESS_TOKEN ||
  "";

const MP_API = "https://api.mercadopago.com";

/* ============================================================
   DIRETÓRIOS
============================================================ */

const TEMP_ROOT = path.join(os.tmpdir(), "clipforge-pro");
const DOWNLOAD_DIR = path.join(TEMP_ROOT, "downloads");
const OUTPUT_DIR = path.join(TEMP_ROOT, "outputs");
const UPLOAD_DIR = path.join(TEMP_ROOT, "uploads");

/* ============================================================
   BINÁRIOS
============================================================ */

let FFMPEG_BIN = "ffmpeg";
let FFPROBE_BIN = "ffprobe";
let YTDLP_BIN = "yt-dlp";

const YTDLP_COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || "";

function fileExists(filePath) {
  if (!filePath) return false;
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function chmodExecutable(filePath) {
  if (!filePath) return;
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {}
}

/* ============================================================
   ESTADO EM MEMÓRIA & MÉTRICAS
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
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-User-Id"],
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

app.use((req, res, next) => {
  metrics.requests++;
  res.setHeader("X-ClipForge-Version", VERSION);
  next();
});

/* ============================================================
   MULTER
============================================================ */

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, `${crypto.randomUUID()}.mp4`);
  },
});

const videoUpload = multer({
  storage: uploadStorage,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    const originalName = String(file.originalname || "");
    const ext = path.extname(originalName).toLowerCase();
    const mime = String(file.mimetype || "").toLowerCase();

    const validExtension = ext === ".mp4";
    const validMime =
      mime === "video/mp4" ||
      mime === "application/mp4" ||
      mime === "application/octet-stream";

    if (validExtension && validMime) {
      return cb(null, true);
    }
    return cb(new Error("Somente arquivos MP4 são aceitos."));
  },
});

/* ============================================================
   HELPERS
============================================================ */

function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function safeUserId(value) {
  if (!value) return null;
  const v = String(value).trim();
  return /^[A-Za-z0-9_-]{6,128}$/.test(v) ? v : null;
}

function safeUploadId(value) {
  if (!value) return null;
  const v = String(value).trim();
  return /^[a-f0-9-]{20,100}$/i.test(v) ? v : null;
}

function getBearer(req) {
  const header = req.headers.authorization || "";
  return header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
}

function parseNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function jsonError(res, status, message, extra = {}) {
  return res.status(status).json({
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
          secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
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
    await fsp.rm(filePath, { force: true, recursive: true });
  } catch {}
}

async function cleanup(...files) {
  await Promise.all(
    files.filter(Boolean).map((file) => safeRemove(file))
  );
}

function youtubeIdFromUrl(value) {
  if (!value) return null;
  const input = String(value).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;

  const patterns = [
    /(?:youtube\.com\/watch\?[^#]*?v=)([A-Za-z0-9_-]{11})/i,
    /(?:youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/i,
    /(?:youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/i,
    /(?:youtube\.com\/live\/)([A-Za-z0-9_-]{11})/i,
    /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/i,
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function youtubeUrl(value) {
  const id = youtubeIdFromUrl(value);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

/* ============================================================
   PROCESSOS
============================================================ */

function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeout = 0, ...spawnOptions } = options;
    const child = spawn(command, args, { windowsHide: true, ...spawnOptions });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let termTimer = null;
    let killTimer = null;

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
      if (stdout.length > 500000) stdout = stdout.slice(-500000);
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
      if (stderr.length > 500000) stderr = stderr.slice(-500000);
    });

    child.on("error", (err) => {
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        code: Number.isInteger(code) ? code : -1,
        signal: signal || null,
        stdout,
        stderr,
        timedOut,
      });
    });

    if (Number.isFinite(timeout) && timeout > 0) {
      termTimer = setTimeout(() => {
        timedOut = true;
        console.warn(`[Process] Timeout de ${timeout}ms: ${command}`);
        try {
          child.kill("SIGTERM");
        } catch {}

        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 4000);
      }, timeout);
    }
  });
}

async function commandExists(command) {
  try {
    const result = await spawnCapture(command, ["--version"], {
      timeout: 15000,
    });

    if (result.code === 0) {
      return true;
    }

    console.warn(`[Binary] ${command} retornou código ${result.code}`);
    if (result.stderr) {
      console.warn(`[Binary] stderr: ${redactSecrets(result.stderr).slice(-500)}`);
    }
    return false;
  } catch (err) {
    console.warn(`[Binary] Falha executando ${command}: ${err.message}`);
    return false;
  }
}

/* ============================================================
   RESOLUÇÃO REAL DOS BINÁRIOS
============================================================ */

async function resolveExecutable(label, candidates) {
  console.log(`[Binary] Procurando ${label}...`);
  const tested = [];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const value = String(candidate).trim();
    if (!value) continue;

    if (
      value !== "ffmpeg" &&
      value !== "ffprobe" &&
      value !== "yt-dlp" &&
      !fileExists(value)
    ) {
      continue;
    }

    if (fileExists(value)) {
      chmodExecutable(value);
    }

    const ok = await commandExists(value);
    tested.push({ candidate: value, ok });

    if (ok) {
      console.log(`[Binary] ${label} encontrado: ${value}`);
      return value;
    }

    console.warn(`[Binary] ${label} inválido: ${value}`);
  }

  console.error(`[Binary] ${label} não encontrado.`);
  for (const item of tested) {
    console.error(`[Binary] Testado: ${item.candidate} => ${item.ok ? "OK" : "ERRO"}`);
  }
  return null;
}

async function resolveBinaries() {
  let installerFfmpeg = null;
  let staticFfmpeg = null;
  let installerFfprobe = null;

  try {
    installerFfmpeg = require("@ffmpeg-installer/ffmpeg").path;
  } catch {}

  try {
    staticFfmpeg = require("ffmpeg-static");
  } catch {}

  try {
    installerFfprobe = require("@ffprobe-installer/ffprobe").path;
  } catch {}

  if (installerFfmpeg) chmodExecutable(installerFfmpeg);
  if (staticFfmpeg) chmodExecutable(staticFfmpeg);
  if (installerFfprobe) chmodExecutable(installerFfprobe);

  FFMPEG_BIN =
    (await resolveExecutable("FFmpeg", [
      path.join(process.cwd(), "bin", "ffmpeg"),
      process.env.FFMPEG_PATH,
      process.env.FFMPEG_BIN,
      installerFfmpeg,
      staticFfmpeg,
      "ffmpeg",
    ])) || "ffmpeg";

  FFPROBE_BIN =
    (await resolveExecutable("FFprobe", [
      path.join(process.cwd(), "bin", "ffprobe"),
      process.env.FFPROBE_PATH,
      process.env.FFPROBE_BIN,
      installerFfprobe,
      "ffprobe",
    ])) || "ffprobe";

  YTDLP_BIN =
    (await resolveExecutable("yt-dlp", [
      path.join(process.cwd(), "bin", "yt-dlp"),
      process.env.YTDLP_PATH,
      process.env.YTDLP_BIN,
      path.join(process.cwd(), "yt-dlp"),
      "yt-dlp",
    ])) || "yt-dlp";
}

/* ============================================================
   DIRETÓRIOS
============================================================ */

async function ensureDirectories() {
  await fsp.mkdir(TEMP_ROOT, { recursive: true });
  await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
}

/* ============================================================
   FFPROBE
============================================================ */

async function validateVideoFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("Arquivo não encontrado.");
  }

  const stat = await fsp.stat(filePath);
  if (stat.size < 10000) {
    throw new Error(`Arquivo muito pequeno (${stat.size} bytes).`);
  }

  const probe = await spawnCapture(
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
    { timeout: 30000 }
  );

  if (probe.code !== 0) {
    throw new Error(
      `FFprobe rejeitou o arquivo: ${redactSecrets(probe.stderr).slice(-500)}`
    );
  }

  let data;
  try {
    data = JSON.parse(probe.stdout);
  } catch {
    throw new Error("FFprobe retornou dados inválidos.");
  }

  const duration = Number(data?.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Duração de vídeo inválida.");
  }

  return {
    duration,
    size: stat.size,
    format: data?.format?.format_name || "",
  };
}

/* ============================================================
   UPLOADS
============================================================ */

function getOwnedUpload(uploadId, userId) {
  const id = safeUploadId(uploadId);
  if (!id) throw new Error("uploadId inválido.");

  const item = uploads.get(id);
  if (!item) throw new Error("Upload não encontrado ou expirado.");
  if (item.userId !== userId) throw new Error("Esse vídeo não pertence a esta conta.");

  if (!fs.existsSync(item.path)) {
    uploads.delete(id);
    throw new Error("O arquivo enviado não está mais disponível.");
  }
  return item;
}

async function cleanupExpiredUploads() {
  const cutoff = now() - UPLOAD_TTL_MS;
  let removed = 0;

  for (const [id, item] of uploads.entries()) {
    if (item.createdAt < cutoff) {
      await safeRemove(item.path);
      uploads.delete(id);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`[Upload Cleanup] ${removed} upload(s) expirado(s) removido(s).`);
  }
}

const uploadCleanupTimer = setInterval(() => {
  cleanupExpiredUploads().catch((err) =>
    console.error("[Upload Cleanup]", err)
  );
}, 10 * 60 * 1000);
uploadCleanupTimer.unref?.();

/* ============================================================
   SCHEMA GEMINI
============================================================ */

const CLIPS_SCHEMA = {
  type: "object",
  properties: {
    clips: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: { type: "number" },
          end: { type: "number" },
          duration: { type: "number" },
          title: { type: "string" },
          description: { type: "string" },
          score: { type: "number" },
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
  required: ["clips"],
};

/* ============================================================
   NORMALIZAÇÃO
============================================================ */

function normalizeGeminiClips(parsed) {
  if (!parsed || !Array.isArray(parsed.clips)) {
    throw new Error("Gemini não retornou a lista de clips.");
  }

  const clips = parsed.clips
    .map((c, i) => {
      const start = Math.max(0, parseNumber(c.start, 0));
      const rawDur = parseNumber(
        c.duration,
        parseNumber(c.end, start + 50) - start
      );
      const duration = clamp(rawDur, 20, 60);

      return {
        start: Number(start.toFixed(2)),
        end: Number((start + duration).toFixed(2)),
        duration: Number(duration.toFixed(2)),
        title: String(c.title || `Corte #${i + 1}`).slice(0, 140),
        description: String(c.description || "Destaque selecionado por IA").slice(0, 500),
        score: clamp(Math.round(parseNumber(c.score, 80)), 0, 100),
      };
    })
    .filter((c) => c.duration >= 20 && c.duration <= 60)
    .slice(0, MAX_CLIPS);

  if (!clips.length) {
    throw new Error("Gemini não encontrou cortes válidos.");
  }

  return clips;
}

/* ============================================================
   PARSE GEMINI
============================================================ */

function parseGeminiOutput(outputText, model) {
  let outText = String(outputText || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  if (!outText) {
    throw new Error(`Gemini (${model}) não retornou conteúdo.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(outText);
  } catch {
    const match = outText.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(`Gemini (${model}) não retornou JSON estruturado.`);
    }
    parsed = JSON.parse(match[0]);
  }

  return normalizeGeminiClips(parsed);
}

/* ============================================================
   PROMPT
============================================================ */

function buildClipPrompt(duration) {
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
- momentos emocionantes;
- informações surpreendentes;
- opiniões fortes;
- histórias completas;
- contexto suficiente;
- frases que funcionem fora do vídeo original.

Evite:
- introduções vazias;
- silêncio;
- pausas longas;
- cortes no meio de frases;
- momentos sem contexto;
- trechos pouco interessantes.

Para cada corte informe:
- start;
- end;
- duration;
- title;
- description;
- score de 0 a 100.

Retorne SOMENTE o JSON estruturado de acordo com o schema solicitado.
`.trim();
}

/* ============================================================
   GEMINI FILES API (REST NATIVO)
============================================================ */

async function uploadVideoToGemini(filePath) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY não configurada.");
  }

  console.log(`[Gemini Files] Enviando vídeo via REST: ${path.basename(filePath)}`);
  const stat = await fsp.stat(filePath);

  /* ----------------------------------------------------------
     1. INICIAR UPLOAD RESUMABLE
  ---------------------------------------------------------- */
  const initUrl = `[https://generativelanguage.googleapis.com/upload/v1beta/files?key=$](https://generativelanguage.googleapis.com/upload/v1beta/files?key=$){encodeURIComponent(
    GEMINI_API_KEY
  )}`;

  const initRes = await fetch(initUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(stat.size),
      "X-Goog-Upload-Header-Content-Type": "video/mp4",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      file: {
        display_name: path.basename(filePath),
      },
    }),
  });

  if (!initRes.ok) {
    const errorText = await initRes.text();
    throw new Error(
      `Falha ao iniciar upload Gemini: HTTP ${initRes.status} — ${redactSecrets(
        errorText
      ).slice(-600)}`
    );
  }

  const uploadUrl = initRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new Error("Header de upload do Gemini não retornado.");
  }

  /* ----------------------------------------------------------
     2. ENVIAR BYTES
  ---------------------------------------------------------- */
  const buffer = await fsp.readFile(filePath);
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(stat.size),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: buffer,
  });

  if (!uploadRes.ok) {
    const errorText = await uploadRes.text();
    throw new Error(
      `Erro ao enviar bytes para Gemini: HTTP ${uploadRes.status} — ${redactSecrets(
        errorText
      ).slice(-600)}`
    );
  }

  const fileData = await uploadRes.json();
  const fileUri = fileData?.file?.uri;
  const fileName = fileData?.file?.name;

  if (!fileUri || !fileName) {
    throw new Error("Gemini Files API não retornou URI válida.");
  }

  metrics.geminiFileUploads++;
  console.log(`[Gemini Files] Registrado: ${fileName}`);

  /* ----------------------------------------------------------
     3. AGUARDAR PROCESSAMENTO
  ---------------------------------------------------------- */
  const startedAt = Date.now();
  while (true) {
    if (Date.now() - startedAt > 10 * 60 * 1000) {
      throw new Error("Gemini demorou mais de 10 minutos para processar o vídeo.");
    }

    const checkUrl = `[https://generativelanguage.googleapis.com/v1beta/$](https://generativelanguage.googleapis.com/v1beta/$){fileName}?key=${encodeURIComponent(
      GEMINI_API_KEY
    )}`;

    const checkRes = await fetch(checkUrl, {
      headers: { Accept: "application/json" },
    });

    const checkData = await checkRes.json().catch(() => ({}));
    if (!checkRes.ok) {
      throw new Error(
        `Erro ao consultar arquivo Gemini: HTTP ${checkRes.status} — ${
          checkData?.error?.message || "erro desconhecido"
        }`
      );
    }

    const state = String(checkData.state || "").toUpperCase();
    if (state === "ACTIVE") break;
    if (state === "FAILED") throw new Error("Gemini falhou ao processar o vídeo.");

    console.log(`[Gemini Files] Estado: ${state || "PROCESSANDO"}`);
    await sleep(3000);
  }

  console.log(`[Gemini Files] Vídeo pronto: ${fileUri}`);
  return {
    uri: fileUri,
    name: fileName,
    mimeType: "video/mp4",
  };
}

/* ============================================================
   GEMINI GENERATE CONTENT
============================================================ */

async function requestGeminiUploadedModel(model, geminiFile, prompt) {
  const url = `[https://generativelanguage.googleapis.com/v1beta/models/$](https://generativelanguage.googleapis.com/v1beta/models/$){encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const body = {
    contents: [
      {
        parts: [
          {
            file_data: {
              mime_type: geminiFile.mimeType,
              file_uri: geminiFile.uri,
            },
          },
          {
            text: prompt,
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: CLIPS_SCHEMA,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = new Error(data?.error?.message || `HTTP ${response.status}`);
    err.status = response.status;
    err.model = model;
    throw err;
  }

  const textOutput =
    data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

  return {
    clips: parseGeminiOutput(textOutput, model),
    model,
    fallback: model !== GEMINI_MODEL,
  };
}

/* ============================================================
   GEMINI INTERACTIONS — YOUTUBE
============================================================ */

async function requestGeminiYoutubeModel(model, url, prompt) {
  const body = {
    model,
    input: [
      {
        type: "text",
        text: prompt,
      },
      {
        type: "video",
        uri: url,
      },
    ],
    generation_config: {
      thinking_level: "low",
    },
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema: CLIPS_SCHEMA,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let response;

  try {
    response = await fetch(
      "[https://generativelanguage.googleapis.com/v1beta/interactions](https://generativelanguage.googleapis.com/v1beta/interactions)",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }
    );
  } catch (err) {
    if (err?.name === "AbortError") {
      const e = new Error(`Gemini (${model}) excedeu o tempo limite de 120 segundos.`);
      e.status = 504;
      e.model = model;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const detail =
      data?.error?.message || data?.message || "Erro na API Gemini.";
    const err = new Error(`Gemini HTTP ${response.status}: ${detail}`);
    err.status = response.status;
    err.model = model;
    throw err;
  }

  let outText =
    data?.output_text || data?.outputText || data?.text || "";

  if (!outText && Array.isArray(data?.steps)) {
    for (const step of data.steps) {
      if (Array.isArray(step?.content)) {
        for (const content of step.content) {
          if (content?.text) {
            outText += content.text + "\n";
          }
        }
      }
    }
  }

  if (!outText) {
    outText = JSON.stringify(data);
  }

  return {
    clips: parseGeminiOutput(outText, model),
    model,
    fallback: model !== GEMINI_MODEL,
  };
}

/* ============================================================
   ANÁLISE YOUTUBE
============================================================ */

async function analyzeYoutubeWithGemini(url) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY não configurada.");
  }

  const prompt = buildClipPrompt(0) + `\n\nVídeo do YouTube:\n${url}`;
  const models = [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS];
  let lastError = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    console.log(`[Gemini] Tentando ${model} (${i + 1}/${models.length})...`);

    try {
      const result = await requestGeminiYoutubeModel(model, url, prompt);
      if (model !== GEMINI_MODEL) {
        metrics.geminiFallbacks++;
      }
      console.log(`[Gemini] Sucesso com ${model}.`);
      return result;
    } catch (err) {
      lastError = err;
      const status = getGeminiErrorStatus(err);
      console.warn(`[Gemini] ${model} falhou: HTTP ${status || "N/A"} — ${err.message}`);

      if (status === 400 || status === 401 || status === 403) {
        throw err;
      }

      if (status === 404 || status === 504) {
        if (i < models.length - 1) continue;
        break;
      }

      if (status === 503) {
        if (i < models.length - 1) {
          await sleep(600);
          continue;
        }
        break;
      }

      if (status === 429) {
        metrics.geminiRetries++;
        await sleep(2000);
        try {
          const retryRes = await requestGeminiYoutubeModel(model, url, prompt);
          if (model !== GEMINI_MODEL) {
            metrics.geminiFallbacks++;
          }
          return retryRes;
        } catch (retryErr) {
          lastError = retryErr;
          if (i < models.length - 1) {
            await sleep(600);
            continue;
          }
          break;
        }
      }

      if (i < models.length - 1) {
        await sleep(600);
        continue;
      }
    }
  }

  throw lastError || new Error("Gemini indisponível no momento.");
}

/* ============================================================
   ANÁLISE UPLOAD
============================================================ */

async function analyzeUploadedWithGemini(uploadItem) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY não configurada.");
  }

  const sourceInfo = await validateVideoFile(uploadItem.path);
  const prompt = buildClipPrompt(sourceInfo.duration);

  let geminiFile;
  if (uploadItem.geminiFileName && uploadItem.geminiUri) {
    geminiFile = {
      name: uploadItem.geminiFileName,
      uri: uploadItem.geminiUri,
      mimeType: uploadItem.geminiMimeType || "video/mp4",
    };
  } else {
    geminiFile = await uploadVideoToGemini(uploadItem.path);
    uploadItem.geminiFileName = geminiFile.name;
    uploadItem.geminiUri = geminiFile.uri;
    uploadItem.geminiMimeType = geminiFile.mimeType;
  }

  const models = [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS];
  let lastError = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    console.log(`[Gemini Upload] Tentando ${model} (${i + 1}/${models.length})...`);

    try {
      const result = await requestGeminiUploadedModel(model, geminiFile, prompt);
      if (model !== GEMINI_MODEL) {
        metrics.geminiFallbacks++;
      }
      console.log(`[Gemini Upload] Sucesso com ${model}.`);
      return result;
    } catch (err) {
      lastError = err;
      const status = getGeminiErrorStatus(err);
      console.warn(`[Gemini Upload] ${model} falhou: HTTP ${status || "N/A"} — ${err.message}`);

      if (status === 400 || status === 401 || status === 403) {
        throw err;
      }

      if (status === 404 || status === 504) {
        if (i < models.length - 1) continue;
        break;
      }

      if (status === 503) {
        if (i < models.length - 1) {
          await sleep(600);
          continue;
        }
        break;
      }

      if (status === 429) {
        metrics.geminiRetries++;
        await sleep(2000);
        try {
          const retryRes = await requestGeminiUploadedModel(model, geminiFile, prompt);
          if (model !== GEMINI_MODEL) {
            metrics.geminiFallbacks++;
          }
          return retryRes;
        } catch (retryErr) {
          lastError = retryErr;
          if (i < models.length - 1) {
            await sleep(600);
            continue;
          }
          break;
        }
      }

      if (i < models.length - 1) {
        await sleep(600);
        continue;
      }
    }
  }

  throw lastError || new Error("Gemini não conseguiu analisar o vídeo enviado.");
}

/* ============================================================
   DOWNLOAD YOUTUBE
============================================================ */

async function downloadOriginalVideo(url, videoId, workDir) {
  const outputPath = path.join(workDir, "source.mp4");
  const failures = [];

  /* ----------------------------------------------------------
     1. DOWNLOAD EXTERNO
  ---------------------------------------------------------- */
  if (EXTERNAL_DOWNLOAD_URL) {
    try {
      console.log("[YouTube Download] Tentando Downloader Externo...");
      const response = await fetch(EXTERNAL_DOWNLOAD_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(EXTERNAL_DOWNLOAD_TOKEN
            ? { Authorization: `Bearer ${EXTERNAL_DOWNLOAD_TOKEN}` }
            : {}),
        },
        body: JSON.stringify({
          url,
          videoId,
          output: "mp4",
        }),
        signal: AbortSignal.timeout(180000),
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      await pipeline(
        Readable.fromWeb(response.body),
        fs.createWriteStream(outputPath)
      );

      await validateVideoFile(outputPath);
      return outputPath;
    } catch (err) {
      failures.push(`Externo: ${err.message}`);
      await safeRemove(outputPath);
    }
  }

  /* ----------------------------------------------------------
     2. RAPIDAPI
  ---------------------------------------------------------- */
  if (RAPIDAPI_KEY) {
    try {
      console.log("[YouTube Download] Tentando RapidAPI...");
      const endpoint = `https://${RAPIDAPI_HOST}/dl?id=${encodeURIComponent(
        videoId
      )}&cgeo=BR`;

      const response = await fetch(endpoint, {
        method: "GET",
        headers: {
          "x-rapidapi-key": RAPIDAPI_KEY,
          "x-rapidapi-host": RAPIDAPI_HOST,
        },
        signal: AbortSignal.timeout(60000),
      });

      if (response.status === 403) {
        throw new Error("RapidAPI HTTP 403: cota esgotada ou chave inválida.");
      }

      if (!response.ok) {
        throw new Error(`RapidAPI HTTP ${response.status}`);
      }

      const data = await response.json();
      const urls = [];

      const collectUrls = (value) => {
        if (!value || typeof value !== "object") return;
        if (typeof value.url === "string" && value.url.startsWith("http")) {
          urls.push(value.url);
        }
        for (const key of Object.keys(value)) {
          collectUrls(value[key]);
        }
      };

      collectUrls(data);
      const uniqueUrls = [...new Set(urls)];

      if (!uniqueUrls.length) {
        throw new Error("RapidAPI respondeu sem URLs de mídia.");
      }

      let downloaded = false;
      for (const streamUrl of uniqueUrls.slice(0, 5)) {
        try {
          const streamResponse = await fetch(streamUrl, {
            signal: AbortSignal.timeout(120000),
          });

          if (!streamResponse.ok || !streamResponse.body) continue;

          await safeRemove(outputPath);
          await pipeline(
            Readable.fromWeb(streamResponse.body),
            fs.createWriteStream(outputPath)
          );

          await validateVideoFile(outputPath);
          downloaded = true;
          break;
        } catch {
          await safeRemove(outputPath);
        }
      }

      if (!downloaded) {
        throw new Error("Nenhum stream RapidAPI validado.");
      }
      return outputPath;
    } catch (err) {
      failures.push(`RapidAPI: ${err.message}`);
      await safeRemove(outputPath);
    }
  }

  /* ----------------------------------------------------------
     3. YT-DLP
  ---------------------------------------------------------- */
  try {
    console.log("[YouTube Download] Tentando yt-dlp local...");
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

    if (YTDLP_COOKIES_FILE && fs.existsSync(YTDLP_COOKIES_FILE)) {
      args.push("--cookies", YTDLP_COOKIES_FILE);
    }

    args.push(url);

    const result = await spawnCapture(YTDLP_BIN, args, {
      timeout: 300000,
    });

    if (result.timedOut) {
      throw new Error("yt-dlp excedeu o tempo limite.");
    }

    if (result.code !== 0) {
      const stderr = redactSecrets(result.stderr);
      if (/sign in to confirm|not a bot|confirm you are not a bot/i.test(stderr)) {
        throw new Error("O YouTube bloqueou o acesso por proteção anti-bot.");
      }
      throw new Error(`yt-dlp código ${result.code}: ${stderr.slice(-600)}`);
    }

    await validateVideoFile(outputPath);
    return outputPath;
  } catch (err) {
    failures.push(`yt-dlp: ${err.message}`);
    await safeRemove(outputPath);
  }

  throw new Error(
    `Todos os métodos de download do YouTube falharam: ${failures.join(" | ")}`
  );
}

/* ============================================================
   FFMPEG
============================================================ */

async function renderClip(sourceFile, outputFile, start, duration) {
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

  const result = await spawnCapture(FFMPEG_BIN, args, {
    timeout: 180000,
  });

  if (result.timedOut) {
    throw new Error("FFmpeg excedeu o tempo limite de 3 minutos.");
  }

  if (result.code !== 0) {
    throw new Error(`FFmpeg erro: ${redactSecrets(result.stderr).slice(-1000)}`);
  }

  const stat = await fsp.stat(outputFile);
  if (!stat.size || stat.size < 10000) {
    throw new Error("Arquivo MP4 final inválido.");
  }

  return outputFile;
}

/* ============================================================
   ROTAS GERAIS
============================================================ */

app.get("/", (req, res) => {
  res.json({
    name: "ClipForge Pro",
    version: VERSION,
    status: "online",
    features: {
      uploadMp4: true,
      geminiVideoAnalysis: true,
      ffmpegClips: true,
      youtube: true,
    },
  });
});

app.get("/health", async (req, res) => {
  const [yt, ff, probe] = await Promise.all([
    commandExists(YTDLP_BIN).catch(() => false),
    commandExists(FFMPEG_BIN).catch(() => false),
    commandExists(FFPROBE_BIN).catch(() => false),
  ]);

  res.json({
    ok: true,
    version: VERSION,
    ytDlp: yt,
    ffmpeg: ff,
    ffprobe: probe,
    binaries: {
      ffmpeg: FFMPEG_BIN,
      ffprobe: FFPROBE_BIN,
      ytDlp: YTDLP_BIN,
    },
    uploadMp4: true,
    maxUploadMB: MAX_UPLOAD_MB,
    geminiConfigured: Boolean(GEMINI_API_KEY),
    geminiModel: GEMINI_MODEL,
    geminiFallbacks: GEMINI_FALLBACK_MODELS,
    rapidApiConfigured: Boolean(RAPIDAPI_KEY),
    rapidApiHost: RAPIDAPI_HOST,
    ytDlpCookiesConfigured: Boolean(YTDLP_COOKIES_FILE),
    ytDlpCookiesFileExists: Boolean(
      YTDLP_COOKIES_FILE && fs.existsSync(YTDLP_COOKIES_FILE)
    ),
    mercadoPagoConfigured: Boolean(MP_ACCESS_TOKEN),
    activeUploads: uploads.size,
    uptime: process.uptime(),
    metrics,
  });
});

/* ============================================================
   USUÁRIOS
============================================================ */

function claimDailyPoints(user) {
  const day = new Date().toISOString().slice(0, 10);
  const prev = user.lastDailyClaim
    ? new Date(user.lastDailyClaim).toISOString().slice(0, 10)
    : "";

  if (day !== prev) {
    user.points += DAILY_POINTS;
    user.lastDailyClaim = now();
  }
}

function ensureUser(userId) {
  const id = safeUserId(userId) || crypto.randomUUID();
  let user = users.get(id);

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

function publicUser(user) {
  return {
    id: user.id,
    points: Math.max(0, Math.floor(user.points)),
    vip: Boolean(user.vip),
  };
}

/* ============================================================
   AUTH
============================================================ */

function sessionUser(req) {
  const token = getBearer(req);
  if (!token) return null;

  const session = sessions.get(token);
  if (!session || session.expiresAt < now()) {
    if (session) sessions.delete(token);
    return null;
  }

  return users.get(session.userId) || null;
}

function requireUser(req, res, next) {
  let user = sessionUser(req);

  if (!user) {
    const id = safeUserId(req.headers["x-user-id"]);
    if (id) user = users.get(id) || null;
  }

  if (!user) {
    return jsonError(res, 401, "Sessão inválida ou expirada.");
  }

  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const token = getBearer(req);
  const session = adminSessions.get(token);

  if (!session || session.expiresAt < now()) {
    if (session) adminSessions.delete(token);
    return jsonError(res, 401, "Sessão administrativa expirada ou inválida.");
  }

  next();
}

app.post("/api/auth/login", (req, res) => {
  try {
    const user = ensureUser(req.body?.userId);
    const token = randomToken(32);

    sessions.set(token, {
      userId: user.id,
      createdAt: now(),
      expiresAt: now() + SESSION_TTL,
    });

    return res.json({
      ok: true,
      token,
      user: publicUser(user),
    });
  } catch {
    metrics.errors++;
    return jsonError(res, 500, "Erro ao iniciar sessão.");
  }
});

app.get("/api/auth/me", requireUser, (req, res) => {
  claimDailyPoints(req.user);
  res.json({
    ok: true,
    user: publicUser(req.user),
  });
});

/* ============================================================
   UPLOAD MP4
============================================================ */

app.post("/api/upload", requireUser, (req, res) => {
  videoUpload.single("video")(req, res, async (err) => {
    if (err) {
      metrics.errors++;
      if (err.code === "LIMIT_FILE_SIZE") {
        return jsonError(
          res,
          413,
          `O vídeo ultrapassa o limite de ${MAX_UPLOAD_MB} MB.`
        );
      }
      return jsonError(res, 400, err.message || "Falha no upload do vídeo.");
    }

    if (!req.file) {
      return jsonError(res, 400, "Nenhum arquivo MP4 foi enviado.");
    }

    const filePath = req.file.path;

    try {
      const info = await validateVideoFile(filePath);
      const uploadId = crypto.randomUUID();

      const item = {
        id: uploadId,
        userId: req.user.id,
        path: filePath,
        originalName: req.file.originalname,
        size: info.size,
        duration: info.duration,
        mimeType: "video/mp4",
        createdAt: now(),
        geminiFileName: "",
        geminiUri: "",
        geminiMimeType: "video/mp4",
      };

      uploads.set(uploadId, item);
      metrics.uploads++;

      return res.json({
        ok: true,
        uploadId,
        sourceType: "upload",
        filename: item.originalName,
        size: item.size,
        duration: Number(item.duration.toFixed(2)),
        mimeType: item.mimeType,
        user: publicUser(req.user),
        version: VERSION,
      });
    } catch (vErr) {
      metrics.errors++;
      await safeRemove(filePath);
      return jsonError(
        res,
        400,
        vErr.message || "O arquivo enviado não é um vídeo válido."
      );
    }
  });
});

app.get("/api/upload/:id", requireUser, async (req, res) => {
  try {
    const upload = getOwnedUpload(req.params.id, req.user.id);
    return res.json({
      ok: true,
      upload: {
        id: upload.id,
        filename: upload.originalName,
        size: upload.size,
        duration: Number(upload.duration.toFixed(2)),
        mimeType: upload.mimeType,
        createdAt: upload.createdAt,
        geminiReady: Boolean(upload.geminiUri),
      },
      user: publicUser(req.user),
    });
  } catch (err) {
    return jsonError(res, 404, err.message);
  }
});

app.delete("/api/upload/:id", requireUser, async (req, res) => {
  try {
    const upload = getOwnedUpload(req.params.id, req.user.id);
    await safeRemove(upload.path);
    uploads.delete(upload.id);
    return res.json({ ok: true, deleted: true });
  } catch (err) {
    return jsonError(res, 404, err.message);
  }
});

/* ============================================================
   ANALISAR
============================================================ */

app.post("/api/analisar", requireUser, async (req, res) => {
  const uploadId = safeUploadId(req.body?.uploadId);
  const inputUrl = String(req.body?.url || "").trim();

  /* --------------------------------------------------------
     UPLOAD
  -------------------------------------------------------- */
  if (uploadId) {
    try {
      const upload = getOwnedUpload(uploadId, req.user.id);
      metrics.analyses++;
      metrics.uploadAnalyses++;
      req.user.analyses++;

      const result = await analyzeUploadedWithGemini(upload);
      return res.json({
        ok: true,
        sourceType: "upload",
        uploadId: upload.id,
        filename: upload.originalName,
        videoDuration: Number(upload.duration.toFixed(2)),
        clips: result.clips,
        user: publicUser(req.user),
        fallback: Boolean(result.fallback),
        model: result.model,
        version: VERSION,
      });
    } catch (err) {
      metrics.errors++;
      return jsonError(
        res,
        502,
        err.message || "Não foi possível analisar o vídeo enviado."
      );
    }
  }

  /* --------------------------------------------------------
     YOUTUBE
  -------------------------------------------------------- */
  const videoId = youtubeIdFromUrl(inputUrl);

  if (!videoId) {
    return jsonError(
      res,
      400,
      "Envie um uploadId ou um link do YouTube válido."
    );
  }

  const url = youtubeUrl(inputUrl);
  metrics.analyses++;
  metrics.youtubeAnalyses++;
  req.user.analyses++;

  try {
    const result = await analyzeYoutubeWithGemini(url);
    return res.json({
      ok: true,
      sourceType: "youtube",
      videoId,
      clips: result.clips,
      user: publicUser(req.user),
      fallback: Boolean(result.fallback),
      model: result.model,
      version: VERSION,
    });
  } catch (err) {
    metrics.errors++;
    return jsonError(res, 502, err.message || "Não foi possível analisar o vídeo.");
  }
});

app.post("/api/analisar-upload", requireUser, async (req, res) => {
  const uploadId = safeUploadId(req.body?.uploadId);
  if (!uploadId) {
    return jsonError(res, 400, "uploadId obrigatório.");
  }

  try {
    const upload = getOwnedUpload(uploadId, req.user.id);
    metrics.analyses++;
    metrics.uploadAnalyses++;
    req.user.analyses++;

    const result = await analyzeUploadedWithGemini(upload);
    return res.json({
      ok: true,
      sourceType: "upload",
      uploadId: upload.id,
      filename: upload.originalName,
      videoDuration: Number(upload.duration.toFixed(2)),
      clips: result.clips,
      user: publicUser(req.user),
      fallback: Boolean(result.fallback),
      model: result.model,
      version: VERSION,
    });
  } catch (err) {
    metrics.errors++;
    return jsonError(
      res,
      502,
      err.message || "Não foi possível analisar o vídeo enviado."
    );
  }
});

/* ============================================================
   DOWNLOAD / CORTE
============================================================ */

app.post("/api/download", requireUser, async (req, res) => {
  const uploadId = safeUploadId(req.body?.uploadId);
  const inputUrl = String(req.body?.url || "").trim();
  const start = parseNumber(req.body?.start, NaN);
  const duration = parseNumber(req.body?.duration, NaN);

  if (!Number.isFinite(start) || start < 0) {
    return jsonError(res, 400, "Tempo inicial inválido.");
  }

  if (!Number.isFinite(duration) || duration < 1 || duration > 90) {
    return jsonError(res, 400, "Duração inválida (1-90s).");
  }

  if (!req.user.vip && req.user.points < DOWNLOAD_COST) {
    return jsonError(
      res,
      402,
      `Pontos insuficientes (${DOWNLOAD_COST} necessários).`
    );
  }

  let sourceType = "";
  let uploadItem = null;
  let youtubeVideoId = null;

  if (uploadId) {
    try {
      uploadItem = getOwnedUpload(uploadId, req.user.id);
      sourceType = "upload";
    } catch (err) {
      return jsonError(res, 404, err.message);
    }
  } else {
    youtubeVideoId = youtubeIdFromUrl(inputUrl);
    if (!youtubeVideoId) {
      return jsonError(
        res,
        400,
        "Envie um uploadId ou uma URL válida do YouTube."
      );
    }
    sourceType = "youtube";
  }

  const jobId = crypto.randomUUID();
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `clipforge-${jobId}-`));
  const outputFile = path.join(workDir, `clip-${jobId}.mp4`);
  let charged = false;

  try {
    let sourceFile;

    if (sourceType === "upload") {
      sourceFile = uploadItem.path;
    } else {
      const url = youtubeUrl(inputUrl);
      sourceFile = await downloadOriginalVideo(url, youtubeVideoId, workDir);
    }

    const sourceInfo = await validateVideoFile(sourceFile);
    if (start >= sourceInfo.duration) {
      throw new Error(
        `Início (${start}s) além da duração total (${sourceInfo.duration.toFixed(2)}s).`
      );
    }

    const safeDuration = Math.min(
      duration,
      Math.max(1, sourceInfo.duration - start)
    );

    await renderClip(sourceFile, outputFile, start, safeDuration);

    const stat = await fsp.stat(outputFile);
    if (!stat.size || stat.size < 10000) {
      throw new Error("Arquivo MP4 final inválido.");
    }

    if (!req.user.vip) {
      req.user.points -= DOWNLOAD_COST;
      charged = true;
    }

    req.user.downloads++;
    metrics.downloads++;

    if (sourceType === "upload") {
      metrics.uploadDownloads++;
    } else {
      metrics.youtubeDownloads++;
    }

    let filename;
    if (sourceType === "upload") {
      const base = path
        .basename(uploadItem.originalName, path.extname(uploadItem.originalName))
        .replace(/[^A-Za-z0-9_-]+/g, "_")
        .slice(0, 60);
      filename = `clipforge_${base}_${Math.floor(start)}s.mp4`;
    } else {
      filename = `clipforge_${youtubeVideoId}_${Math.floor(start)}s.mp4`;
    }

    res.status(200);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");

    const stream = fs.createReadStream(outputFile);
    let cleaned = false;

    const safeCleanDir = async () => {
      if (cleaned) return;
      cleaned = true;
      await cleanup(workDir);
    };

    stream.on("error", async (streamError) => {
      console.error("[Download Stream]", streamError);
      if (charged && !req.user.vip) {
        req.user.points += DOWNLOAD_COST;
      }
      await safeCleanDir();
    });

    res.on("finish", safeCleanDir);
    res.on("close", safeCleanDir);

    stream.pipe(res);
  } catch (err) {
    metrics.errors++;
    if (charged && !req.user.vip) {
      req.user.points += DOWNLOAD_COST;
    }
    await cleanup(workDir);
    if (res.headersSent) return;

    return jsonError(res, 500, err.message || "Erro ao processar e cortar o vídeo.");
  }
});

/* ============================================================
   MERCADO PAGO
============================================================ */

async function mercadoPagoRequest(endpoint, options = {}) {
  if (!MP_ACCESS_TOKEN) {
    throw new Error("MP_ACCESS_TOKEN não configurado.");
  }

  const response = await fetch(`${MP_API}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.message || `Mercado Pago HTTP ${response.status}`);
  }

  return data;
}

app.post("/api/pix/criar", requireUser, async (req, res) => {
  if (!MP_ACCESS_TOKEN) {
    return jsonError(res, 503, "Pix não configurado.");
  }

  try {
    const payment = await mercadoPagoRequest("/v1/payments", {
      method: "POST",
      headers: {
        "X-Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        transaction_amount: Number(VIP_PRICE.toFixed(2)),
        description: "ClipForge Pro VIP",
        payment_method_id: "pix",
        payer: {
          email: `cliente-${req.user.id}@clipforge.local`,
        },
        external_reference: `clipforge_${req.user.id}_${crypto.randomUUID()}`,
      }),
    });

    const tx = payment?.point_of_interaction?.transaction_data || {};
    payments.set(String(payment.id), {
      id: String(payment.id),
      userId: req.user.id,
      status: payment.status,
      createdAt: now(),
    });

    metrics.pixCreated++;

    return res.json({
      ok: true,
      id: String(payment.id),
      status: payment.status,
      qr_code: tx.qr_code || "",
      qr_code_base64: tx.qr_code_base64 || "",
      ticket_url: tx.ticket_url || "",
      amount: VIP_PRICE,
    });
  } catch (err) {
    metrics.errors++;
    return jsonError(res, 502, err.message || "Erro ao gerar PIX.");
  }
});

app.get("/api/pix/status/:id", requireUser, async (req, res) => {
  const paymentId = String(req.params.id || "");
  const localPayment = payments.get(paymentId);

  if (!localPayment) {
    return jsonError(res, 404, "Pagamento não encontrado.");
  }

  if (localPayment.userId !== req.user.id) {
    return jsonError(res, 403, "Pagamento não pertence a esta conta.");
  }

  try {
    const payment = await mercadoPagoRequest(
      `/v1/payments/${encodeURIComponent(paymentId)}`,
      { method: "GET" }
    );

    const approved = payment.status === "approved";
    localPayment.status = payment.status;

    if (approved && !req.user.vip) {
      req.user.vip = true;
      metrics.pixApproved++;
    }

    return res.json({
      ok: true,
      id: paymentId,
      status: payment.status,
      approved,
      user: publicUser(req.user),
    });
  } catch (err) {
    metrics.errors++;
    return jsonError(res, 502, err.message || "Erro ao consultar PIX.");
  }
});

/* ============================================================
   ADMIN
============================================================ */

app.post("/api/admin/login", (req, res) => {
  if (!ADMIN_PASSWORD) {
    return jsonError(res, 503, "ADMIN_PASSWORD não configurada.");
  }

  const password = String(req.body?.password || "");
  if (password !== ADMIN_PASSWORD) {
    return jsonError(res, 401, "Senha administrativa incorreta.");
  }

  const token = randomToken(32);
  adminSessions.set(token, {
    createdAt: now(),
    expiresAt: now() + ADMIN_TOKEN_TTL,
  });

  return res.json({
    ok: true,
    token,
  });
});

app.get("/api/admin/dashboard", requireAdmin, (req, res) => {
  let vipUsers = 0;
  let totalPoints = 0;
  let totalDownloads = 0;
  let totalAnalyses = 0;

  for (const user of users.values()) {
    if (user.vip) vipUsers++;
    totalPoints += Math.max(0, user.points);
    totalDownloads += user.downloads;
    totalAnalyses += user.analyses;
  }

  return res.json({
    ok: true,
    metrics: {
      ...metrics,
      users: users.size,
      vipUsers,
      totalPoints,
      totalDownloads,
      totalAnalyses,
      activeUploads: uploads.size,
    },
    version: VERSION,
  });
});

/* ============================================================
   404
============================================================ */

app.use((req, res) => jsonError(res, 404, "Endpoint não encontrado."));

/* ============================================================
   ERROR HANDLER
============================================================ */

app.use((err, req, res, next) => {
  metrics.errors++;
  console.error("[Server Error]", err);
  if (!res.headersSent) {
    jsonError(res, 500, "Erro interno do servidor.");
  }
});

/* ============================================================
   INICIALIZAÇÃO
============================================================ */

async function startServer() {
  try {
    await ensureDirectories();
    await cleanupExpiredUploads();
    await resolveBinaries();

    console.log("====================================================");
    console.log(`ClipForge Pro Backend ${VERSION} iniciando...`);
    console.log(`Node: ${process.version}`);
    console.log(`Gemini: ${GEMINI_MODEL}`);
    console.log(`Fallbacks: ${GEMINI_FALLBACK_MODELS.join(", ") || "nenhum"}`);
    console.log(`Gemini configurado: ${GEMINI_API_KEY ? "SIM" : "NÃO"}`);
    console.log(`Upload MP4: ATIVO — limite ${MAX_UPLOAD_MB} MB`);
    console.log(`yt-dlp: ${YTDLP_BIN}`);
    console.log(`FFmpeg: ${FFMPEG_BIN}`);
    console.log(`FFprobe: ${FFPROBE_BIN}`);
    console.log(`RapidAPI: ${RAPIDAPI_KEY ? "CONFIGURADA (" + RAPIDAPI_HOST + ")" : "NÃO CONFIGURADA"}`);
    console.log(`Cookies yt-dlp: ${YTDLP_COOKIES_FILE || "NÃO CONFIGURADOS"}`);
    console.log("====================================================");

    const [ytOk, ffOk, probeOk] = await Promise.all([
      commandExists(YTDLP_BIN),
      commandExists(FFMPEG_BIN),
      commandExists(FFPROBE_BIN),
    ]);

    console.log(`[Startup] yt-dlp: ${ytOk ? "OK" : "ERRO"}`);
    console.log(`[Startup] FFmpeg: ${ffOk ? "OK" : "ERRO"}`);
    console.log(`[Startup] FFprobe: ${probeOk ? "OK" : "ERRO"}`);

    if (!ffOk) {
      console.warn("[Startup] ATENÇÃO: FFmpeg indisponível.");
    }

    if (!probeOk) {
      console.warn("[Startup] ATENÇÃO: FFprobe indisponível.");
    }

    app.listen(PORT, HOST, () => {
      console.log(`ClipForge Pro Backend ${VERSION} online em http://${HOST}:${PORT}`);
    });
  } catch (error) {
    console.error("[Startup] Falha ao iniciar:", error);
    process.exit(1);
  }
}

startServer();
