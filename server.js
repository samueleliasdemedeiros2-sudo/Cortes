/**
 * ============================================================
 * CLIPFORGE PRO — BACKEND V15.3.1
 * CONSOLIDADO + RANGE/HEAD + FILA PROTEGIDA + RESERVAS
 * ============================================================
 */

"use strict";

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const { criarPagamentoPix, consultarPagamentoPix } = require("./mercadoPago");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";
const VERSION = "15.3.1-production-engine";

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 150);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const FREE_POINTS = Number(process.env.FREE_POINTS || 200);
const DAILY_POINTS = Number(process.env.DAILY_POINTS || 50);
const ANALYSIS_COST = Number(process.env.ANALYSIS_COST || 20);
const DOWNLOAD_COST = Number(process.env.DOWNLOAD_COST || 50);
const VIP_PRICE = Number(process.env.VIP_PRICE || 19.90);
const MAX_CLIPS = Number(process.env.MAX_CLIPS || 8);
const CONCURRENT_JOBS_LIMIT = Number(process.env.CONCURRENT_JOBS_LIMIT || 1);
const MAX_QUEUE_LENGTH = Number(process.env.MAX_QUEUE_LENGTH || 25);

const TEMP_ROOT = process.env.TEMP_DIR || path.join(os.tmpdir(), "clipforge");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(TEMP_ROOT, "uploads");
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(TEMP_ROOT, "outputs");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_API_KEY || "";
const OPENROUTER_URL = process.env.OPENROUTER_URL || "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001";
const OPENROUTER_FALLBACK_MODELS = (process.env.OPENROUTER_FALLBACK_MODELS || "google/gemini-2.5-flash,google/gemini-2.5-flash-lite")
    .split(",").map(x => x.trim()).filter(Boolean);
const OPENROUTER_MODELS = [OPENROUTER_MODEL, ...OPENROUTER_FALLBACK_MODELS.filter(m => m !== OPENROUTER_MODEL)];

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL ||
    "https://clipforge-server-ikai.onrender.com";
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || "https://cortesdomnr.vercel.app";
const OPENROUTER_SITE_NAME = process.env.OPENROUTER_SITE_NAME || "ClipForge Pro";

const MP_CONFIGURED = Boolean(process.env.MP_ACCESS_TOKEN || process.env.MERCADO_PAGO_ACCESS_TOKEN);
const MP_WEBHOOK_URL = process.env.MP_WEBHOOK_URL || process.env.MERCADO_PAGO_WEBHOOK_URL || "";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@clipforge.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const YTDLP_COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || process.env.YOUTUBE_COOKIES_FILE || "";

const YOUTUBE_SOURCE_TIMEOUT_MS = Number(process.env.YOUTUBE_SOURCE_TIMEOUT_MS || 15000);
const YOUTUBE_DOWNLOAD_TIMEOUT_MS = Number(process.env.YOUTUBE_DOWNLOAD_TIMEOUT_MS || 300000);

const PIPED_API_URLS = (process.env.PIPED_API_URLS ||
    "https://pipedapi.kavin.rocks,https://pipedapi.leptons.xyz,https://pipedapi.tokhmi.xyz")
    .split(",").map(x => x.trim().replace(/\/+$/, "")).filter(Boolean);

const INVIDIOUS_API_URLS = (process.env.INVIDIOUS_API_URLS ||
    "https://inv.nadeko.net,https://invidious.nerdvpn.de,https://yt.chocolatemoo53.com")
    .split(",").map(x => x.trim().replace(/\/+$/, "")).filter(Boolean);

let FFMPEG_BIN = "ffmpeg";
let FFPROBE_BIN = "ffprobe";
let YTDLP_BIN = path.join(__dirname, "bin", "yt-dlp");

const users = new Map();
const sessions = new Map();
const adminSessions = new Map();
const uploads = new Map();
const payments = new Map();
const jobs = new Map();
const aiVideoTokens = new Map();
const jobQueue = [];
let activeWorkers = 0;

const metrics = {
    startedAt: Date.now(), requests: 0, uploads: 0, analyses: 0,
    successfulAnalyses: 0, failedAnalyses: 0, downloads: 0,
    pixCreated: 0, pixApproved: 0, openRouterRetries: 0,
    openRouterFallbacks: 0, errors: 0
};

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(cors({
    origin: true, credentials: false,
    methods: ["GET", "POST", "HEAD", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Session", "Range"]
}));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));
app.use((req, res, next) => {
    metrics.requests++;
    res.setHeader("X-ClipForge-Version", VERSION);
    next();
});

const now = () => Date.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("hex");
const randomId = prefix => (prefix || "") + crypto.randomUUID();

function safeString(value, fallback = "") {
    return value === null || value === undefined ? fallback : String(value);
}
function parseNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function jsonError(res, status, message, extra = {}) {
    return res.status(status).json({ ok: false, error: message, ...extra });
}
async function safeRemove(filePath) {
    if (!filePath) return;
    try { await fsp.rm(filePath, { recursive: true, force: true }); } catch (_) {}
}
async function ensureDirectories() {
    await fsp.mkdir(TEMP_ROOT, { recursive: true });
    await fsp.mkdir(UPLOAD_DIR, { recursive: true });
    await fsp.mkdir(OUTPUT_DIR, { recursive: true });
}

function spawnCapture(command, args = [], options = {}) {
    return new Promise((resolve, reject) => {
        const { timeoutMs, killGraceMs = 1500, ...spawnOptions } = options;
        let child;
        try { child = spawn(command, args, { windowsHide: true, ...spawnOptions }); }
        catch (e) { return reject(e); }

        let stdout = "", stderr = "", finished = false, timedOut = false;
        let timeoutTimer = null, killTimer = null;
        const clearTimers = () => {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (killTimer) clearTimeout(killTimer);
        };
        const ok = value => {
            if (finished) return;
            finished = true; clearTimers(); resolve(value);
        };
        const fail = error => {
            if (finished) return;
            finished = true; clearTimers(); reject(error);
        };

        child.stdout?.on("data", c => {
            stdout += c.toString();
            if (stdout.length > 250000) stdout = stdout.slice(-250000);
        });
        child.stderr?.on("data", c => {
            stderr += c.toString();
            if (stderr.length > 250000) stderr = stderr.slice(-250000);
        });
        child.once("error", error => {
            if (timedOut) {
                const e = new Error(`Processo excedeu timeout de ${timeoutMs}ms.`);
                e.code = "ETIMEDOUT"; e.stdout = stdout; e.stderr = stderr; return fail(e);
            }
            fail(error);
        });
        child.once("close", (code, signal) => {
            if (timedOut) {
                const e = new Error(`Processo excedeu timeout de ${timeoutMs}ms.`);
                e.code = "ETIMEDOUT"; e.stdout = stdout; e.stderr = stderr; return fail(e);
            }
            ok({ code, signal, stdout, stderr });
        });

        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
            timeoutTimer = setTimeout(() => {
                if (finished) return;
                timedOut = true;
                try { child.kill("SIGTERM"); } catch (_) {}
                killTimer = setTimeout(() => {
                    if (finished) return;
                    try { child.kill("SIGKILL"); } catch (_) {}
                }, killGraceMs);
            }, timeoutMs);
        }
    });
}

async function commandExists(command, args = ["--version"]) {
    try {
        return (await spawnCapture(command, args, { timeoutMs: 10000 })).code === 0;
    } catch (_) { return false; }
}

async function resolveBinaries() {
    const ffmpegCandidates = [
        process.env.FFMPEG_PATH, process.env.FFMPEG_BIN,
        path.join(__dirname, "bin", "ffmpeg")
    ];
    try {
        const x = require("ffmpeg-static");
        if (x) ffmpegCandidates.unshift(x);
    } catch (_) {}
    try {
        const x = require("@ffmpeg-installer/ffmpeg");
        if (x?.path) ffmpegCandidates.push(x.path);
    } catch (_) {}
    ffmpegCandidates.push("ffmpeg");

    for (const cand of ffmpegCandidates) {
        if (!cand) continue;
        if (fs.existsSync(cand)) try { fs.chmodSync(cand, 0o755); } catch (_) {}
        if (await commandExists(cand, ["-version"])) { FFMPEG_BIN = cand; break; }
    }

    const ffprobeCandidates = [
        process.env.FFPROBE_PATH, process.env.FFPROBE_BIN,
        path.join(__dirname, "bin", "ffprobe")
    ];
    try {
        const x = require("@ffprobe-installer/ffprobe");
        if (x?.path) ffprobeCandidates.unshift(x.path);
    } catch (_) {}
    ffprobeCandidates.push("ffprobe");

    for (const cand of ffprobeCandidates) {
        if (!cand) continue;
        if (fs.existsSync(cand)) try { fs.chmodSync(cand, 0o755); } catch (_) {}
        if (await commandExists(cand, ["-version"])) { FFPROBE_BIN = cand; break; }
    }

    const ytdlpCandidates = [
        path.join(__dirname, "bin", "yt-dlp"),
        process.env.YTDLP_BIN, process.env.YTDLP_PATH,
        path.join(process.cwd(), "bin", "yt-dlp"), "yt-dlp"
    ];
    for (const cand of ytdlpCandidates) {
        if (!cand) continue;
        if (fs.existsSync(cand)) try { fs.chmodSync(cand, 0o755); } catch (_) {}
        if (await commandExists(cand, ["--version"])) { YTDLP_BIN = cand; break; }
    }

    console.log(`[Binaries] FFmpeg: ${await commandExists(FFMPEG_BIN, ["-version"]) ? FFMPEG_BIN : "AUSENTE"}`);
    console.log(`[Binaries] FFprobe: ${await commandExists(FFPROBE_BIN, ["-version"]) ? FFPROBE_BIN : "AUSENTE"}`);
    console.log(`[Binaries] yt-dlp: ${await commandExists(YTDLP_BIN, ["--version"]) ? YTDLP_BIN : "AUSENTE"}`);
}

async function getVideoMetadata(filePath) {
    const result = await spawnCapture(
        FFPROBE_BIN,
        ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
        { timeoutMs: 30000 }
    );
    if (result.code !== 0) throw new Error(`FFprobe falhou: ${result.stderr || result.stdout}`);
    let data;
    try { data = JSON.parse(result.stdout); } catch (_) {
        throw new Error("FFprobe retornou JSON inválido.");
    }
    const format = data.format || {};
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const video = streams.find(s => s.codec_type === "video") || {};
    const audio = streams.find(s => s.codec_type === "audio") || {};
    return {
        duration: parseNumber(format.duration, 0),
        size: parseNumber(format.size, 0),
        format: format.format_name || null,
        width: parseNumber(video.width, 0),
        height: parseNumber(video.height, 0),
        videoCodec: video.codec_name || null,
        audioCodec: audio.codec_name || null,
        fps: video.r_frame_rate || null
    };
}

async function validateVideoFile(filePath) {
    if (!filePath) throw new Error("Arquivo de vídeo não informado.");
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("O caminho informado não é um arquivo.");
    if (stat.size <= 10000) throw new Error("O arquivo de vídeo está vazio ou inválido.");
    if (stat.size > MAX_UPLOAD_BYTES) throw new Error(`O vídeo excede o limite de ${MAX_UPLOAD_MB} MB.`);
    const metadata = await getVideoMetadata(filePath);
    if (!metadata.duration || metadata.duration <= 0) throw new Error("Não foi possível obter a duração do vídeo.");
    return metadata;
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${randomId("upload_")}.mp4`)
});
const uploadMiddleware = multer({
    storage,
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
        const mime = safeString(file.mimetype).toLowerCase();
        const name = safeString(file.originalname).toLowerCase();
        if (mime !== "video/mp4" || !/\.mp4$/i.test(name))
            return cb(new Error("Apenas arquivos MP4 são suportados."));
        cb(null, true);
    }
});

function getYouTubeId(value) {
    const input = safeString(value).trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
    try {
        const url = new URL(input);
        const host = url.hostname.toLowerCase();
        if (host === "youtu.be") {
            const id = url.pathname.replace(/^\//, "").split("/")[0];
            return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
        }
        if (host.includes("youtube.com")) {
            const v = url.searchParams.get("v");
            if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
            const parts = url.pathname.split("/").filter(Boolean);
            const index = parts.findIndex(p => ["shorts", "embed", "live"].includes(p));
            if (index >= 0 && /^[A-Za-z0-9_-]{11}$/.test(parts[index + 1] || ""))
                return parts[index + 1];
        }
    } catch (_) {}
    return null;
}
function normalizeYouTubeUrl(value) {
    const id = getYouTubeId(value);
    return id ? `https://www.youtube.com/watch?v=${id}` : null;
}
function isMp4Stream(stream) {
    const type = safeString(stream?.type || stream?.mimeType || stream?.mime_type).toLowerCase();
    const container = safeString(stream?.container || stream?.format).toLowerCase();
    const url = safeString(stream?.url).toLowerCase();
    return type.includes("video/mp4") || container.includes("mp4") || url.includes(".mp4");
}
function normalizeQualityNumber(value) {
    const m = safeString(value).match(/(\d{3,4})/);
    return m ? Number(m[1]) : 0;
}

async function downloadRemoteVideo(url, outputFile) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), YOUTUBE_DOWNLOAD_TIMEOUT_MS);
    let fileHandle = null;
    try {
        const res = await fetch(url, {
            redirect: "follow",
            signal: controller.signal,
            headers: { "User-Agent": "ClipForge-Pro/15.3.1", Accept: "video/mp4,video/*;q=0.9,*/*;q=0.8" }
        });
        if (!res.ok || !res.body) throw new Error(`Download HTTP ${res.status}`);
        const length = Number(res.headers.get("content-length") || 0);
        if (length > MAX_UPLOAD_BYTES) throw new Error(`Vídeo excede ${MAX_UPLOAD_MB} MB.`);
        await fsp.mkdir(path.dirname(outputFile), { recursive: true });
        fileHandle = fs.createWriteStream(outputFile);
        let total = 0;
        for await (const chunk of res.body) {
            const b = Buffer.from(chunk);
            total += b.length;
            if (total > MAX_UPLOAD_BYTES) throw new Error(`Download excedeu ${MAX_UPLOAD_MB} MB.`);
            if (!fileHandle.write(b)) await new Promise((resolve, reject) => {
                fileHandle.once("drain", resolve); fileHandle.once("error", reject);
            });
        }
        await new Promise((resolve, reject) => {
            fileHandle.once("error", reject); fileHandle.end(resolve);
        });
        fileHandle = null;
        if (total <= 10000) throw new Error("Stream retornou arquivo inválido.");
        return outputFile;
    } catch (err) {
        try { fileHandle?.destroy(); } catch (_) {}
        await safeRemove(outputFile);
        throw err;
    } finally { clearTimeout(timer); }
}

async function downloadYouTubeWithYtDlp(url, outputTemplate) {
    const args = [
        "--no-playlist", "--no-warnings", "--no-mtime", "--restrict-filenames",
        "--extractor-args", "youtube:player-client=web,android",
        "-f", "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]/best",
        "--merge-output-format", "mp4", "-o", outputTemplate, url
    ];
    if (YTDLP_COOKIES_FILE && fs.existsSync(YTDLP_COOKIES_FILE))
        args.splice(2, 0, "--cookies", YTDLP_COOKIES_FILE);

    const result = await spawnCapture(YTDLP_BIN, args, { timeoutMs: YOUTUBE_DOWNLOAD_TIMEOUT_MS });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "yt-dlp falhou.");
    const directory = path.dirname(outputTemplate);
    const files = await fsp.readdir(directory);
    const candidate = files.find(f => /^source\.mp4$/i.test(f) || /\.mp4$/i.test(f));
    if (!candidate) throw new Error("yt-dlp terminou sem gerar MP4.");
    const filePath = path.join(directory, candidate);
    const metadata = await validateVideoFile(filePath);
    return { filePath, title: "", duration: metadata.duration, source: "yt-dlp" };
}

async function tryPipedDownload(videoId, outputFile) {
    let lastError = null;
    for (const base of PIPED_API_URLS) {
        try {
            const res = await fetch(`${base}/streams/${encodeURIComponent(videoId)}`, {
                headers: { Accept: "application/json", "User-Agent": "ClipForge-Pro/15.3.1" },
                signal: AbortSignal.timeout(YOUTUBE_SOURCE_TIMEOUT_MS)
            });
            if (!res.ok) continue;
            const data = await res.json();
            const streams = Array.isArray(data?.videoStreams) ? data.videoStreams : [];
            const candidates = streams.filter(s => s?.url && s.videoOnly !== true && isMp4Stream(s))
                .map(s => ({ ...s, q: normalizeQualityNumber(s.quality || s.qualityLabel || s.resolution) }))
                .filter(s => s.q > 0 && s.q <= 720).sort((a, b) => b.q - a.q);
            if (!candidates[0]?.url) continue;
            await downloadRemoteVideo(candidates[0].url, outputFile);
            const meta = await validateVideoFile(outputFile);
            return { filePath: outputFile, title: safeString(data?.title), duration: meta.duration, source: "piped" };
        } catch (e) { lastError = e; await safeRemove(outputFile); }
    }
    throw lastError || new Error("Piped indisponível.");
}

async function tryInvidiousDownload(videoId, outputFile) {
    let lastError = null;
    for (const base of INVIDIOUS_API_URLS) {
        try {
            const res = await fetch(`${base}/api/v1/videos/${encodeURIComponent(videoId)}?region=BR`, {
                headers: { Accept: "application/json", "User-Agent": "ClipForge-Pro/15.3.1" },
                signal: AbortSignal.timeout(YOUTUBE_SOURCE_TIMEOUT_MS)
            });
            if (!res.ok) continue;
            const data = await res.json();
            const streams = Array.isArray(data?.formatStreams) ? data.formatStreams : [];
            const candidates = streams.filter(s => s?.url && isMp4Stream(s))
                .map(s => ({ ...s, q: normalizeQualityNumber(s.qualityLabel || s.quality || s.resolution) }))
                .filter(s => s.q > 0 && s.q <= 720).sort((a, b) => b.q - a.q);
            if (!candidates[0]?.url) continue;
            await downloadRemoteVideo(candidates[0].url, outputFile);
            const meta = await validateVideoFile(outputFile);
            return { filePath: outputFile, title: safeString(data?.title), duration: meta.duration, source: "invidious" };
        } catch (e) { lastError = e; await safeRemove(outputFile); }
    }
    throw lastError || new Error("Invidious indisponível.");
}

async function downloadYouTubeVideo(url, outputTemplate) {
    const id = getYouTubeId(url);
    if (!id) throw new Error("ID do YouTube inválido.");
    const dir = path.dirname(outputTemplate);
    await fsp.mkdir(dir, { recursive: true });
    const outputFile = path.join(dir, "source.mp4");
    const errors = [];
    try {
        console.log("[YouTube] Tentativa 1: yt-dlp");
        return await downloadYouTubeWithYtDlp(url, outputTemplate);
    } catch (e) {
        errors.push(`yt-dlp: ${e.message}`);
        metrics.openRouterRetries++;
        console.warn("[YouTube] yt-dlp falhou; Piped...");
    }
    try {
        console.log("[YouTube] Tentativa 2: Piped");
        return await tryPipedDownload(id, outputFile);
    } catch (e) {
        errors.push(`Piped: ${e.message}`);
        console.warn("[YouTube] Piped falhou; Invidious...");
    }
    try {
        console.log("[YouTube] Tentativa 3: Invidious");
        return await tryInvidiousDownload(id, outputFile);
    } catch (e) { errors.push(`Invidious: ${e.message}`); }
    throw new Error(`Todas as tentativas de download falharam:\n${errors.join("\n")}`);
}

function buildClipPrompt(videoDuration) {
    return `Você é um editor profissional de vídeos virais para TikTok, YouTube Shorts e Instagram Reels.
Analise o conteúdo e encontre os momentos com maior retenção.
Duração total: ${Number(videoDuration).toFixed(1)} segundos.

REGRAS:
1. Retorne até ${MAX_CLIPS} cortes.
2. Cada corte deve ter entre 20 e 60 segundos.
3. Não sobreponha cortes.
4. Priorize gancho, emoção, surpresa, conflito, informação forte e final satisfatório.
5. Retorne SOMENTE JSON válido neste formato:
{"clips":[{"start":10.5,"end":45,"duration":34.5,"title":"Gancho magnético","description":"Por que o trecho é forte","score":95}]}`;
}

function normalizeClipsScoreFirst(rawArray, maxDuration) {
    if (!Array.isArray(rawArray)) return [];
    const cleaned = rawArray.map((c, i) => {
        let start = Math.max(0, parseNumber(c?.start ?? c?.inicio, 0));
        let endRaw = parseNumber(c?.end ?? c?.fim, 0);
        let duration = parseNumber(c?.duration ?? c?.duracao, 0);
        if (endRaw > start && !duration) duration = endRaw - start;
        if (!duration) duration = 30;
        duration = clamp(duration, 20, 60);
        if (maxDuration && start >= maxDuration) return null;
        let end = start + duration;
        if (maxDuration && end > maxDuration) { end = maxDuration; duration = end - start; }
        if (duration < 20) return null;
        return {
            start: Number(start.toFixed(2)),
            end: Number(end.toFixed(2)),
            duration: Number(duration.toFixed(2)),
            title: safeString(c?.title ?? c?.titulo, `Corte #${i + 1}`).trim(),
            description: safeString(c?.description ?? c?.descricao).trim(),
            score: clamp(parseNumber(c?.score ?? c?.pontuacao, 85), 0, 100)
        };
    }).filter(Boolean);

    cleaned.sort((a, b) => b.score - a.score);
    const selected = [];
    for (const candidate of cleaned) {
        if (!selected.some(s => candidate.start < s.end && candidate.end > s.start)) {
            selected.push(candidate);
        }
        if (selected.length >= MAX_CLIPS) break;
    }
    return selected.sort((a, b) => a.start - b.start);
}

function extractJsonFromText(text) {
    const raw = safeString(text).trim();
    if (!raw) throw new Error("IA retornou conteúdo vazio.");
    try { return JSON.parse(raw); } catch (_) {}
    const fenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    try { return JSON.parse(fenced); } catch (_) {}
    const first = fenced.indexOf("{");
    const last = fenced.lastIndexOf("}");
    if (first >= 0 && last > first) {
        try { return JSON.parse(fenced.slice(first, last + 1)); } catch (_) {}
    }
    throw new Error("Resposta da IA não contém JSON válido.");
}

async function requestOpenRouter(model, promptText, videoUrl) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
        const content = [{ type: "text", text: promptText }];
        if (videoUrl) content.push({ type: "video_url", video_url: { url: videoUrl } });
        const res = await fetch(OPENROUTER_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
                "HTTP-Referer": OPENROUTER_SITE_URL,
                "X-Title": OPENROUTER_SITE_NAME
            },
            body: JSON.stringify({
                model,
                messages: [{ role: "user", content }],
                response_format: { type: "json_object" }
            }),
            signal: controller.signal
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 500)}`);
        return JSON.parse(text);
    } finally { clearTimeout(timeout); }
}

async function analyzeWithOpenRouterFallback(promptText, videoUrl, videoDuration) {
    if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY não configurada.");
    let lastError = null;
    for (let i = 0; i < OPENROUTER_MODELS.length; i++) {
        const model = OPENROUTER_MODELS[i];
        try {
            console.log(`[IA] Modelo ${model}`);
            const data = await requestOpenRouter(model, promptText, videoUrl);
            const message = data?.choices?.[0]?.message?.content;
            const parsed = extractJsonFromText(typeof message === "string" ? message : JSON.stringify(message));
            const raw = parsed?.clips || parsed?.cortes || parsed;
            const clips = normalizeClipsScoreFirst(raw, videoDuration);
            if (clips.length) return { model, clips };
            throw new Error("IA não retornou cortes válidos.");
        } catch (e) {
            lastError = e;
            if (i < OPENROUTER_MODELS.length - 1) {
                metrics.openRouterRetries++;
                metrics.openRouterFallbacks++;
                console.warn(`[IA] Fallback após falha em ${model}: ${e.message}`);
            } else {
                console.warn(`[IA] Último modelo falhou: ${e.message}`);
            }
        }
    }
    throw lastError || new Error("Todos os modelos de IA falharam.");
}

async function renderClip(sourceFile, outputFile, start, duration, format = "9:16") {
    let vf;
    if (format === "9:16") vf = "crop=ih*(9/16):ih,scale=1080:1920:flags=lanczos";
    else if (format === "1:1") vf = "crop=min(iw\\,ih):min(iw\\,ih),scale=1080:1080:flags=lanczos";
    else if (format === "16:9") vf = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2";
    else throw new Error("Formato inválido. Use 9:16, 1:1 ou 16:9.");

    const args = [
        "-hide_banner", "-loglevel", "error", "-ss", String(start), "-i", sourceFile,
        "-t", String(duration), "-vf", vf, "-c:v", "libx264", "-preset", "ultrafast",
        "-threads", "2", "-crf", "24", "-c:a", "aac", "-b:a", "128k",
        "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", "-y", outputFile
    ];
    const result = await spawnCapture(FFMPEG_BIN, args, { timeoutMs: 180000 });
    if (result.code !== 0) throw new Error(`FFmpeg falhou: ${result.stderr || result.stdout}`);
    const stat = await fsp.stat(outputFile);
    if (!stat.isFile() || stat.size <= 0) throw new Error("Renderização não produziu MP4.");
    return stat;
}

function processNextInQueue() {
    while (activeWorkers < CONCURRENT_JOBS_LIMIT && jobQueue.length) {
        const item = jobQueue.shift();
        activeWorkers++;
        runAnalysisWorker(item.jobId, item.payload)
            .catch(e => console.error(`[Worker] ${item.jobId}: ${e.message}`))
            .finally(() => { activeWorkers--; processNextInQueue(); });
    }
}

async function runAnalysisWorker(jobId, payload) {
    const job = jobs.get(jobId);
    if (!job) return;
    let workDir = null, aiToken = null;
    const user = users.get(job.userId);

    const setStage = (status, message, progress) => {
        job.status = status; job.stageMessage = message;
        job.progress = progress; job.updatedAt = now();
        console.log(`[Job ${jobId}] ${progress}% ${status}: ${message}`);
    };

    try {
        setStage("downloading", "Obtendo vídeo original...", 20);
        let sourceFile = "", duration = 0, title = "";

        if (payload.type === "youtube") {
            workDir = await fsp.mkdtemp(path.join(TEMP_ROOT, "job_yt_"));
            const dl = await downloadYouTubeVideo(payload.url, path.join(workDir, "source.%(ext)s"));
            sourceFile = dl.filePath; duration = dl.duration; title = dl.title;
        } else {
            sourceFile = payload.filePath; duration = payload.duration; title = payload.originalName;
            await validateVideoFile(sourceFile);
        }

        setStage("analyzing", "IA analisando os melhores momentos...", 60);
        aiToken = randomToken(32);
        aiVideoTokens.set(aiToken, { filePath: sourceFile, expiresAt: now() + 15 * 60 * 1000 });
        const proxy = `${PUBLIC_BASE_URL}/api/ai-video/${aiToken}`;
        const aiResult = await analyzeWithOpenRouterFallback(
            buildClipPrompt(duration) + `\nTítulo: ${title}`, proxy, duration
        );

        if (user && !user.vip && job.reservedPoints > 0) {
            user.reservedPoints = Math.max(0, (user.reservedPoints || 0) - job.reservedPoints);
            job.reservedPoints = 0;
        }

        job.status = "completed";
        job.stageMessage = "Análise concluída com sucesso.";
        job.progress = 100;
        job.updatedAt = now();
        job.result = {
            model: aiResult.model, clips: aiResult.clips, duration,
            type: payload.type, uploadId: payload.uploadId || null, url: payload.url || null
        };
        if (user) user.analyses = (user.analyses || 0) + 1;
        metrics.successfulAnalyses++;
        console.log(`[Worker] Job ${jobId} concluído.`);
    } catch (err) {
        console.error(`[Worker] Falha ${jobId}: ${err.message}`);
        job.status = "failed";
        job.stageMessage = `Falha no processamento: ${err.message}`;
        job.error = err.message;
        job.progress = 0;
        job.updatedAt = now();
        if (user && !user.vip && job.reservedPoints > 0) {
            user.points += job.reservedPoints;
            user.reservedPoints = Math.max(0, (user.reservedPoints || 0) - job.reservedPoints);
            job.reservedPoints = 0;
        }
        metrics.failedAnalyses++;
    } finally {
        if (aiToken) aiVideoTokens.delete(aiToken);
        if (workDir) await safeRemove(workDir);
    }
}

function enqueueJob(jobId, payload) {
    if (jobQueue.length >= MAX_QUEUE_LENGTH) throw new Error("Fila cheia. Tente novamente em alguns instantes.");
    jobQueue.push({ jobId, payload });
    processNextInQueue();
}

function ensureUser(requestedId) {
    const id = safeString(requestedId).trim() || randomId("user_");
    let user = users.get(id);
    if (!user) {
        user = { id, points: FREE_POINTS, reservedPoints: 0, vip: false, createdAt: now(),
            lastDailyClaim: now(), downloads: 0, analyses: 0 };
        users.set(id, user);
    }
    const today = new Date().toISOString().slice(0, 10);
    const previous = user.lastDailyClaim ? new Date(user.lastDailyClaim).toISOString().slice(0, 10) : "";
    if (today !== previous) { user.points += DAILY_POINTS; user.lastDailyClaim = now(); }
    return user;
}
function publicUser(user) {
    return {
        id: user.id, userId: user.id,
        points: Math.max(0, Math.floor(user.points)),
        reservedPoints: Math.max(0, Math.floor(user.reservedPoints || 0)),
        vip: Boolean(user.vip), isVip: Boolean(user.vip)
    };
}
function getBearerToken(req) {
    const h = safeString(req.headers.authorization);
    return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
}
function requireUser(req, res, next) {
    const token = getBearerToken(req);
    const session = token ? sessions.get(token) : null;
    const user = session && session.expiresAt > now() ? users.get(session.userId) : null;
    if (!user) return jsonError(res, 401, "Sessão inválida ou não autenticada.");
    req.user = user; next();
}
function requireAdmin(req, res, next) {
    const token = safeString(req.headers["x-admin-session"]).trim() || getBearerToken(req);
    const session = adminSessions.get(token);
    if (!session || session.expiresAt < now()) return jsonError(res, 401, "Sessão administrativa expirada ou inválida.");
    next();
}

app.post("/api/auth/login", (req, res) => {
    const user = ensureUser(req.body?.userId);
    const token = randomToken(48);
    sessions.set(token, { userId: user.id, expiresAt: now() + SESSION_TTL_MS });
    res.json({ ok: true, token, session: token, user: publicUser(user) });
});
app.get("/api/auth/me", requireUser, (req, res) => res.json({ ok: true, user: publicUser(req.user) }));

app.post("/api/upload", requireUser, uploadMiddleware.single("video"), async (req, res) => {
    try {
        if (!req.file) return jsonError(res, 400, "Nenhum vídeo enviado.");
        const metadata = await validateVideoFile(req.file.path);
        const uploadId = randomId("upload_");
        const item = {
            id: uploadId, userId: req.user.id, filePath: req.file.path,
            originalName: req.file.originalname, mimeType: req.file.mimetype,
            size: req.file.size, createdAt: now(), metadata
        };
        uploads.set(uploadId, item); metrics.uploads++;
        res.json({ ok: true, uploadId, duration: metadata.duration,
            file: { name: item.originalName, size: item.size } });
    } catch (err) {
        if (req.file?.path) await safeRemove(req.file.path);
        jsonError(res, 400, err.message);
    }
});

app.post("/api/analisar", requireUser, (req, res) => {
    metrics.analyses++;
    const { url, uploadId } = req.body || {};
    if (!req.user.vip && req.user.points < ANALYSIS_COST)
        return jsonError(res, 402, `Pontos insuficientes (Necessário: ${ANALYSIS_COST}, Disponível: ${req.user.points}).`);

    let payload;
    if (uploadId) {
        const up = uploads.get(uploadId);
        if (!up || up.userId !== req.user.id) return jsonError(res, 404, "Upload não encontrado.");
        payload = { type: "upload", uploadId, filePath: up.filePath, duration: up.metadata.duration, originalName: up.originalName };
    } else if (url) {
        const norm = normalizeYouTubeUrl(url);
        if (!norm) return jsonError(res, 400, "URL do YouTube inválida.");
        payload = { type: "youtube", url: norm };
    } else return jsonError(res, 400, "Informe url ou uploadId.");

    if (jobQueue.length >= MAX_QUEUE_LENGTH)
        return jsonError(res, 429, "Fila cheia. Tente novamente em alguns instantes.");

    let reserved = 0;
    if (!req.user.vip) {
        req.user.points -= ANALYSIS_COST;
        req.user.reservedPoints = (req.user.reservedPoints || 0) + ANALYSIS_COST;
        reserved = ANALYSIS_COST;
    }

    const jobId = randomId("job_");
    jobs.set(jobId, {
        id: jobId, userId: req.user.id, status: "queued",
        stageMessage: "Aguardando worker disponível na fila...", progress: 5,
        reservedPoints: reserved, createdAt: now(), updatedAt: now()
    });

    try { enqueueJob(jobId, payload); }
    catch (e) {
        if (reserved) {
            req.user.points += reserved;
            req.user.reservedPoints = Math.max(0, req.user.reservedPoints - reserved);
        }
        jobs.delete(jobId);
        return jsonError(res, 429, e.message);
    }

    res.status(202).json({ ok: true, jobId, status: "queued", user: publicUser(req.user) });
});

app.get("/api/jobs/:id", requireUser, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.userId !== req.user.id) return jsonError(res, 404, "Job não encontrado.");
    res.json({ ok: true, job });
});

app.post("/api/download", requireUser, async (req, res) => {
    let temporarySource = null, outputFile = null, reservedDownload = 0;
    try {
        const { start, duration, format = "9:16", uploadId, url } = req.body || {};
        const nStart = parseNumber(start, -1);
        let nDuration = parseNumber(duration, -1);

        if (!["9:16", "1:1", "16:9"].includes(format)) return jsonError(res, 400, "Formato inválido.");
        if (nStart < 0 || nDuration <= 0) return jsonError(res, 400, "Intervalo ou duração inválidos.");
        if (!req.user.vip && req.user.points < DOWNLOAD_COST)
            return jsonError(res, 402, `Pontos insuficientes para download (Necessário: ${DOWNLOAD_COST}).`);

        if (!req.user.vip) {
            req.user.points -= DOWNLOAD_COST;
            req.user.reservedPoints = (req.user.reservedPoints || 0) + DOWNLOAD_COST;
            reservedDownload = DOWNLOAD_COST;
        }

        let sourceFile, sourceDuration;
        if (uploadId) {
            const up = uploads.get(uploadId);
            if (!up || up.userId !== req.user.id) throw new Error("Upload não encontrado.");
            sourceFile = up.filePath; sourceDuration = up.metadata.duration;
        } else if (url) {
            const norm = normalizeYouTubeUrl(url);
            if (!norm) throw new Error("URL do YouTube inválida.");
            const workDir = await fsp.mkdtemp(path.join(TEMP_ROOT, "render_yt_"));
            const dl = await downloadYouTubeVideo(norm, path.join(workDir, "source.%(ext)s"));
            sourceFile = dl.filePath; sourceDuration = dl.duration; temporarySource = workDir;
        } else throw new Error("Informe uploadId ou url.");

        if (!sourceDuration) sourceDuration = (await getVideoMetadata(sourceFile)).duration;
        if (nStart >= sourceDuration) throw new Error("O início ultrapassa a duração do vídeo.");
        if (nStart + nDuration > sourceDuration) nDuration = sourceDuration - nStart;
        if (nDuration <= 0) throw new Error("Duração final inválida.");

        outputFile = path.join(OUTPUT_DIR, `${randomId("clip_")}.mp4`);
        const stat = await renderClip(sourceFile, outputFile, nStart, nDuration, format);

        if (reservedDownload) {
            req.user.reservedPoints = Math.max(0, req.user.reservedPoints - reservedDownload);
            reservedDownload = 0;
        }
        req.user.downloads++; metrics.downloads++;

        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Length", String(stat.size));
        res.setHeader("Content-Disposition", `attachment; filename="clipforge_${Date.now()}.mp4"`);

        const stream = fs.createReadStream(outputFile);
        let cleaned = false;
        const cleanup = async () => {
            if (cleaned) return;
            cleaned = true;
            await safeRemove(outputFile);
            await safeRemove(temporarySource);
        };
        stream.on("close", cleanup);
        stream.on("error", async () => {
            await cleanup();
            if (!res.headersSent) jsonError(res, 500, "Erro ao transmitir MP4.");
        });
        res.on("close", cleanup);
        stream.pipe(res);
    } catch (err) {
        if (reservedDownload) {
            req.user.points += reservedDownload;
            req.user.reservedPoints = Math.max(0, req.user.reservedPoints - reservedDownload);
        }
        await safeRemove(outputFile);
        await safeRemove(temporarySource);
        if (!res.headersSent) jsonError(res, 500, err.message || "Erro durante o processamento.");
    }
});

app.post("/api/pix/criar", requireUser, async (req, res) => {
    if (!MP_CONFIGURED) return jsonError(res, 503, "Mercado Pago não configurado.");
    try {
        const amount = Number(VIP_PRICE.toFixed(2));
        const reference = `clipforge_${req.user.id}_${crypto.randomUUID()}`;
        const email = process.env.MP_PAYER_EMAIL || `cliente-${req.user.id}@clipforge.local`;
        const payment = await criarPagamentoPix({
            amount, description: "ClipForge Pro VIP", email,
            externalReference: reference, notificationUrl: MP_WEBHOOK_URL || undefined
        });
        const id = String(payment.id);
        const tx = payment.point_of_interaction?.transaction_data || {};
        payments.set(id, { id, userId: req.user.id, amount, status: payment.status, createdAt: now(), externalReference: reference });
        metrics.pixCreated++;
        res.json({ ok: true, id, status: payment.status, qr_code: tx.qr_code || "",
            qr_code_base64: tx.qr_code_base64 || "", ticket_url: tx.ticket_url || "", amount });
    } catch (e) { metrics.errors++; jsonError(res, 502, e.message); }
});

app.get("/api/pix/status/:id", requireUser, async (req, res) => {
    try {
        const id = safeString(req.params.id).trim();
        const local = payments.get(id);
        if (!local || local.userId !== req.user.id) return jsonError(res, 403, "Pagamento não encontrado ou não pertence a este usuário.");
        const payment = await consultarPagamentoPix(id);
        local.status = payment.status;
        const approved = payment.status === "approved";
        if (approved && !req.user.vip) { req.user.vip = true; metrics.pixApproved++; }
        res.json({ ok: true, id, status: payment.status, approved, user: publicUser(req.user) });
    } catch (e) { metrics.errors++; jsonError(res, 502, e.message); }
});

app.post("/api/admin/login", (req, res) => {
    if (!ADMIN_PASSWORD) return jsonError(res, 503, "ADMIN_PASSWORD não configurada.");
    const email = safeString(req.body?.email).trim().toLowerCase();
    const password = safeString(req.body?.password);
    const validEmail = !ADMIN_EMAIL || email === ADMIN_EMAIL.trim().toLowerCase();
    if (!validEmail || password !== ADMIN_PASSWORD) return jsonError(res, 401, "Credenciais administrativas inválidas.");
    const token = randomToken(48);
    adminSessions.set(token, { createdAt: now(), expiresAt: now() + ADMIN_SESSION_TTL_MS });
    res.json({ ok: true, token, session: token });
});

app.get("/api/admin/dashboard", requireAdmin, (req, res) => {
    let vipUsers = 0, totalPoints = 0;
    for (const u of users.values()) { if (u.vip) vipUsers++; totalPoints += Math.max(0, u.points); }
    res.json({
        ok: true, version: VERSION,
        metrics: { ...metrics, users: users.size, vipUsers, totalPoints, jobsCount: jobs.size, queueLength: jobQueue.length },
        uptime: process.uptime()
    });
});

function parseRangeHeader(header, size) {
    if (!header) return null;
    if (!/^bytes=\d*-\d*$/.test(header)) return { invalid: true };
    const raw = header.slice(6);
    const [a, b] = raw.split("-");
    if (a === "" && b === "") return { invalid: true };
    let start, end;
    if (a === "") {
        const suffix = Number(b);
        if (!Number.isInteger(suffix) || suffix <= 0) return { invalid: true };
        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(a);
        end = b === "" ? size - 1 : Number(b);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size)
            return { invalid: true };
        end = Math.min(end, size - 1);
    }
    return { start, end };
}

async function serveAiVideo(req, res) {
    const entry = aiVideoTokens.get(req.params.token);
    if (!entry || entry.expiresAt < now() || !fs.existsSync(entry.filePath))
        return res.status(404).send("Vídeo temporário expirado ou indisponível.");

    try {
        const stat = await fsp.stat(entry.filePath);
        const size = stat.size;
        const range = parseRangeHeader(req.headers.range, size);
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Cache-Control", "no-store");

        if (range?.invalid) {
            res.setHeader("Content-Range", `bytes */${size}`);
            return res.status(416).end();
        }

        if (!range) {
            res.setHeader("Content-Length", String(size));
            return req.method === "HEAD" ? res.status(200).end() : fs.createReadStream(entry.filePath).pipe(res);
        }

        const length = range.end - range.start + 1;
        res.status(206);
        res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
        res.setHeader("Content-Length", String(length));
        if (req.method === "HEAD") return res.end();
        fs.createReadStream(entry.filePath, { start: range.start, end: range.end }).pipe(res);
    } catch (e) {
        console.error("[AI Proxy]", e.message);
        if (!res.headersSent) res.status(500).send("Erro ao ler arquivo de vídeo.");
    }
}
app.get("/api/ai-video/:token", serveAiVideo);
app.head("/api/ai-video/:token", serveAiVideo);

app.get("/health", async (req, res) => {
    const [ffmpeg, ffprobe, ytDlp] = await Promise.all([
        commandExists(FFMPEG_BIN, ["-version"]),
        commandExists(FFPROBE_BIN, ["-version"]),
        commandExists(YTDLP_BIN, ["--version"])
    ]);
    res.json({
        ok: true, status: "online", service: "clipforge-server", version: VERSION,
        models: { primary: OPENROUTER_MODEL, fallbacks: OPENROUTER_FALLBACK_MODELS },
        binaries: { ffmpeg, ffprobe, ytDlp },
        queue: { inQueue: jobQueue.length, activeWorkers, limit: CONCURRENT_JOBS_LIMIT },
        jobs: {
            total: jobs.size,
            queued: [...jobs.values()].filter(j => j.status === "queued").length,
            running: [...jobs.values()].filter(j => ["downloading", "analyzing"].includes(j.status)).length
        }
    });
});
app.get("/", (req, res) => res.json({ ok: true, service: "ClipForge Pro", version: VERSION, status: "online" }));

app.use((err, req, res, next) => {
    metrics.errors++;
    console.error("[HTTP ERROR]", err?.stack || err);
    if (res.headersSent) return next(err);
    if (err?.code === "LIMIT_FILE_SIZE")
        return jsonError(res, 413, `Arquivo excede o limite de ${MAX_UPLOAD_MB} MB.`);
    return jsonError(res, 500, err?.message || "Erro interno do servidor.");
});

setInterval(async () => {
    const cutoff = now() - UPLOAD_TTL_MS;
    for (const [id, up] of uploads) {
        if (up.createdAt < cutoff) { await safeRemove(up.filePath); uploads.delete(id); }
    }

    const current = now();
    for (const [token, s] of sessions) if (s.expiresAt < current) sessions.delete(token);
    for (const [token, s] of adminSessions) if (s.expiresAt < current) adminSessions.delete(token);
    for (const [token, v] of aiVideoTokens) if (v.expiresAt < current) aiVideoTokens.delete(token);

    // Não remove jobs ainda em execução.
    for (const [id, j] of jobs) {
        const terminal = ["completed", "failed"].includes(j.status);
        if (terminal && now() - j.createdAt > 3 * 3600 * 1000) jobs.delete(id);
    }
}, 15 * 60 * 1000).unref();

async function startServer() {
    try {
        await ensureDirectories();
        await resolveBinaries();
        app.listen(PORT, HOST, () => {
            console.log("====================================================");
            console.log(`🚀 CLIPFORGE PRO — BACKEND ${VERSION} ONLINE`);
            console.log(`🌐 http://${HOST}:${PORT}`);
            console.log(`🤖 Modelo Primário: ${OPENROUTER_MODEL}`);
            console.log(`📦 Fila máxima: ${MAX_QUEUE_LENGTH}`);
            console.log("====================================================");
        });
    } catch (err) {
        console.error("[Startup] FATAL ERROR:", err);
        process.exit(1);
    }
}
startServer();
