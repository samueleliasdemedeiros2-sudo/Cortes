/**
 * ============================================================
 * CLIPFORGE PRO — BACKEND 13.1.1
 * Node.js + Express
 *
 * Compatível com o index.html V13.0.7
 *
 * Endpoints:
 * POST /api/auth/login
 * GET  /api/auth/me
 * POST /api/analisar
 * POST /api/download
 * POST /api/pix/criar
 * GET  /api/pix/status/:id
 * POST /api/admin/login
 * GET  /api/admin/dashboard
 * GET  /health
 *
 * Download Pipeline:
 * Downloader Externo -> RapidAPI -> yt-dlp fallback -> FFmpeg
 *
 * Gemini:
 * - Interactions API oficial com x-goog-api-key
 * - gemini-3.8-flash com thinking_level: "low"
 * - Fallback instantâneo para gemini-3.7-flash e 3.6-flash em HTTP 503
 * ============================================================
 */

require("dotenv").config();

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

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";
const VERSION = "13.1.1";

const FREE_POINTS = Number(process.env.FREE_POINTS || 200);
const DAILY_POINTS = Number(process.env.DAILY_POINTS || 50);
const DOWNLOAD_COST = Number(process.env.DOWNLOAD_COST || 50);
const VIP_PRICE = Number(process.env.VIP_PRICE || 19.90);
const MAX_CLIPS = Number(process.env.MAX_CLIPS || 5);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_TOKEN_TTL = 24 * 60 * 60 * 1000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

/* ============================================================
   GEMINI CONFIG
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
  "gemini-3.7-flash,gemini-3.6-flash"
)
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean)
  .filter((v, i, arr) => arr.indexOf(v) === i && v !== GEMINI_MODEL);

const GEMINI_INTERACTIONS_URL =
  process.env.GEMINI_INTERACTIONS_URL ||
  "https://generativelanguage.googleapis.com/v1beta/interactions";

/* ============================================================
   DOWNLOADERS & MERCADO PAGO
============================================================ */

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || process.env.X_RAPIDAPI_KEY || "";
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || "youtube-media-downloader.p.rapidapi.com";
const EXTERNAL_DOWNLOAD_URL = process.env.EXTERNAL_DOWNLOAD_URL || "";
const EXTERNAL_DOWNLOAD_TOKEN = process.env.EXTERNAL_DOWNLOAD_TOKEN || "";

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || process.env.MERCADOPAGO_ACCESS_TOKEN || "";
const MP_API = "https://api.mercadopago.com";

const TEMP_ROOT = path.join(os.tmpdir(), "clipforge-pro");
const DOWNLOAD_DIR = path.join(TEMP_ROOT, "downloads");
const OUTPUT_DIR = path.join(TEMP_ROOT, "outputs");

/* ============================================================
   BINÁRIOS
============================================================ */

function findExecutable(candidates = []) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

const YTDLP_BIN =
  process.env.YTDLP_PATH ||
  process.env.YTDLP_BIN ||
  findExecutable([
    path.join(process.cwd(), "bin", "yt-dlp"),
    path.join(process.cwd(), "yt-dlp"),
  ]) ||
  "yt-dlp";

const FFMPEG_BIN =
  process.env.FFMPEG_PATH ||
  process.env.FFMPEG_BIN ||
  findExecutable([
    path.join(process.cwd(), "bin", "ffmpeg"),
    path.join(process.cwd(), "ffmpeg"),
  ]) ||
  "ffmpeg";

const FFPROBE_BIN =
  process.env.FFPROBE_PATH ||
  process.env.FFPROBE_BIN ||
  findExecutable([
    path.join(process.cwd(), "bin", "ffprobe"),
    path.join(process.cwd(), "ffprobe"),
  ]) ||
  "ffprobe";

const YTDLP_COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || "";

/* ============================================================
   MEMÓRIA & MÉTRICAS
============================================================ */

const sessions = new Map();
const adminSessions = new Map();
const users = new Map();
const payments = new Map();

const metrics = {
  requests: 0,
  analyses: 0,
  downloads: 0,
  pixCreated: 0,
  pixApproved: 0,
  geminiRetries: 0,
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
    methods: ["GET", "POST", "OPTIONS"],
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
   HELPERS
============================================================ */

function now() { return Date.now(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString("hex"); }

function safeUserId(value) {
  if (!value) return null;
  const v = String(value).trim();
  return /^[A-Za-z0-9_-]{6,128}$/.test(v) ? v : null;
}

function getBearer(req) {
  const header = req.headers.authorization || "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
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

  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  return null;
}

function youtubeUrl(value) {
  const id = youtubeIdFromUrl(value);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

function parseNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function jsonError(res, status, message, extra = {}) {
  return res.status(status).json({ error: message, ...extra });
}

function redactSecrets(text) {
  let val = String(text || "");
  const secrets = [GEMINI_API_KEY, RAPIDAPI_KEY, MP_ACCESS_TOKEN, ADMIN_PASSWORD].filter(Boolean);
  for (const s of secrets) {
    try {
      val = val.replace(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "[REDACTED]");
    } catch {}
  }
  return val;
}

/* ============================================================
   USUÁRIOS & SESSÕES
============================================================ */

function ensureUser(userId) {
  const id = safeUserId(userId) || crypto.randomUUID();
  let user = users.get(id);

  if (!user) {
    user = {
      id,
      points: FREE_POINTS,
      vip: false,
      createdAt: now(),
      lastDailyClaim: 0,
      downloads: 0,
      analyses: 0,
    };
    users.set(id, user);
  }

  claimDailyPoints(user);
  return user;
}

function claimDailyPoints(user) {
  const day = new Date().toISOString().slice(0, 10);
  const prev = user.lastDailyClaim ? new Date(user.lastDailyClaim).toISOString().slice(0, 10) : "";
  if (day !== prev) {
    user.points += DAILY_POINTS;
    user.lastDailyClaim = now();
  }
}

function publicUser(user) {
  return {
    id: user.id,
    points: Math.max(0, Math.floor(user.points)),
    vip: Boolean(user.vip),
  };
}

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

/* ============================================================
   PROCESSOS & VALIDAÇÃO
============================================================ */

function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > 500000) stdout = stdout.slice(-500000);
    });

    child.stderr?.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 500000) stderr = stderr.slice(-500000);
    });

    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function commandExists(command) {
  const result = await spawnCapture(command, ["--version"]).catch(() => ({ code: -1 }));
  return result.code === 0;
}

async function ensureDirectories() {
  await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
}

async function cleanup(...files) {
  await Promise.all(
    files.filter(Boolean).map(async (file) => {
      try { await fsp.rm(file, { force: true, recursive: true }); } catch {}
    })
  );
}

async function validateVideoFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("Arquivo não encontrado.");
  }
  const stat = await fsp.stat(filePath);
  if (stat.size < 10000) {
    throw new Error(`Arquivo muito pequeno (${stat.size} bytes).`);
  }

  const probe = await spawnCapture(FFPROBE_BIN, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    filePath,
  ]);

  if (probe.code !== 0) {
    throw new Error("FFprobe rejeitou o arquivo.");
  }

  const data = JSON.parse(probe.stdout);
  const duration = Number(data?.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Duração de vídeo inválida.");
  }
  return { duration, size: stat.size };
}

/* ============================================================
   GEMINI — INTERACTIONS API COM RETRY E FALLBACK AUTOMÁTICO
============================================================ */

async function requestGeminiModel(model, url, prompt) {
  const body = {
    model,
    input: [
      { type: "text", text: prompt },
      { type: "video", uri: url },
    ],
    generation_config: { thinking_level: "low" },
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema: {
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
              required: ["start", "end", "duration", "title", "description", "score"],
            },
          },
        },
        required: ["clips"],
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);

  let response;
  try {
    response = await fetch(GEMINI_INTERACTIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!response.ok) {
    const detail = data?.error?.message || data?.message || "Erro na API Gemini.";
    const error = new Error(`Gemini HTTP ${response.status}: ${detail}`);
    error.status = response.status;
    error.model = model;
    error.geminiDetail = detail;
    throw error;
  }

  let outText = data?.output_text || data?.outputText || data?.text || "";

  if (!outText && Array.isArray(data?.steps)) {
    for (const step of data.steps) {
      if (Array.isArray(step?.content)) {
        for (const c of step.content) {
          if (c?.text) outText += c.text + "\n";
        }
      }
    }
  }

  if (!outText) {
    outText = JSON.stringify(data);
  }

  outText = outText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(outText);
  } catch {
    const m = outText.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`Gemini (${model}) não retornou JSON estruturado.`);
    parsed = JSON.parse(m[0]);
  }

  const clips = (parsed.clips || []).map((c, i) => {
    const s = Math.max(0, parseNumber(c.start, 0));
    const d = clamp(parseNumber(c.duration, (parseNumber(c.end, s + 50) - s)), 20, 60);
    return {
      start: Number(s.toFixed(2)),
      end: Number((s + d).toFixed(2)),
      duration: Number(d.toFixed(2)),
      title: String(c.title || `Corte #${i + 1}`).slice(0, 140),
      description: String(c.description || "Destaque selecionado por IA").slice(0, 500),
      score: clamp(Math.round(parseNumber(c.score, 80)), 0, 100),
    };
  }).slice(0, MAX_CLIPS);

  return {
    clips,
    model,
    fallback: model !== GEMINI_MODEL,
  };
}

async function analyzeWithGemini(url, videoId) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY não configurada.");

  const prompt = `
Você é o motor de seleção de cortes do ClipForge Pro.
Analise integralmente o vídeo do YouTube: ${url}
Encontre até ${MAX_CLIPS} momentos ideais para Shorts, TikTok e Reels (duração de 20 a 60 segundos).
Retorne estritamente o JSON estruturado conforme o schema.
`.trim();

  const models = [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS];
  let lastError = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      console.log(`[Gemini] Tentando modelo ${model} (${i + 1}/${models.length})...`);
      const result = await requestGeminiModel(model, url, prompt);
      console.log(`[Gemini] Sucesso com ${model}.`);
      return result;
    } catch (error) {
      lastError = error;
      const status = Number(error.status || 0);

      // 503 Alta Demanda: muda imediatamente para o próximo modelo sem travar
      if (status === 503) {
        console.warn(`[Gemini] ${model} retornou HTTP 503 (alta demanda). Comutando para próximo modelo...`);
        if (i < models.length - 1) {
          await sleep(1000);
          continue;
        }
      }

      // 429 Rate Limit: retry único com backoff curto
      if (status === 429) {
        metrics.geminiRetries++;
        console.warn(`[Gemini] ${model} retornou HTTP 429. Tentando novamente em 2s...`);
        await sleep(2000);
        try {
          return await requestGeminiModel(model, url, prompt);
        } catch (retryErr) {
          lastError = retryErr;
          if (i < models.length - 1) continue;
        }
      }

      if (i < models.length - 1) {
        await sleep(800);
        continue;
      }
    }
  }

  throw lastError || new Error("Gemini indisponível no momento.");
}

/* ============================================================
   PIPELINE DE DOWNLOAD RESILIENTE
============================================================ */

async function downloadOriginalVideo(url, videoId, workDir) {
  const outputPath = path.join(workDir, "source.mp4");
  const failures = [];

  // 1. Downloader Externo
  if (EXTERNAL_DOWNLOAD_URL) {
    try {
      console.log("[Download] Tentando Downloader Externo...");
      const res = await fetch(EXTERNAL_DOWNLOAD_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(EXTERNAL_DOWNLOAD_TOKEN ? { Authorization: `Bearer ${EXTERNAL_DOWNLOAD_TOKEN}` } : {}),
        },
        body: JSON.stringify({ url, videoId, output: "mp4" }),
        signal: AbortSignal.timeout(180000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(outputPath));
      await validateVideoFile(outputPath);
      return outputPath;
    } catch (e) {
      failures.push(`Externo: ${e.message}`);
      await safeRemove(outputPath);
    }
  }

  // 2. RapidAPI
  if (RAPIDAPI_KEY) {
    try {
      console.log("[Download] Tentando RapidAPI...");
      const ep = `https://${RAPIDAPI_HOST}/dl?id=${encodeURIComponent(videoId)}&cgeo=BR`;
      const res = await fetch(ep, {
        method: "GET",
        headers: { "x-rapidapi-key": RAPIDAPI_KEY, "x-rapidapi-host": RAPIDAPI_HOST },
        signal: AbortSignal.timeout(60000),
      });

      if (res.status === 429) throw new Error("RapidAPI_RATE_LIMITED");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const urls = [];
      const collect = (o) => {
        if (!o || typeof o !== "object") return;
        if (typeof o.url === "string" && o.url.startsWith("http")) urls.push(o.url);
        for (const k of Object.keys(o)) collect(o[k]);
      };
      collect(data);

      const streamUrl = urls[0];
      if (!streamUrl) throw new Error("Sem URLs disponíveis.");

      const sRes = await fetch(streamUrl, { signal: AbortSignal.timeout(120000) });
      if (!sRes.ok) throw new Error(`Stream HTTP ${sRes.status}`);

      await pipeline(Readable.fromWeb(sRes.body), fs.createWriteStream(outputPath));
      await validateVideoFile(outputPath);
      return outputPath;
    } catch (e) {
      failures.push(`RapidAPI: ${e.message}`);
      await safeRemove(outputPath);
    }
  }

  // 3. yt-dlp Local
  try {
    console.log("[Download] Tentando yt-dlp...");
    const args = [
      "--no-playlist", "--no-warnings", "--newline", "--restrict-filenames",
      "--no-check-certificates", "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
      "--merge-output-format", "mp4", "-o", outputPath,
    ];

    if (YTDLP_COOKIES_FILE && fs.existsSync(YTDLP_COOKIES_FILE)) {
      args.push("--cookies", YTDLP_COOKIES_FILE);
    }
    args.push(url);

    const result = await spawnCapture(YTDLP_BIN, args, { timeout: 300000 });
    if (result.code !== 0) {
      if (/sign in to confirm|not a bot/i.test(result.stderr)) {
        throw new Error("O YouTube bloqueou o IP do servidor com proteção anti-bot.");
      }
      throw new Error(`yt-dlp código ${result.code}: ${redactSecrets(result.stderr).slice(-600)}`);
    }

    await validateVideoFile(outputPath);
    return outputPath;
  } catch (e) {
    failures.push(`yt-dlp: ${e.message}`);
    await safeRemove(outputPath);
    throw new Error(`Todos os métodos de download falharam: ${failures.join(" | ")}`);
  }
}

async function renderClip(sourceFile, outputFile, start, duration) {
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-ss", String(start),
    "-i", sourceFile,
    "-t", String(duration),
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "22",
    "-c:a", "aac",
    "-b:a", "128k",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-avoid_negative_ts", "make_zero",
    "-y", outputFile,
  ];

  const result = await spawnCapture(FFMPEG_BIN, args);
  if (result.code !== 0) {
    throw new Error(`FFmpeg erro: ${redactSecrets(result.stderr).slice(-800)}`);
  }

  const stat = await fsp.stat(outputFile);
  if (!stat.size) throw new Error("FFmpeg gerou arquivo vazio.");
  return outputFile;
}

/* ============================================================
   ROTAS
============================================================ */

app.get("/", (req, res) => {
  res.json({ name: "ClipForge Pro", version: VERSION, status: "online" });
});

app.get("/health", async (req, res) => {
  const yt = await commandExists(YTDLP_BIN).catch(() => fs.existsSync(YTDLP_BIN));
  const ff = await commandExists(FFMPEG_BIN).catch(() => fs.existsSync(FFMPEG_BIN));
  res.json({
    ok: true,
    version: VERSION,
    ytDlp: yt,
    ffmpeg: ff,
    geminiConfigured: Boolean(GEMINI_API_KEY),
    geminiModel: GEMINI_MODEL,
    geminiFallbacks: GEMINI_FALLBACK_MODELS,
    mercadoPagoConfigured: Boolean(MP_ACCESS_TOKEN),
    uptime: process.uptime(),
  });
});

app.post("/api/auth/login", (req, res) => {
  try {
    const user = ensureUser(req.body?.userId);
    const token = randomToken(32);
    sessions.set(token, { userId: user.id, createdAt: now(), expiresAt: now() + SESSION_TTL });
    return res.json({ ok: true, token, user: publicUser(user) });
  } catch (error) {
    metrics.errors++;
    return jsonError(res, 500, "Erro ao iniciar sessão.");
  }
});

app.get("/api/auth/me", requireUser, (req, res) => {
  claimDailyPoints(req.user);
  res.json({ ok: true, user: publicUser(req.user) });
});

app.post("/api/analisar", requireUser, async (req, res) => {
  const inputUrl = String(req.body?.url || "").trim();
  const videoId = youtubeIdFromUrl(inputUrl);

  if (!videoId) {
    return jsonError(res, 400, "Link do YouTube inválido.");
  }

  const url = youtubeUrl(inputUrl);
  metrics.analyses++;
  req.user.analyses++;

  try {
    const result = await analyzeWithGemini(url, videoId);
    return res.json({
      ok: true,
      videoId,
      clips: result.clips,
      user: publicUser(req.user),
      fallback: Boolean(result.fallback),
      model: result.model,
      version: VERSION,
    });
  } catch (error) {
    metrics.errors++;
    console.error("[Gemini]", error.message);
    return jsonError(res, 502, error.message || "Não foi possível analisar o vídeo.");
  }
});

app.post("/api/download", requireUser, async (req, res) => {
  const inputUrl = String(req.body?.url || "").trim();
  const videoId = youtubeIdFromUrl(inputUrl);

  if (!videoId) return jsonError(res, 400, "URL do YouTube inválida.");

  const start = parseNumber(req.body?.start, NaN);
  const duration = parseNumber(req.body?.duration, NaN);

  if (!Number.isFinite(start) || start < 0) return jsonError(res, 400, "Tempo inicial inválido.");
  if (!Number.isFinite(duration) || duration < 1 || duration > 90) return jsonError(res, 400, "Duração inválida (1-90s).");

  if (!req.user.vip && req.user.points < DOWNLOAD_COST) {
    return jsonError(res, 402, `Você não tem pontos suficientes (${DOWNLOAD_COST} necessários).`);
  }

  const url = youtubeUrl(inputUrl);
  const jobId = crypto.randomUUID();
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `clipforge-${jobId}-`));
  const outputFile = path.join(workDir, `clip-${jobId}.mp4`);
  let charged = false;

  try {
    const sourceFile = await downloadOriginalVideo(url, videoId, workDir);
    await renderClip(sourceFile, outputFile, start, duration);

    const stat = await fsp.stat(outputFile);
    if (!stat.size || stat.size < 10000) throw new Error("MP4 final inválido.");

    if (!req.user.vip) {
      req.user.points -= DOWNLOAD_COST;
      charged = true;
    }

    req.user.downloads++;
    metrics.downloads++;

    const filename = `clipforge_${videoId}_${Math.floor(start)}s.mp4`;
    res.status(200);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");

    const stream = fs.createReadStream(outputFile);
    stream.on("error", async (err) => {
      if (charged && !req.user.vip) req.user.points += DOWNLOAD_COST;
      await cleanup(workDir);
    });

    res.on("close", () => { cleanup(workDir).catch(() => {}); });
    stream.pipe(res);
  } catch (error) {
    metrics.errors++;
    if (charged && !req.user.vip) req.user.points += DOWNLOAD_COST;
    await cleanup(workDir);
    return jsonError(res, 500, error.message || "Erro ao renderizar o vídeo.");
  }
});

/* ============================================================
   MERCADO PAGO / PIX
============================================================ */

async function mercadoPagoRequest(endpoint, options = {}) {
  if (!MP_ACCESS_TOKEN) throw new Error("MP_ACCESS_TOKEN não configurado.");
  const res = await fetch(`${MP_API}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || `Mercado Pago HTTP ${res.status}`);
  return data;
}

app.post("/api/pix/criar", requireUser, async (req, res) => {
  if (!MP_ACCESS_TOKEN) return jsonError(res, 503, "Pix não configurado.");

  try {
    const payment = await mercadoPagoRequest("/v1/payments", {
      method: "POST",
      headers: { "X-Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        transaction_amount: Number(VIP_PRICE.toFixed(2)),
        description: "ClipForge Pro VIP",
        payment_method_id: "pix",
        payer: { email: `cliente-${req.user.id}@clipforge.local` },
        external_reference: `clipforge_${req.user.id}_${crypto.randomUUID()}`,
      }),
    });

    const tx = payment.point_of_interaction?.transaction_data || {};
    payments.set(String(payment.id), { id: String(payment.id), userId: req.user.id, status: payment.status });
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
  } catch (error) {
    metrics.errors++;
    return jsonError(res, 502, error.message || "Erro criando Pix.");
  }
});

app.get("/api/pix/status/:id", requireUser, async (req, res) => {
  try {
    const payment = await mercadoPagoRequest(`/v1/payments/${encodeURIComponent(req.params.id)}`, { method: "GET" });
    const approved = payment.status === "approved";

    if (approved && !req.user.vip) {
      req.user.vip = true;
      metrics.pixApproved++;
    }

    return res.json({ ok: true, id: req.params.id, status: payment.status, approved, user: publicUser(req.user) });
  } catch (error) {
    return jsonError(res, 502, error.message || "Erro consultando Pix.");
  }
});

/* ============================================================
   ADMIN
============================================================ */

app.post("/api/admin/login", (req, res) => {
  if (!ADMIN_PASSWORD) return jsonError(res, 503, "ADMIN_PASSWORD não configurada.");
  const password = String(req.body?.password || "");

  if (password !== ADMIN_PASSWORD) {
    return jsonError(res, 401, "Senha administrativa incorreta.");
  }

  const token = randomToken(32);
  adminSessions.set(token, { createdAt: now(), expiresAt: now() + ADMIN_TOKEN_TTL });
  return res.json({ ok: true, token });
});

app.get("/api/admin/dashboard", requireAdmin, (req, res) => {
  let vipUsers = 0, totalPoints = 0, totalDownloads = 0, totalAnalyses = 0;
  for (const u of users.values()) {
    if (u.vip) vipUsers++;
    totalPoints += Math.max(0, u.points);
    totalDownloads += u.downloads;
    totalAnalyses += u.analyses;
  }

  return res.json({
    ok: true,
    metrics: { ...metrics, users: users.size, vipUsers, totalPoints, totalDownloads, totalAnalyses },
    version: VERSION,
  });
});

/* ============================================================
   404 & START
============================================================ */

app.use((req, res) => jsonError(res, 404, "Endpoint não encontrado."));
app.use((err, req, res, next) => {
  metrics.errors++;
  console.error("[Server Error]", err);
  if (!res.headersSent) jsonError(res, 500, "Erro interno do servidor.");
});

app.listen(PORT, HOST, async () => {
  await ensureDirectories();
  console.log("====================================================");
  console.log(`ClipForge Pro Backend ${VERSION} online em http://${HOST}:${PORT}`);
  console.log(`Gemini: ${GEMINI_MODEL} (Fallbacks: ${GEMINI_FALLBACK_MODELS.join(", ")})`);
  console.log(`yt-dlp: ${YTDLP_BIN}`);
  console.log(`FFmpeg: ${FFMPEG_BIN}`);
  console.log("====================================================");
});
