/**
 * ============================================================
 * CLIPFORGE PRO — BACKEND 13.1.0 (CONSOLIDADO)
 * Node.js + Express
 *
 * Compatível 100% com o index.html V13.0.7
 *
 * Endpoints:
 * - POST /api/auth/login
 * - GET  /api/auth/me
 * - POST /api/analisar
 * - POST /api/download
 * - POST /api/pix/criar
 * - GET  /api/pix/status/:id
 * - POST /api/admin/login
 * - GET  /api/admin/dashboard
 * - GET  /health
 * - GET  /api/status
 *
 * Resiliência:
 * - Gemini Interactions API com retry automático em HTTP 503/429
 * - Pipeline: Downloader Externo -> RapidAPI -> yt-dlp
 * - FFmpeg com H.264 (yuv420p) + AAC + faststart
 * - Limpeza garantida de temporários após o streaming
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

const app = express();

/* ============================================================
 * CONFIGURAÇÃO DO AMBIENTE
 * ============================================================ */

const APP_VERSION = "13.1.0";
const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";
const NODE_ENV = process.env.NODE_ENV || "production";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || process.env.X_RAPIDAPI_KEY || "";
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || "youtube-media-downloader.p.rapidapi.com";

const EXTERNAL_DOWNLOAD_URL = process.env.EXTERNAL_DOWNLOAD_URL || "";
const EXTERNAL_DOWNLOAD_TOKEN = process.env.EXTERNAL_DOWNLOAD_TOKEN || "";

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || process.env.MERCADOPAGO_ACCESS_TOKEN || "";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

const FRONTEND_URL = process.env.FRONTEND_URL || "";
const DEFAULT_ALLOWED_ORIGINS = [
  "https://clipforge.netlify.app",
  "https://clipforge-pro.netlify.app",
  "https://clipforgepro.netlify.app",
  "https://cortesdomnr.vercel.app",
];

const ALLOWED_ORIGINS = [
  ...new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...FRONTEND_URL.split(",").map((v) => v.trim()).filter(Boolean),
    ...String(process.env.ALLOWED_ORIGINS || "").split(",").map((v) => v.trim()).filter(Boolean),
  ]),
];

const TEMP_ROOT = path.join(os.tmpdir(), "clipforge-pro");
const DOWNLOAD_DIR = path.join(TEMP_ROOT, "downloads");
const OUTPUT_DIR = path.join(TEMP_ROOT, "outputs");

const FREE_START_POINTS = 200;
const DOWNLOAD_COST = 50;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const ADMIN_TOKEN_TTL = 12 * 60 * 60 * 1000;

/* ============================================================
 * RESOLUÇÃO DOS BINÁRIOS
 * ============================================================ */

function findExecutable(candidates = []) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

const YTDLP_PATH = process.env.YTDLP_PATH || findExecutable([
  path.join(process.cwd(), "bin", "yt-dlp"),
  path.join(process.cwd(), "yt-dlp"),
]) || "yt-dlp";

const FFMPEG_PATH = process.env.FFMPEG_PATH || findExecutable([
  path.join(process.cwd(), "bin", "ffmpeg"),
  path.join(process.cwd(), "ffmpeg"),
]) || "ffmpeg";

const FFPROBE_PATH = process.env.FFPROBE_PATH || findExecutable([
  path.join(process.cwd(), "bin", "ffprobe"),
  path.join(process.cwd(), "ffprobe"),
]) || "ffprobe";

const YTDLP_COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || "";

/* ============================================================
 * ESTADO EM MEMÓRIA & MÉTRICAS
 * ============================================================ */

const users = new Map();
const sessions = new Map();
const adminSessions = new Map();
const payments = new Map();

const metrics = {
  startedAt: new Date().toISOString(),
  requests: 0,
  analyses: 0,
  analysisSuccess: 0,
  analysisFailures: 0,
  geminiRequests: 0,
  geminiSuccess: 0,
  geminiFailures: 0,
  geminiRetries: 0,
  downloads: 0,
  downloadSuccess: 0,
  downloadFailures: 0,
  externalDownloadAttempts: 0,
  rapidApiAttempts: 0,
  rapidApiRateLimited: 0,
  ytdlpAttempts: 0,
  ytdlpAntiBot: 0,
  pixCreated: 0,
  pixApproved: 0,
  errors: 0,
};

/* ============================================================
 * MIDDLEWARES
 * ============================================================ */

app.disable("x-powered-by");
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || origin.endsWith(".netlify.app") || origin.endsWith(".vercel.app")) {
      return callback(null, true);
    }
    return callback(null, true); // Permissivo durante testes
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-User-Id", "X-Requested-With"],
}));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

app.use((req, res, next) => {
  metrics.requests++;
  res.setHeader("X-ClipForge-Version", APP_VERSION);
  next();
});

/* ============================================================
 * HELPERS GERAIS
 * ============================================================ */

function now() { return Date.now(); }

function randomId(prefix = "") {
  return prefix + crypto.randomBytes(12).toString("hex");
}

function safeString(value, fallback = "") {
  return (value === undefined || value === null) ? fallback : String(value);
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeFilename(value) {
  return String(value || "clip")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "clip";
}

function redactSecrets(text) {
  let val = safeString(text);
  const secrets = [GEMINI_API_KEY, RAPIDAPI_KEY, EXTERNAL_DOWNLOAD_TOKEN, MP_ACCESS_TOKEN, ADMIN_PASSWORD].filter(Boolean);
  for (const s of secrets) {
    try {
      val = val.replace(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "[REDACTED]");
    } catch {}
  }
  return val;
}

function extractYouTubeId(value) {
  if (!value) return "";
  const str = String(value).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(str)) return str;

  try {
    const url = new URL(str);
    const host = url.hostname.toLowerCase();
    if (host === "youtu.be" || host === "www.youtu.be") {
      return url.pathname.replace(/^\/+/, "").split("/")[0] || "";
    }
    if (host.includes("youtube.com")) {
      const v = url.searchParams.get("v");
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      const match = url.pathname.match(/\/(shorts|embed|live)\/([a-zA-Z0-9_-]{11})/);
      if (match) return match[2];
    }
  } catch {}
  return "";
}

function normalizeYouTubeUrl(input) {
  const videoId = extractYouTubeId(input);
  if (!videoId) return null;
  return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}

async function ensureDirectories() {
  await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
}

async function safeRemove(file) {
  if (!file) return;
  try { await fsp.rm(file, { force: true, recursive: true }); } catch {}
}

async function cleanupOldFiles() {
  const dirs = [DOWNLOAD_DIR, OUTPUT_DIR];
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const dir of dirs) {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        try {
          const stat = await fsp.stat(full);
          if (stat.mtimeMs < cutoff) await safeRemove(full);
        } catch {}
      }
    } catch {}
  }
}

/* ============================================================
 * USUÁRIOS & SESSÕES
 * ============================================================ */

function getOrCreateUser(userId) {
  const id = userId || randomId("usr_");
  let user = users.get(id);
  if (!user) {
    user = {
      id,
      points: FREE_START_POINTS,
      vip: false,
      analyses: 0,
      downloads: 0,
      createdAt: now(),
      lastBonusClaim: now(),
    };
    users.set(id, user);
  }
  return user;
}

function createSession(user) {
  const token = randomId("sess_");
  sessions.set(token, {
    userId: user.id,
    createdAt: now(),
    expiresAt: now() + SESSION_TTL,
  });
  return token;
}

function getUserFromRequest(req) {
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    const session = sessions.get(token);
    if (session && session.expiresAt > now()) {
      return users.get(session.userId) || null;
    }
  }
  const uid = req.headers["x-user-id"] || req.body?.userId || req.query?.userId;
  if (uid && users.has(uid)) return users.get(uid);
  return null;
}

function resolveRequestUser(req) {
  const existing = getUserFromRequest(req);
  return existing || getOrCreateUser();
}

function requireUser(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ ok: false, error: "Sessão inválida ou expirada.", code: "AUTH_REQUIRED" });
  }
  req.user = user;
  next();
}

function createAdminSession() {
  const token = randomId("admin_");
  adminSessions.set(token, { createdAt: now(), expiresAt: now() + ADMIN_TOKEN_TTL });
  return token;
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    const session = adminSessions.get(token);
    if (session && session.expiresAt > now()) {
      req.admin = true;
      return next();
    }
  }
  return res.status(401).json({ ok: false, error: "Acesso administrativo não autorizado." });
}

/* ============================================================
 * EXECUTAR PROCESSOS (SPAWN)
 * ============================================================ */

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (c) => {
      stdout += c.toString();
      if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
    });

    child.stderr.on("data", (c) => {
      stderr += c.toString();
      if (stderr.length > 2_000_000) stderr = stderr.slice(-2_000_000);
    });

    let finished = false;
    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("Processo excedeu o tempo limite."));
    }, options.timeout || 300000);

    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

async function validateVideoFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("Arquivo de vídeo não foi criado.");
  }
  const stat = await fsp.stat(filePath);
  if (stat.size < 10000) {
    throw new Error(`Arquivo baixado muito pequeno: ${stat.size} bytes.`);
  }

  const probe = await runCommand(FFPROBE_PATH, [
    "-v", "error",
    "-show_entries", "format=format_name,duration",
    "-show_streams",
    "-of", "json",
    filePath,
  ], { timeout: 60000 });

  if (probe.code !== 0) {
    throw new Error(`FFprobe rejeitou o arquivo: ${redactSecrets(probe.stderr).slice(-800)}`);
  }

  const data = JSON.parse(probe.stdout);
  const duration = Number(data?.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Vídeo baixado não possui duração válida.");
  }
  return { duration, size: stat.size };
}

/* ============================================================
 * GEMINI — INTERACTIONS API COM RETRY (TRATA 503/429)
 * ============================================================ */

const geminiSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    clips: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: { type: "number" },
          end: { type: "number" },
          title: { type: "string" },
          description: { type: "string" },
          score: { type: "number" },
          reason: { type: "string" },
        },
        required: ["start", "end", "title", "description", "score", "reason"],
      },
    },
  },
  required: ["title", "summary", "clips"],
};

function extractGeminiOutputText(data) {
  if (!data) return "";
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  if (typeof data.outputText === "string" && data.outputText.trim()) return data.outputText.trim();

  const arrays = [data.outputs, data.steps];
  for (const arr of arrays) {
    if (Array.isArray(arr)) {
      for (const it of arr) {
        if (!it) continue;
        if (typeof it.text === "string" && it.text.trim()) return it.text.trim();
        if (Array.isArray(it.content)) {
          for (const c of it.content) {
            if (typeof c?.text === "string" && c.text.trim()) return c.text.trim();
          }
        }
      }
    }
  }

  if (Array.isArray(data.candidates) && data.candidates[0]?.content?.parts) {
    return data.candidates[0].content.parts.map((p) => p.text || "").join("").trim();
  }
  return "";
}

function extractJsonFromText(text) {
  if (!text) return null;
  let clean = String(text).trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(clean); } catch {}
  const f = clean.indexOf("{");
  const l = clean.lastIndexOf("}");
  if (f !== -1 && l > f) {
    try { return JSON.parse(clean.slice(f, l + 1)); } catch {}
  }
  return null;
}

async function analisarComGemini({ youtubeUrl, videoId, maxClips = 5, minDuration = 20, maxDuration = 60 }) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY não configurada no servidor.");
  metrics.geminiRequests++;

  const prompt = `
Você é o motor de seleção de cortes do ClipForge Pro.
Analise integralmente o vídeo do YouTube fornecido: ${youtubeUrl}
Objetivo: encontrar até ${maxClips} momentos com alto potencial para Shorts, TikTok e Reels.
Duração de cada corte: entre ${minDuration} e ${maxDuration} segundos.
Retorne estritamente o JSON estruturado conforme o schema.
`.trim();

  const body = {
    model: GEMINI_MODEL,
    input: [
      { type: "text", text: prompt },
      { type: "video", uri: youtubeUrl, mime_type: "video/mp4" },
    ],
    generation_config: { thinking_level: "low" },
    response_format: { type: "text", mime_type: "application/json", schema: geminiSchema },
  };

  let response;
  let rawText = "";
  let tentativas = 0;
  const MAX_TENTATIVAS = 3;

  while (tentativas < MAX_TENTATIVAS) {
    tentativas++;
    try {
      response = await fetch(GEMINI_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });

      rawText = await response.text();

      if (response.status === 503 || response.status === 429) {
        metrics.geminiRetries++;
        console.warn(`[Gemini] HTTP ${response.status} (alta demanda). Tentativa ${tentativas}/${MAX_TENTATIVAS}. Aguardando retry...`);
        if (tentativas < MAX_TENTATIVAS) {
          await new Promise((r) => setTimeout(r, 2500 * tentativas));
          continue;
        }
      }
      break;
    } catch (err) {
      if (tentativas >= MAX_TENTATIVAS) {
        metrics.geminiFailures++;
        throw new Error(`Falha de conexão com Gemini: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  let data = null;
  try { data = rawText ? JSON.parse(rawText) : null; } catch {}

  if (!response || !response.ok) {
    metrics.geminiFailures++;
    throw new Error(`Gemini HTTP ${response ? response.status : "Error"}: ${redactSecrets(rawText).slice(0, 1000)}`);
  }

  const out = extractGeminiOutputText(data);
  const parsed = extractJsonFromText(out);
  if (!parsed || !Array.isArray(parsed.clips)) {
    metrics.geminiFailures++;
    throw new Error("Não foi possível extrair os cortes em JSON da resposta do Gemini.");
  }

  metrics.geminiSuccess++;
  const clips = parsed.clips.map((clip, index) => {
    const s = Math.max(0, safeNumber(clip.start, 0));
    const d = clamp(safeNumber(clip.duration, (safeNumber(clip.end, s + 50) - s)), minDuration, maxDuration);
    return {
      start: Number(s.toFixed(2)),
      end: Number((s + d).toFixed(2)),
      duration: Number(d.toFixed(2)),
      title: safeString(clip.title || `Corte #${index + 1}`).slice(0, 140),
      description: safeString(clip.description || clip.reason || "").slice(0, 500),
      score: clamp(Math.round(safeNumber(clip.score, 80)), 0, 100),
      reason: safeString(clip.reason || "Momento de destaque selecionado por IA").slice(0, 500),
    };
  }).slice(0, maxClips);

  return {
    title: safeString(parsed.title || "Vídeo analisado"),
    summary: safeString(parsed.summary || ""),
    clips,
  };
}

/* ============================================================
 * PIPELINE DE DOWNLOAD E RENDERIZAÇÃO
 * ============================================================ */

async function downloadOriginalVideo({ youtubeUrl, videoId }) {
  const outputPath = path.join(DOWNLOAD_DIR, `${sanitizeFilename(videoId)}-${Date.now()}.mp4`);
  const failures = [];

  // 1. Downloader Externo (se configurado)
  if (EXTERNAL_DOWNLOAD_URL) {
    try {
      metrics.externalDownloadAttempts++;
      const res = await fetch(EXTERNAL_DOWNLOAD_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(EXTERNAL_DOWNLOAD_TOKEN ? { Authorization: `Bearer ${EXTERNAL_DOWNLOAD_TOKEN}` } : {}),
        },
        body: JSON.stringify({ url: youtubeUrl, videoId, output: "mp4" }),
        signal: AbortSignal.timeout(180000),
      });

      if (!res.ok) throw new Error(`Downloader externo HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(outputPath));
      await validateVideoFile(outputPath);
      return { path: outputPath, method: "external" };
    } catch (e) {
      failures.push(`Externo: ${e.message}`);
      await safeRemove(outputPath);
    }
  }

  // 2. RapidAPI
  if (RAPIDAPI_KEY) {
    try {
      metrics.rapidApiAttempts++;
      const endpoint = `https://${RAPIDAPI_HOST}/dl?id=${encodeURIComponent(videoId)}&cgeo=BR`;
      const res = await fetch(endpoint, {
        method: "GET",
        headers: { "x-rapidapi-key": RAPIDAPI_KEY, "x-rapidapi-host": RAPIDAPI_HOST },
        signal: AbortSignal.timeout(60000),
      });

      if (res.status === 429) {
        metrics.rapidApiRateLimited++;
        throw new Error("RapidAPI_RATE_LIMITED");
      }
      if (!res.ok) throw new Error(`RapidAPI HTTP ${res.status}`);

      const data = await res.json();
      const urls = [];
      const collect = (o) => {
        if (!o || typeof o !== "object") return;
        if (typeof o.url === "string" && o.url.startsWith("http")) urls.push(o.url);
        for (const k of Object.keys(o)) collect(o[k]);
      };
      collect(data);

      const target = urls[0];
      if (!target) throw new Error("RapidAPI não forneceu URLs.");

      const sRes = await fetch(target, { signal: AbortSignal.timeout(120000) });
      if (!sRes.ok) throw new Error(`Stream RapidAPI HTTP ${sRes.status}`);

      await pipeline(Readable.fromWeb(sRes.body), fs.createWriteStream(outputPath));
      await validateVideoFile(outputPath);
      return { path: outputPath, method: "rapidapi" };
    } catch (e) {
      failures.push(`RapidAPI: ${e.message}`);
      await safeRemove(outputPath);
    }
  }

  // 3. yt-dlp Local Fallback
  try {
    metrics.ytdlpAttempts++;
    if (!fs.existsSync(YTDLP_PATH)) throw new Error(`yt-dlp não encontrado em ${YTDLP_PATH}`);

    const args = [
      "--no-playlist", "--no-warnings", "--newline", "--restrict-filenames",
      "--no-check-certificates", "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
      "--merge-output-format", "mp4", "-o", outputPath,
    ];

    if (YTDLP_COOKIES_FILE && fs.existsSync(YTDLP_COOKIES_FILE)) {
      args.push("--cookies", YTDLP_COOKIES_FILE);
    }
    args.push(youtubeUrl);

    const result = await runCommand(YTDLP_PATH, args, { timeout: 300000 });
    const combined = `${result.stdout}\n${result.stderr}`;

    if (result.code !== 0) {
      if (/sign in to confirm|not a bot|login_required/i.test(combined)) {
        metrics.ytdlpAntiBot++;
        throw new Error("O YouTube bloqueou o IP do servidor com proteção anti-bot.");
      }
      throw new Error(`yt-dlp código ${result.code}: ${redactSecrets(result.stderr).slice(-800)}`);
    }

    await validateVideoFile(outputPath);
    return { path: outputPath, method: "yt-dlp" };
  } catch (e) {
    failures.push(`yt-dlp: ${e.message}`);
    await safeRemove(outputPath);
    throw new Error(`Todos os métodos de download falharam: ${failures.join(" | ")}`);
  }
}

async function renderClip({ inputPath, outputPath, start, duration }) {
  const safeStart = Math.max(0, safeNumber(start, 0));
  const safeDuration = Math.max(1, safeNumber(duration, 1));

  const result = await runCommand(FFMPEG_PATH, [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-ss", safeStart.toFixed(3),
    "-i", inputPath,
    "-t", safeDuration.toFixed(3),
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-movflags", "+faststart",
    "-avoid_negative_ts", "make_zero",
    outputPath,
  ], { timeout: 300000 });

  if (result.code !== 0) {
    throw new Error(`FFmpeg falhou: ${redactSecrets(result.stderr).slice(-1200)}`);
  }

  const stat = await fsp.stat(outputPath);
  if (stat.size < 10000) {
    throw new Error("FFmpeg finalizou, mas gerou um arquivo corrompido ou vazio.");
  }
  return outputPath;
}

/* ============================================================
 * ENDPOINTS DA API
 * ============================================================ */

app.get("/", (req, res) => {
  res.json({ ok: true, name: "ClipForge Pro API", version: APP_VERSION, status: "online" });
});

app.get("/health", async (req, res) => {
  const yt = await commandExists(YTDLP_PATH).catch(() => fs.existsSync(YTDLP_PATH));
  const ff = await commandExists(FFMPEG_PATH).catch(() => fs.existsSync(FFMPEG_PATH));
  const fp = await commandExists(FFPROBE_PATH).catch(() => fs.existsSync(FFPROBE_PATH));

  res.json({
    ok: Boolean(yt && ff),
    version: APP_VERSION,
    ytDlp: Boolean(yt),
    ffmpeg: Boolean(ff),
    ffprobe: Boolean(fp),
    geminiConfigured: Boolean(GEMINI_API_KEY),
    mercadoPagoConfigured: Boolean(MP_ACCESS_TOKEN),
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    service: "ClipForge Pro",
    version: APP_VERSION,
    node: process.version,
    gemini: { configured: Boolean(GEMINI_API_KEY), model: GEMINI_MODEL, endpoint: GEMINI_ENDPOINT },
    metrics,
  });
});

app.post("/api/auth/login", (req, res) => {
  const user = getOrCreateUser(req.body?.userId);
  const token = createSession(user);
  res.json({
    ok: true,
    token,
    user: { id: user.id, points: user.points, vip: user.vip, downloads: user.downloads },
  });
});

app.get("/api/auth/me", requireUser, (req, res) => {
  res.json({
    ok: true,
    user: { id: req.user.id, points: req.user.points, vip: req.user.vip, downloads: req.user.downloads },
  });
});

app.post("/api/analisar", async (req, res) => {
  metrics.analyses++;
  const user = resolveRequestUser(req);
  const rawUrl = req.body?.url || req.body?.youtubeUrl || req.body?.videoUrl;
  const normalized = normalizeYouTubeUrl(rawUrl);

  if (!normalized) {
    metrics.analysisFailures++;
    return res.status(400).json({ ok: false, error: "URL do YouTube inválida.", code: "INVALID_YOUTUBE_URL" });
  }

  try {
    const result = await analisarComGemini({
      youtubeUrl: normalized.url,
      videoId: normalized.videoId,
      maxClips: clamp(safeNumber(req.body?.maxClips, 5), 1, 10),
      minDuration: clamp(safeNumber(req.body?.minDuration, 20), 10, 120),
      maxDuration: clamp(safeNumber(req.body?.maxDuration, 60), 20, 180),
    });

    user.analyses++;
    metrics.analysisSuccess++;

    return res.json({
      ok: true,
      version: APP_VERSION,
      videoId: normalized.videoId,
      url: normalized.url,
      title: result.title,
      summary: result.summary,
      clips: result.clips,
      count: result.clips.length,
      user: { id: user.id, points: user.points, vip: user.vip },
    });
  } catch (error) {
    metrics.analysisFailures++;
    console.error(`[Análise] Erro: ${redactSecrets(error.message)}`);
    return res.status(502).json({
      ok: false,
      error: redactSecrets(error.message) || "Não foi possível analisar o vídeo.",
      code: "ANALYSIS_FAILED",
    });
  }
});

app.post("/api/download", async (req, res) => {
  metrics.downloads++;
  const user = resolveRequestUser(req);
  const rawUrl = req.body?.url || req.body?.youtubeUrl || req.body?.videoUrl;
  const normalized = normalizeYouTubeUrl(rawUrl);

  if (!normalized) {
    metrics.downloadFailures++;
    return res.status(400).json({ ok: false, error: "URL do YouTube inválida." });
  }

  const start = Math.max(0, safeNumber(req.body?.start, 0));
  const duration = clamp(safeNumber(req.body?.duration, 50), 1, 180);

  if (!user.vip && user.points < DOWNLOAD_COST) {
    return res.status(402).json({
      ok: false,
      error: `Você não tem pontos suficientes. São necessários ${DOWNLOAD_COST} pontos.`,
      code: "INSUFFICIENT_POINTS",
    });
  }

  let original = null;
  let clipPath = null;
  let charged = false;

  try {
    original = await downloadOriginalVideo({
      youtubeUrl: normalized.url,
      videoId: normalized.videoId,
    });

    const validation = await validateVideoFile(original.path);
    let actualDuration = duration;
    if (start >= validation.duration) {
      throw new Error("O tempo inicial solicitado está além da duração total do vídeo.");
    }
    actualDuration = Math.min(actualDuration, validation.duration - start);

    const filename = `clipforge_${normalized.videoId}_${Math.floor(start)}s.mp4`;
    clipPath = path.join(OUTPUT_DIR, filename);

    await renderClip({
      inputPath: original.path,
      outputPath: clipPath,
      start,
      duration: actualDuration,
    });

    if (!user.vip) {
      user.points -= DOWNLOAD_COST;
      charged = true;
    }
    user.downloads++;
    metrics.downloadSuccess++;

    await safeRemove(original.path);
    original = null;

    return res.download(clipPath, filename, async (err) => {
      await safeRemove(clipPath);
      if (err) {
        if (charged && !user.vip) user.points += DOWNLOAD_COST;
        console.error("[Download] Erro no envio do stream:", err.message);
      }
    });
  } catch (error) {
    metrics.downloadFailures++;
    if (charged && !user.vip) user.points += DOWNLOAD_COST;
    await safeRemove(clipPath);
    if (original) await safeRemove(original.path);

    console.error(`[Download] Erro: ${redactSecrets(error.message)}`);
    return res.status(500).json({
      ok: false,
      error: redactSecrets(error.message) || "Falha ao gerar o corte.",
      code: "DOWNLOAD_FAILED",
    });
  }
});

/* ============================================================
 * MERCADO PAGO / PIX
 * ============================================================ */

app.post("/api/pix/criar", async (req, res) => {
  const user = resolveRequestUser(req);
  if (!MP_ACCESS_TOKEN) return res.status(503).json({ ok: false, error: "Mercado Pago não configurado." });

  const amount = Number(safeNumber(req.body?.amount ?? req.body?.valor, 19.90).toFixed(2));
  const extRef = `clipforge_${user.id}_${randomId()}`;

  try {
    const mpRes = await fetch("[https://api.mercadopago.com/v1/payments](https://api.mercadopago.com/v1/payments)", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": randomId("mp_"),
      },
      body: JSON.stringify({
        transaction_amount: amount,
        description: "ClipForge Pro VIP",
        payment_method_id: "pix",
        external_reference: extRef,
        payer: { email: `cliente-${user.id}@clipforge.local` },
      }),
    });

    const data = await mpRes.json();
    if (!mpRes.ok) throw new Error(data.message || "Erro Mercado Pago.");

    const tx = data.point_of_interaction?.transaction_data || {};
    const paymentId = String(data.id);
    payments.set(paymentId, { id: paymentId, userId: user.id, status: data.status });
    metrics.pixCreated++;

    return res.json({
      ok: true,
      id: paymentId,
      status: data.status,
      qr_code: tx.qr_code || "",
      qrCode: tx.qr_code || "",
      qr_code_base64: tx.qr_code_base64 || "",
      qrCodeBase64: tx.qr_code_base64 || "",
      ticket_url: tx.ticket_url || "",
      ticketUrl: tx.ticket_url || "",
      amount,
    });
  } catch (error) {
    metrics.pixRejected++;
    return res.status(500).json({ ok: false, error: redactSecrets(error.message) });
  }
});

app.get("/api/pix/status/:id", async (req, res) => {
  if (!MP_ACCESS_TOKEN) return res.status(503).json({ ok: false, error: "Mercado Pago não configurado." });

  try {
    const response = await fetch(`[https://api.mercadopago.com/v1/payments/$](https://api.mercadopago.com/v1/payments/$){encodeURIComponent(req.params.id)}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);

    const approved = data.status === "approved";
    if (approved) {
      const rec = payments.get(String(req.params.id));
      if (rec?.userId) {
        const u = users.get(rec.userId);
        if (u) {
          if (!u.vip) metrics.pixApproved++;
          u.vip = true;
        }
      }
    }

    return res.json({ ok: true, id: data.id, status: data.status, approved });
  } catch (error) {
    return res.status(500).json({ ok: false, error: redactSecrets(error.message) });
  }
});

/* ============================================================
 * ADMIN
 * ============================================================ */

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: "Credenciais inválidas." });
  }
  const token = createAdminSession();
  return res.json({ ok: true, token, user: ADMIN_USER });
});

app.get("/api/admin/dashboard", requireAdmin, (req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    server: { uptime: process.uptime(), node: process.version },
    metrics,
    usersCount: users.size,
  });
});

/* ============================================================
 * 404 & ERROR HANDLING
 * ============================================================ */

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Rota não encontrada.", path: req.originalUrl });
});

app.use((error, req, res, next) => {
  metrics.errors++;
  console.error("[Global Error]", redactSecrets(error?.stack || error?.message || String(error)));
  if (res.headersSent) return next(error);
  res.status(500).json({ ok: false, error: redactSecrets(error?.message) || "Erro interno do servidor." });
});

/* ============================================================
 * INICIALIZAÇÃO DO SERVIDOR
 * ============================================================ */

async function startServer() {
  await ensureDirectories();
  await cleanupOldFiles();
  setInterval(() => { cleanupOldFiles().catch(() => {}); }, 30 * 60 * 1000);

  app.listen(PORT, HOST, async () => {
    console.log("");
    console.log("====================================================");
    console.log(`CLIPFORGE PRO ${APP_VERSION} online em http://${HOST}:${PORT}`);
    console.log(`Gemini Model: ${GEMINI_MODEL}`);
    console.log(`yt-dlp: ${YTDLP_PATH}`);
    console.log(`FFmpeg: ${FFMPEG_PATH}`);
    console.log(`FFprobe: ${FFPROBE_PATH}`);
    console.log("====================================================");
    console.log("");

    const yt = await commandExists(YTDLP_PATH).catch(() => fs.existsSync(YTDLP_PATH));
    const ff = await commandExists(FFMPEG_PATH).catch(() => fs.existsSync(FFMPEG_PATH));
    console.log(`[Startup] yt-dlp: ${yt ? "OK" : "NÃO ENCONTRADO"}`);
    console.log(`[Startup] FFmpeg: ${ff ? "OK" : "NÃO ENCONTRADO"}`);
  });
}

startServer().catch((error) => {
  console.error("[FATAL] Erro ao iniciar servidor:", redactSecrets(error?.stack || error?.message || String(error)));
  process.exit(1);
});
