/**
 * ============================================================
 * CLIPFORGE PRO — BACKEND 13.3.1
 * ============================================================
 *
 * Node.js >= 20 + Express
 *
 * PIPELINE ATUAL:
 * 1. Resolução local de binários (FFmpeg via ffmpeg-static e yt-dlp em ./bin)
 * 2. Upload de MP4 com streaming direto para Gemini Files API
 * 3. Polling de status até ACTIVE com captura de erros HTTP
 * 4. Inferência via Interactions API com Exponential Backoff + Jitter
 * 5. Detecção de quota dura (429 / quota_exceeded)
 * 6. Corte de vídeo pontual com FFmpeg nativo e download em stream
 * 7. Integração PIX Mercado Pago e Autenticação por sessão
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

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";
const VERSION = "13.3.1";

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

const TEMP_ROOT = process.env.TEMP_DIR || path.join(os.tmpdir(), "clipforge");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(TEMP_ROOT, "uploads");
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(TEMP_ROOT, "outputs");

const GEMINI_API_KEY =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    "";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

const GEMINI_FALLBACK_MODELS = (
    process.env.GEMINI_FALLBACK_MODELS ||
    "gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash"
)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const GEMINI_MODELS = [
    GEMINI_MODEL,
    ...GEMINI_FALLBACK_MODELS.filter((model) => model !== GEMINI_MODEL)
];

const GEMINI_INTERACTIONS_URL =
    process.env.GEMINI_INTERACTIONS_URL ||
    "https://generativelanguage.googleapis.com/v1beta/interactions";

const GEMINI_FILES_UPLOAD_URL =
    process.env.GEMINI_FILES_UPLOAD_URL ||
    "https://generativelanguage.googleapis.com/upload/v1beta/files";

const GEMINI_FILES_API_URL =
    process.env.GEMINI_FILES_API_URL ||
    "https://generativelanguage.googleapis.com/v1beta/files";

const MP_ACCESS_TOKEN =
    process.env.MP_ACCESS_TOKEN ||
    process.env.MERCADO_PAGO_ACCESS_TOKEN ||
    "";

const MP_WEBHOOK_URL =
    process.env.MP_WEBHOOK_URL ||
    process.env.MERCADO_PAGO_WEBHOOK_URL ||
    "";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@clipforge.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const YTDLP_COOKIES_FILE =
    process.env.YTDLP_COOKIES_FILE ||
    process.env.YOUTUBE_COOKIES_FILE ||
    "";

let FFMPEG_BIN = "ffmpeg";
let FFPROBE_BIN = "ffprobe";
let YTDLP_BIN = path.join(__dirname, "bin", "yt-dlp");

const users = new Map();
const sessions = new Map();
const adminSessions = new Map();
const uploads = new Map();
const payments = new Map();

const metrics = {
    startedAt: Date.now(),
    requests: 0,
    uploads: 0,
    analyses: 0,
    successfulAnalyses: 0,
    failedAnalyses: 0,
    downloads: 0,
    pixCreated: 0,
    pixApproved: 0,
    geminiRetries: 0,
    geminiFallbacks: 0,
    errors: 0
};

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(
    cors({
        origin: true,
        credentials: false,
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: [
            "Content-Type",
            "Authorization",
            "X-User-Id",
            "X-Admin-Session"
        ]
    })
);

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));

app.use((req, res, next) => {
    metrics.requests++;
    res.setHeader("X-ClipForge-Version", VERSION);
    next();
});

function now() { return Date.now(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString("hex"); }
function randomId(prefix = "") { return prefix + crypto.randomUUID(); }

function safeString(value, fallback = "") {
    if (value === null || value === undefined) return fallback;
    return String(value);
}

function parseNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function jsonError(res, status, message, extra = {}) {
    return res.status(status).json({
        ok: false,
        error: message,
        ...extra
    });
}

async function safeRemove(filePath) {
    if (!filePath) return;
    try {
        await fsp.rm(filePath, { recursive: true, force: true });
    } catch (_) {}
}

async function ensureDirectories() {
    await fsp.mkdir(TEMP_ROOT, { recursive: true });
    await fsp.mkdir(UPLOAD_DIR, { recursive: true });
    await fsp.mkdir(OUTPUT_DIR, { recursive: true });
}

function spawnCapture(command, args = [], options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true, ...options });
        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
            if (stdout.length > 150000) stdout = stdout.slice(-150000);
        });

        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
            if (stderr.length > 250000) stderr = stderr.slice(-250000);
        });

        child.on("error", reject);
        child.on("close", (code, signal) => {
            resolve({ code, signal, stdout, stderr });
        });
    });
}

async function commandExists(command, args = ["--version"]) {
    try {
        const result = await spawnCapture(command, args);
        return result.code === 0;
    } catch (_) {
        return false;
    }
}

async function resolveBinaries() {
    const ffmpegCandidates = [
        process.env.FFMPEG_PATH,
        process.env.FFMPEG_BIN,
        path.join(__dirname, "bin", "ffmpeg")
    ];

    try {
        const staticFfmpeg = require("ffmpeg-static");
        if (staticFfmpeg) ffmpegCandidates.unshift(staticFfmpeg);
    } catch (_) {}

    try {
        const installerFfmpeg = require("@ffmpeg-installer/ffmpeg");
        if (installerFfmpeg?.path) ffmpegCandidates.push(installerFfmpeg.path);
    } catch (_) {}

    ffmpegCandidates.push("ffmpeg");

    for (const cand of ffmpegCandidates) {
        if (!cand) continue;
        if (fs.existsSync(cand)) {
            try { fs.chmodSync(cand, 0o755); } catch (_) {}
        }
        if (await commandExists(cand, ["-version"])) {
            FFMPEG_BIN = cand;
            break;
        }
    }

    const ffprobeCandidates = [
        process.env.FFPROBE_PATH,
        process.env.FFPROBE_BIN,
        path.join(__dirname, "bin", "ffprobe")
    ];

    try {
        const installerFfprobe = require("@ffprobe-installer/ffprobe");
        if (installerFfprobe?.path) ffprobeCandidates.unshift(installerFfprobe.path);
    } catch (_) {}

    ffprobeCandidates.push("ffprobe");

    for (const cand of ffprobeCandidates) {
        if (!cand) continue;
        if (fs.existsSync(cand)) {
            try { fs.chmodSync(cand, 0o755); } catch (_) {}
        }
        if (await commandExists(cand, ["-version"])) {
            FFPROBE_BIN = cand;
            break;
        }
    }

    const localYtDlp = path.join(__dirname, "bin", "yt-dlp");
    const ytdlpCandidates = [
        localYtDlp,
        process.env.YTDLP_BIN,
        process.env.YTDLP_PATH,
        path.join(process.cwd(), "bin", "yt-dlp"),
        "yt-dlp"
    ];

    for (const cand of ytdlpCandidates) {
        if (!cand) continue;
        if (fs.existsSync(cand)) {
            try { fs.chmodSync(cand, 0o755); } catch (_) {}
        }
        if (await commandExists(cand, ["--version"])) {
            YTDLP_BIN = cand;
            break;
        }
    }

    const ffmpegOk = await commandExists(FFMPEG_BIN, ["-version"]);
    const ffprobeOk = await commandExists(FFPROBE_BIN, ["-version"]);
    const ytdlpOk = await commandExists(YTDLP_BIN, ["--version"]);

    console.log(`[Binaries] FFmpeg: ${ffmpegOk ? FFMPEG_BIN : "AUSENTE"}`);
    console.log(`[Binaries] FFprobe: ${ffprobeOk ? FFPROBE_BIN : "AUSENTE"}`);
    console.log(`[Binaries] yt-dlp: ${ytdlpOk ? YTDLP_BIN : "AUSENTE"}`);
}

async function getVideoMetadata(filePath) {
    if (!FFPROBE_BIN) throw new Error("FFprobe não está disponível.");

    const result = await spawnCapture(FFPROBE_BIN, [
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        filePath
    ]);

    if (result.code !== 0) throw new Error(`FFprobe falhou: ${result.stderr || result.stdout}`);

    let data;
    try {
        data = JSON.parse(result.stdout);
    } catch (_) {
        throw new Error("FFprobe retornou JSON inválido.");
    }

    const format = data.format || {};
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const videoStream = streams.find((stream) => stream.codec_type === "video") || null;
    const audioStream = streams.find((stream) => stream.codec_type === "audio") || null;

    return {
        duration: parseNumber(format.duration, 0),
        size: parseNumber(format.size, 0),
        format: format.format_name || null,
        width: parseNumber(videoStream?.width, 0),
        height: parseNumber(videoStream?.height, 0),
        videoCodec: videoStream?.codec_name || null,
        audioCodec: audioStream?.codec_name || null,
        fps: videoStream?.r_frame_rate || null
    };
}

async function validateVideoFile(filePath) {
    if (!filePath) throw new Error("Arquivo de vídeo não informado.");
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("O caminho informado não é um arquivo.");
    if (stat.size <= 10000) throw new Error("O arquivo de vídeo está vazio ou inválido.");
    if (stat.size > MAX_UPLOAD_BYTES) {
        throw new Error(`O vídeo excede o limite de ${MAX_UPLOAD_MB} MB.`);
    }

    const metadata = await getVideoMetadata(filePath);
    if (!metadata.duration || metadata.duration <= 0) {
        throw new Error("Não foi possível obter a duração do vídeo.");
    }

    return metadata;
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOAD_DIR);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname || "").toLowerCase() || ".mp4";
        cb(null, `${randomId("upload_")}${ext}`);
    }
});

const uploadMiddleware = multer({
    storage,
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: function (req, file, cb) {
        const mime = safeString(file.mimetype).toLowerCase();
        const name = safeString(file.originalname).toLowerCase();
        const validMime = mime.startsWith("video/");
        const validExtension = /\.(mp4|mov|mkv|webm|avi)$/i.test(name);

        if (!validMime && !validExtension) {
            return cb(new Error("Formato de vídeo não suportado."));
        }
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
            const index = parts.findIndex((part) => ["shorts", "embed", "live"].includes(part));
            if (index >= 0 && parts[index + 1]) {
                const id = parts[index + 1];
                if (/^[A-Za-z0-9_-]{11}$/.test(id)) return id;
            }
        }
    } catch (_) {}
    return null;
}

function normalizeYouTubeUrl(value) {
    const id = getYouTubeId(value);
    return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

async function getYouTubeInfo(url) {
    const args = ["--no-playlist", "--skip-download", "--dump-single-json", "--no-warnings", url];
    if (YTDLP_COOKIES_FILE) args.splice(2, 0, "--cookies", YTDLP_COOKIES_FILE);

    const result = await spawnCapture(YTDLP_BIN, args);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "yt-dlp falhou nos metadados.");

    try {
        return JSON.parse(result.stdout);
    } catch (_) {
        throw new Error("yt-dlp retornou dados inválidos.");
    }
}

async function downloadYouTubeVideo(url, outputTemplate) {
    const args = [
        "--no-playlist", "--no-warnings", "--no-mtime", "--restrict-filenames",
        "-f", "bv*+ba/b",
        "--merge-output-format", "mp4",
        "-o", outputTemplate,
        url
    ];

    if (YTDLP_COOKIES_FILE) args.splice(2, 0, "--cookies", YTDLP_COOKIES_FILE);

    const result = await spawnCapture(YTDLP_BIN, args);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "yt-dlp falhou no download.");

    const directory = path.dirname(outputTemplate);
    const files = await fsp.readdir(directory);
    const candidates = [];

    for (const filename of files) {
        if (!/^source\./i.test(filename)) continue;
        const fullPath = path.join(directory, filename);
        try {
            const stat = await fsp.stat(fullPath);
            if (stat.isFile() && stat.size > 0) candidates.push(fullPath);
        } catch (_) {}
    }

    if (!candidates.length) throw new Error("yt-dlp terminou sem produzir o arquivo de vídeo.");
    return candidates[0];
}

function ensureUser(requestedId) {
    let userId = safeString(requestedId).trim();
    if (!userId) userId = randomId("user_");

    let user = users.get(userId);
    if (!user) {
        user = {
            id: userId,
            points: FREE_POINTS,
            vip: false,
            createdAt: now(),
            lastDailyClaim: now(),
            downloads: 0,
            analyses: 0
        };
        users.set(userId, user);
    }

    claimDailyPoints(user);
    return user;
}

function claimDailyPoints(user) {
    if (!user) return 0;
    const today = new Date().toISOString().slice(0, 10);
    const previous = user.lastDailyClaim
        ? new Date(user.lastDailyClaim).toISOString().slice(0, 10)
        : "";

    if (today !== previous) {
        user.points += DAILY_POINTS;
        user.lastDailyClaim = now();
        return DAILY_POINTS;
    }
    return 0;
}

function publicUser(user) {
    return {
        id: user.id,
        userId: user.id,
        pontos: Math.max(0, Math.floor(user.points)),
        points: Math.max(0, Math.floor(user.points)),
        isVip: Boolean(user.vip),
        vip: Boolean(user.vip)
    };
}

function getBearerToken(req) {
    const header = safeString(req.headers.authorization);
    if (header.toLowerCase().startsWith("bearer ")) {
        return header.slice(7).trim();
    }
    return "";
}

function createUserSession(user) {
    const token = randomToken(48);
    sessions.set(token, {
        userId: user.id,
        createdAt: now(),
        expiresAt: now() + SESSION_TTL_MS
    });
    return token;
}

function getAuthenticatedUser(req) {
    const token = getBearerToken(req);
    if (token) {
        const session = sessions.get(token);
        if (session && session.expiresAt > now()) {
            return users.get(session.userId) || null;
        }
        if (session) sessions.delete(token);
    }

    const headerUser = safeString(req.headers["x-user-id"]).trim();
    if (headerUser) {
        return users.get(headerUser) || null;
    }

    return null;
}

function requireUser(req, res, next) {
    const user = getAuthenticatedUser(req);
    if (!user) return jsonError(res, 401, "Usuário não autenticado.");
    claimDailyPoints(user);
    req.user = user;
    next();
}

function getOwnedUpload(user, uploadId) {
    const upload = uploads.get(uploadId);
    if (!upload || upload.userId !== user.id) return null;
    return upload;
}

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
                    score: { type: "number" }
                },
                required: ["start", "end", "duration", "title", "description", "score"]
            }
        }
    },
    required: ["clips"]
};

function normalizeGeminiClips(value, videoDuration = null) {
    let rawClips = [];
    if (Array.isArray(value)) rawClips = value;
    else if (Array.isArray(value?.clips)) rawClips = value.clips;
    else if (Array.isArray(value?.cortes)) rawClips = value.cortes;
    else if (Array.isArray(value?.results)) rawClips = value.results;

    const result = [];
    for (const item of rawClips) {
        if (!item) continue;
        let start = parseNumber(item.start ?? item.inicio ?? item.startTime, NaN);
        let end = parseNumber(item.end ?? item.fim ?? item.endTime, NaN);
        let duration = parseNumber(item.duration ?? item.duracao, NaN);

        if (!Number.isFinite(start)) start = 0;
        start = Math.max(0, start);

        if (!Number.isFinite(duration) || duration <= 0) {
            duration = (Number.isFinite(end) && end > start) ? (end - start) : 30;
        }

        duration = clamp(duration, 1, 90);
        end = start + duration;

        if (Number.isFinite(videoDuration) && videoDuration > 0) {
            if (start >= videoDuration) continue;
            end = Math.min(end, videoDuration);
            duration = Math.max(1, end - start);
        }

        let score = parseNumber(item.score ?? item.rating ?? item.pontuacao, 0);
        score = clamp(score, 0, 100);

        const title = safeString(item.title ?? item.titulo, "Corte recomendado").trim();
        const description = safeString(item.description ?? item.descricao ?? item.reason ?? item.motivo, "").trim();

        result.push({
            start: Number(start.toFixed(3)),
            end: Number(end.toFixed(3)),
            duration: Number(duration.toFixed(3)),
            title: title || "Corte recomendado",
            description,
            score: Number(score.toFixed(1))
        });
    }

    return result.slice(0, MAX_CLIPS);
}

function parseGeminiOutput(data) {
    if (!data) throw new Error("Resposta vazia do Gemini.");

    let primaryText = data.output_text || data.outputText || "";

    if (!primaryText && Array.isArray(data.steps)) {
        for (const step of data.steps) {
            if (step?.type === "model_output" || Array.isArray(step?.content)) {
                const contents = Array.isArray(step.content) ? step.content : [];
                for (const c of contents) {
                    if (c?.type === "text" && c.text) {
                        primaryText += c.text + "\n";
                    } else if (c?.text) {
                        primaryText += c.text + "\n";
                    }
                }
            }
        }
    }

    const possible = [
        primaryText,
        data.output,
        data.response,
        data.result,
        data.text,
        data.content,
        data
    ];

    function inspect(value) {
        if (value === null || value === undefined) return null;
        if (typeof value === "object") {
            if (Array.isArray(value.clips) || Array.isArray(value.cortes) || Array.isArray(value.results)) {
                return value;
            }
            if (typeof value.text === "string") return inspect(value.text);
            if (Array.isArray(value)) {
                for (const item of value) {
                    const found = inspect(item);
                    if (found) return found;
                }
            }
        }
        if (typeof value === "string") {
            let text = value.trim()
                .replace(/^```json/i, "")
                .replace(/^```/i, "")
                .replace(/```$/i, "")
                .trim();

            try { return JSON.parse(text); } catch (_) {}

            const firstBrace = text.indexOf("{");
            const lastBrace = text.lastIndexOf("}");
            if (firstBrace >= 0 && lastBrace > firstBrace) {
                try { return JSON.parse(text.slice(firstBrace, lastBrace + 1)); } catch (_) {}
            }

            const firstBracket = text.indexOf("[");
            const lastBracket = text.lastIndexOf("]");
            if (firstBracket >= 0 && lastBracket > firstBracket) {
                try { return JSON.parse(text.slice(firstBracket, lastBracket + 1)); } catch (_) {}
            }
        }
        return null;
    }

    for (const candidate of possible) {
        const parsed = inspect(candidate);
        if (parsed) return parsed;
    }

    throw new Error("Não foi possível interpretar a resposta do Gemini.");
}

function buildClipPrompt(videoDuration) {
    const durationText = Number.isFinite(videoDuration)
        ? `${videoDuration.toFixed(1)} segundos`
        : "desconhecida";

    return `
Você é um editor profissional de vídeos verticais para redes sociais.
Analise o vídeo integralmente e selecione os melhores momentos para cortes verticais (Shorts, TikTok, Reels).

Duração do vídeo: ${durationText}

Regras:
1. Encontre momentos de alto engajamento, falas de impacto, ganchos ou narrativas completas.
2. Evite silêncios e introduções vazias.
3. Cortes entre 20 e 60 segundos com início e fim naturais.
4. Selecione até ${MAX_CLIPS} trechos sem inventar timestamps.
5. Retorne SOMENTE JSON compatível com o schema definido.
`.trim();
}

function normalizeGeminiFileId(name) {
    let value = safeString(name).trim().replace(/^\/+/, "");
    if (value.startsWith("files/")) {
        value = value.slice("files/".length);
    }
    const parts = value.split("/");
    return parts[parts.length - 1] || "";
}

async function uploadVideoToGemini(filePath) {
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY não configurada.");
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("Arquivo do Gemini não é válido.");

    console.log(`[Gemini Files] Preparando upload: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);

    const initResponse = await fetch(GEMINI_FILES_UPLOAD_URL, {
        method: "POST",
        headers: {
            "x-goog-api-key": GEMINI_API_KEY,
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": String(stat.size),
            "X-Goog-Upload-Header-Content-Type": "video/mp4",
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            file: { display_name: path.basename(filePath) }
        }),
        signal: AbortSignal.timeout(120000)
    });

    if (!initResponse.ok) {
        const text = await initResponse.text();
        throw new Error(`Gemini Files init HTTP ${initResponse.status}: ${text.slice(0, 3000)}`);
    }

    const uploadUrl = initResponse.headers.get("x-goog-upload-url") ||
                      initResponse.headers.get("X-Goog-Upload-URL");

    if (!uploadUrl) throw new Error("Gemini não retornou a URL resumable de upload.");

    console.log("[Gemini Files] URL resumable recebida.");

    const fileStream = fs.createReadStream(filePath);
    let uploadResponse;

    try {
        uploadResponse = await fetch(uploadUrl, {
            method: "POST",
            headers: {
                "Content-Length": String(stat.size),
                "X-Goog-Upload-Offset": "0",
                "X-Goog-Upload-Command": "upload, finalize",
                "Content-Type": "video/mp4"
            },
            body: fileStream,
            duplex: "half",
            signal: AbortSignal.timeout(15 * 60 * 1000)
        });
    } catch (error) {
        fileStream.destroy();
        throw error;
    }

    if (!uploadResponse.ok) {
        const text = await uploadResponse.text();
        throw new Error(`Gemini Files upload HTTP ${uploadResponse.status}: ${text.slice(0, 3000)}`);
    }

    let uploadData;
    try {
        uploadData = await uploadResponse.json();
    } catch (_) {
        throw new Error("Gemini Files retornou JSON inválido após o upload.");
    }

    const file = uploadData?.file || uploadData;
    const fileUri = file?.uri;
    const fileName = file?.name;

    if (!fileUri) {
        throw new Error(`Gemini não retornou file.uri. Resposta: ${JSON.stringify(uploadData).slice(0, 3000)}`);
    }

    console.log("[Gemini Files] Upload concluído.");
    console.log("[Gemini Files] URI:", fileUri);
    console.log("[Gemini Files] Name:", fileName || "(não informado)");

    const fileId = normalizeGeminiFileId(fileName || fileUri);
    if (!fileId) throw new Error("Não foi possível determinar o ID do arquivo Gemini.");

    const statusUrl = `${GEMINI_FILES_API_URL}/${encodeURIComponent(fileId)}`;
    console.log("[Gemini Files] Polling:", statusUrl);

    const pollingStarted = now();
    const pollingTimeout = 10 * 60 * 1000;
    let activeFile = null;

    while (now() - pollingStarted < pollingTimeout) {
        await sleep(5000);

        const checkResponse = await fetch(statusUrl, {
            method: "GET",
            headers: {
                "x-goog-api-key": GEMINI_API_KEY,
                "Accept": "application/json"
            },
            signal: AbortSignal.timeout(60000)
        });

        if (!checkResponse.ok) {
            const text = await checkResponse.text();
            let detail = text;
            try {
                const parsed = JSON.parse(text);
                detail = parsed?.error?.message || parsed?.message || text;
            } catch (_) {}

            throw new Error(`Gemini Files polling HTTP ${checkResponse.status}: ${safeString(detail).slice(0, 3000)}`);
        }

        let checkData;
        try {
            checkData = await checkResponse.json();
        } catch (_) {
            throw new Error("Gemini Files polling retornou JSON inválido.");
        }

        const currentFile = checkData?.file || checkData;
        const state = safeString(currentFile?.state).toUpperCase();
        const elapsed = Math.round((now() - pollingStarted) / 1000);

        console.log(`[Gemini Files] Estado: ${state || "DESCONHECIDO"} | ${elapsed}s`);

        if (state === "ACTIVE") {
            activeFile = currentFile;
            break;
        }

        if (state === "FAILED") {
            const reason = currentFile?.error?.message ||
                           checkData?.error?.message ||
                           currentFile?.error ||
                           checkData?.error ||
                           "Gemini Files informou FAILED.";

            throw new Error(`Gemini Files FAILED: ${safeString(reason)}`);
        }
    }

    if (!activeFile) {
        throw new Error("Tempo limite de 10 minutos excedido aguardando o Gemini processar o vídeo.");
    }

    const activeUri = activeFile?.uri || fileUri;
    const activeName = activeFile?.name || fileName || `files/${fileId}`;

    console.log("[Gemini Files] Vídeo ACTIVE.");

    return {
        uri: activeUri,
        name: activeName,
        fileId
    };
}

async function requestGeminiInteraction(model, input) {
    if (!GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY não configurada.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    try {
        const body = {
            model,
            input,
            generation_config: {
                thinking_level: "low"
            },
            response_format: [
                {
                    type: "text",
                    mime_type: "application/json",
                    schema: CLIPS_SCHEMA
                }
            ]
        };

        const response = await fetch(GEMINI_INTERACTIONS_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": GEMINI_API_KEY
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        const text = await response.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (_) {
            data = { raw: text };
        }

        if (!response.ok) {
            const err = new Error(
                data?.error?.message ||
                data?.message ||
                `Gemini Interactions HTTP ${response.status}: ${text.slice(0, 1000)}`
            );
            err.status = response.status;
            err.code = data?.error?.code || "";
            throw err;
        }

        return data;
    } finally {
        clearTimeout(timeout);
    }
}

async function executeModelWithRetry(model, input, maxRetries = 2) {
    let attempt = 0;

    while (attempt <= maxRetries) {
        try {
            if (attempt > 0) {
                console.log(`[Gemini] Tentando novamente ${model} (tentativa ${attempt + 1}/${maxRetries + 1})...`);
            }
            return await requestGeminiInteraction(model, input);
        } catch (error) {
            const status = error.status || 0;
            const message = String(error.message || "").toLowerCase();

            const isHardQuota =
                status === 429 &&
                (
                    message.includes("exceeded a quota") ||
                    String(error.code || "").toLowerCase() === "quota_exceeded"
                );

            if (isHardQuota) {
                console.error(
                    `[Gemini Quota] Quota dura do projeto esgotada em ${model}. ` +
                    `Interrompendo retries imediatos.`
                );
                error.isFatalQuota = true;
                throw error;
            }

            const isTransient = [503, 502, 504, 500, 408, 429].includes(status);

            if (isTransient && attempt < maxRetries) {
                attempt++;
                metrics.geminiRetries++;

                const baseDelay = Math.pow(2, attempt) * 1000;
                const jitter = Math.floor(Math.random() * 700) + 100;
                const delayMs = baseDelay + jitter;

                console.warn(
                    `[Gemini Retry] ${model} retornou HTTP ${status} (${error.message.slice(0, 80)}...). ` +
                    `Aguardando ${(delayMs / 1000).toFixed(2)}s com backoff + jitter...`
                );

                await sleep(delayMs);
                continue;
            }

            throw error;
        }
    }
}

async function analyzeWithGeminiFallback({ input, videoDuration }) {
    if (!GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY não configurada no Render.");
    }

    const errors = [];
    let onlyTransientErrors = true;

    for (let i = 0; i < GEMINI_MODELS.length; i++) {
        const model = GEMINI_MODELS[i];

        try {
            console.log(`[Gemini] Tentando modelo: ${model}`);

            const response = await executeModelWithRetry(model, input, 2);
            const parsed = parseGeminiOutput(response);
            const clips = normalizeGeminiClips(parsed, videoDuration);

            if (!clips.length) {
                throw new Error("Gemini não retornou cortes válidos.");
            }

            console.log(`[Gemini] Interação concluída com sucesso: ${model} retornou ${clips.length} cortes.`);

            return {
                model,
                clips,
                raw: response
            };
        } catch (error) {
            console.error(`[Gemini] ${model} falhou definitivamente:`, error.message);
            errors.push(`${model}: ${error.message}`);

            if (error.status !== 503 && error.status !== 504) {
                onlyTransientErrors = false;
            }

            if (error.isFatalQuota) {
                console.error(`[Gemini Quota] Interrompendo cascata: limite de quota do projeto excedido.`);
                throw new Error(
                    "O projeto atingiu o limite de quota da API Gemini. Aguarde a renovação diária/por minuto ou verifique os limites no console do Google AI."
                );
            }

            if (i < GEMINI_MODELS.length - 1) {
                metrics.geminiFallbacks++;
                const fallbackCooldown = 1500 + Math.floor(Math.random() * 800);
                console.log(`[Gemini Fallback] Transição para próximo modelo em ${(fallbackCooldown / 1000).toFixed(2)}s...`);
                await sleep(fallbackCooldown);
            }
        }
    }

    if (onlyTransientErrors && errors.length > 0) {
        throw new Error(
            "O serviço de IA do Google está temporariamente sobrecarregado (503/504). Tente novamente em alguns minutos."
        );
    }

    throw new Error(`Todos os modelos Gemini falharam.\n${errors.join("\n")}`);
}

async function analyzeYouTube(url) {
    let duration = null;

    try {
        const info = await getYouTubeInfo(url);
        duration = parseNumber(info?.duration, null);
        console.log("[YouTube] Título:", info?.title || "(sem título)");
        console.log("[YouTube] Duração:", duration || "desconhecida");
    } catch (error) {
        console.warn("[YouTube] Não foi possível obter metadados:", error.message);
    }

    const prompt = buildClipPrompt(duration);
    const input = [
        { type: "text", text: prompt },
        { type: "video", uri: url }
    ];

    return analyzeWithGeminiFallback({ input, videoDuration: duration });
}

async function analyzeUpload(upload) {
    if (!upload) throw new Error("Upload não encontrado.");
    if (!upload.filePath) throw new Error("Arquivo do upload não está disponível.");

    const metadata = upload.metadata || await validateVideoFile(upload.filePath);
    upload.metadata = metadata;

    if (!upload.geminiFile) {
        console.log("[Gemini] Enviando MP4 para Gemini Files...");
        upload.geminiFile = await uploadVideoToGemini(upload.filePath);
    } else {
        console.log("[Gemini] Reutilizando Gemini File existente.");
    }

    const prompt = buildClipPrompt(metadata.duration);
    const input = [
        { type: "text", text: prompt },
        {
            type: "video",
            uri: upload.geminiFile.uri,
            mime_type: "video/mp4"
        }
    ];

    return analyzeWithGeminiFallback({ input, videoDuration: metadata.duration });
}

function chargeAnalysis(user) {
    if (user.vip) return 0;
    if (user.points < ANALYSIS_COST) {
        throw new Error(`Pontos insuficientes. Necessário: ${ANALYSIS_COST}. Disponível: ${user.points}.`);
    }
    user.points -= ANALYSIS_COST;
    return ANALYSIS_COST;
}

app.post("/api/auth/login", async (req, res) => {
    try {
        const requestedId = safeString(req.body?.userId).trim();
        const user = ensureUser(requestedId);
        const token = createUserSession(user);

        return res.json({
            ok: true,
            token,
            session: token,
            user: publicUser(user)
        });
    } catch (error) {
        metrics.errors++;
        return jsonError(res, 500, error.message);
    }
});

app.get("/api/auth/me", requireUser, (req, res) => {
    claimDailyPoints(req.user);
    return res.json({
        ok: true,
        user: publicUser(req.user)
    });
});

app.post("/api/upload", requireUser, uploadMiddleware.single("video"), async (req, res) => {
    try {
        if (!req.file) return jsonError(res, 400, "Nenhum vídeo foi enviado.");

        console.log(`[Upload] ${req.file.originalname} — ${(req.file.size / 1024 / 1024).toFixed(2)} MB`);
        const metadata = await validateVideoFile(req.file.path);
        const uploadId = randomId("upload_");

        const item = {
            id: uploadId,
            userId: req.user.id,
            filePath: req.file.path,
            originalName: req.file.originalname,
            mimeType: req.file.mimetype,
            size: req.file.size,
            createdAt: now(),
            metadata,
            geminiFile: null
        };

        uploads.set(uploadId, item);
        metrics.uploads++;

        return res.json({
            ok: true,
            uploadId,
            id: uploadId,
            duration: metadata.duration,
            file: {
                id: uploadId,
                name: item.originalName,
                size: item.size,
                mimeType: item.mimeType
            },
            metadata
        });
    } catch (error) {
        metrics.errors++;
        if (req.file?.path) await safeRemove(req.file.path);
        console.error("[Upload] ERRO:", error.message);
        return jsonError(res, 400, error.message);
    }
});

app.get("/api/upload/:id", requireUser, async (req, res) => {
    try {
        const upload = getOwnedUpload(req.user, req.params.id);
        if (!upload) return jsonError(res, 404, "Upload não encontrado.");

        return res.json({
            ok: true,
            upload: {
                id: upload.id,
                originalName: upload.originalName,
                size: upload.size,
                mimeType: upload.mimeType,
                createdAt: upload.createdAt,
                duration: upload.metadata?.duration || null,
                metadata: upload.metadata || null
            }
        });
    } catch (error) {
        return jsonError(res, 500, error.message);
    }
});

app.post("/api/analisar", requireUser, async (req, res) => {
    metrics.analyses++;
    try {
        const { url, uploadId } = req.body || {};

        if (uploadId) {
            const upload = getOwnedUpload(req.user, uploadId);
            if (!upload) {
                metrics.failedAnalyses++;
                return jsonError(res, 404, "Upload não encontrado.");
            }

            let charged = 0;
            try {
                charged = chargeAnalysis(req.user);
                const result = await analyzeUpload(upload);
                metrics.successfulAnalyses++;
                req.user.analyses++;

                return res.json({
                    ok: true,
                    type: "upload",
                    uploadId,
                    clips: result.clips,
                    model: result.model,
                    fallback: result.model !== GEMINI_MODEL,
                    user: publicUser(req.user),
                    charged,
                    version: VERSION
                });
            } catch (error) {
                if (charged > 0) req.user.points += charged;
                throw error;
            }
        }

        if (url) {
            const normalized = normalizeYouTubeUrl(url);
            if (!normalized) {
                metrics.failedAnalyses++;
                return jsonError(res, 400, "URL do YouTube inválida.");
            }

            let charged = 0;
            try {
                charged = chargeAnalysis(req.user);
                const result = await analyzeYouTube(normalized);
                metrics.successfulAnalyses++;
                req.user.analyses++;

                return res.json({
                    ok: true,
                    type: "youtube",
                    url: normalized,
                    clips: result.clips,
                    model: result.model,
                    fallback: result.model !== GEMINI_MODEL,
                    user: publicUser(req.user),
                    charged,
                    version: VERSION
                });
            } catch (error) {
                if (charged > 0) req.user.points += charged;
                throw error;
            }
        }

        return jsonError(res, 400, "Envie url ou uploadId.");
    } catch (error) {
        metrics.failedAnalyses++;
        metrics.errors++;
        console.error("[Análise] ERRO:", error.message);
        return jsonError(res, 500, error.message || "Não foi possível analisar o vídeo.");
    }
});

app.post("/api/analisar-upload", requireUser, async (req, res) => {
    metrics.analyses++;
    try {
        const uploadId = safeString(req.body?.uploadId).trim();
        if (!uploadId) return jsonError(res, 400, "uploadId é obrigatório.");

        const upload = getOwnedUpload(req.user, uploadId);
        if (!upload) return jsonError(res, 404, "Upload não encontrado.");

        let charged = 0;
        try {
            charged = chargeAnalysis(req.user);
            const result = await analyzeUpload(upload);
            metrics.successfulAnalyses++;
            req.user.analyses++;

            return res.json({
                ok: true,
                type: "upload",
                uploadId,
                clips: result.clips,
                model: result.model,
                fallback: result.model !== GEMINI_MODEL,
                user: publicUser(req.user),
                charged,
                version: VERSION
            });
        } catch (error) {
            if (charged > 0) req.user.points += charged;
            throw error;
        }
    } catch (error) {
        metrics.failedAnalyses++;
        metrics.errors++;
        console.error("[Análise Upload] ERRO:", error.message);
        return jsonError(res, 500, error.message || "Não foi possível analisar o vídeo.");
    }
});

async function renderClip(sourceFile, outputFile, start, duration) {
    if (!FFMPEG_BIN) throw new Error("FFmpeg não está disponível.");

    const args = [
        "-hide_banner", "-loglevel", "error",
        "-ss", String(start),
        "-i", sourceFile,
        "-t", String(duration),
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-sn", "-dn",
        "-c:v", "libx264",
        "-preset", process.env.FFMPEG_PRESET || "veryfast",
        "-crf", process.env.FFMPEG_CRF || "22",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        "-avoid_negative_ts", "make_zero",
        "-y",
        outputFile
    ];

    const result = await spawnCapture(FFMPEG_BIN, args);
    if (result.code !== 0) {
        throw new Error(`FFmpeg falhou: ${result.stderr || result.stdout || "erro desconhecido"}`);
    }

    const stat = await fsp.stat(outputFile);
    if (!stat.isFile() || stat.size <= 0) {
        throw new Error("FFmpeg não produziu um MP4 válido.");
    }

    return stat;
}

app.post("/api/download", requireUser, async (req, res) => {
    let temporarySource = null;
    let outputFile = null;

    try {
        const { start, duration, end, uploadId, url } = req.body || {};

        let safeStart = parseNumber(start, NaN);
        let requestedDuration = parseNumber(duration, NaN);

        if (!Number.isFinite(requestedDuration) && Number.isFinite(parseNumber(end, NaN))) {
            requestedDuration = parseNumber(end, 0) - safeStart;
        }

        if (!Number.isFinite(safeStart) || safeStart < 0) {
            return jsonError(res, 400, "Tempo inicial inválido.");
        }

        if (!Number.isFinite(requestedDuration) || requestedDuration <= 0 || requestedDuration > 90) {
            return jsonError(res, 400, "Duração inválida. O corte deve ter entre 0 e 90 segundos.");
        }

        if (!req.user.vip && req.user.points < DOWNLOAD_COST) {
            return jsonError(res, 402, `Pontos insuficientes. Necessário: ${DOWNLOAD_COST}. Disponível: ${req.user.points}.`);
        }

        let sourceFile = null;
        let sourceDuration = 0;

        if (uploadId) {
            const upload = getOwnedUpload(req.user, uploadId);
            if (!upload) return jsonError(res, 404, "Upload não encontrado.");

            sourceFile = upload.filePath;
            sourceDuration = parseNumber(upload.metadata?.duration, 0);

            if (!sourceFile || !fs.existsSync(sourceFile)) {
                return jsonError(res, 404, "Arquivo original não está mais disponível.");
            }
        }

        if (!sourceFile && url) {
            const normalized = normalizeYouTubeUrl(url);
            if (!normalized) return jsonError(res, 400, "URL do YouTube inválida.");

            const workDir = await fsp.mkdtemp(path.join(TEMP_ROOT, "download_"));
            const template = path.join(workDir, "source.%(ext)s");

            try {
                try {
                    const info = await getYouTubeInfo(normalized);
                    sourceDuration = parseNumber(info?.duration, 0);
                } catch (err) {
                    console.warn("[Download] Metadados YouTube:", err.message);
                }

                sourceFile = await downloadYouTubeVideo(normalized, template);
                temporarySource = workDir;
            } catch (error) {
                await safeRemove(workDir);
                throw error;
            }
        }

        if (!sourceFile) return jsonError(res, 400, "Informe uploadId ou url.");

        if (sourceDuration <= 0) {
            try {
                const metadata = await getVideoMetadata(sourceFile);
                sourceDuration = metadata.duration;
            } catch (_) {}
        }

        if (sourceDuration > 0) {
            if (safeStart >= sourceDuration) {
                return jsonError(res, 400, "O início do corte está além do fim do vídeo.");
            }
            requestedDuration = Math.min(requestedDuration, sourceDuration - safeStart);
        }

        requestedDuration = Math.min(requestedDuration, 90);

        outputFile = path.join(OUTPUT_DIR, `${randomId("clip_")}.mp4`);
        await renderClip(sourceFile, outputFile, safeStart, requestedDuration);
        const stat = await fsp.stat(outputFile);

        if (!req.user.vip) {
            req.user.points -= DOWNLOAD_COST;
        }

        req.user.downloads++;
        metrics.downloads++;

        const filename = `clipforge_${Date.now()}.mp4`;

        res.status(200);
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Length", String(stat.size));
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.setHeader("X-ClipForge-Version", VERSION);
        res.setHeader("X-ClipForge-User-Points", String(req.user.points));

        const stream = fs.createReadStream(outputFile);
        let cleaned = false;

        const cleanupAfterStream = async () => {
            if (cleaned) return;
            cleaned = true;
            await safeRemove(outputFile);
            if (temporarySource) await safeRemove(temporarySource);
        };

        stream.on("error", async (error) => {
            console.error("[Download] Stream:", error.message);
            await cleanupAfterStream();
            if (!res.headersSent) {
                res.status(500).json({ ok: false, error: "Erro ao transmitir o MP4." });
            } else {
                res.destroy(error);
            }
        });

        stream.on("close", cleanupAfterStream);
        res.on("close", () => { cleanupAfterStream().catch(() => {}); });
        stream.pipe(res);
        return;

    } catch (error) {
        metrics.errors++;
        console.error("[Download] ERRO:", error.message);
        await safeRemove(outputFile);
        if (temporarySource) await safeRemove(temporarySource);

        if (!res.headersSent) {
            return jsonError(res, 500, error.message || "Não foi possível gerar o corte MP4.");
        }
    }
});

/* ============================================================
   MERCADO PAGO / PIX
============================================================ */

async function mercadoPagoRequest(endpoint, options = {}) {
    if (!MP_ACCESS_TOKEN) throw new Error("MP_ACCESS_TOKEN não configurado.");

    const response = await fetch(`https://api.mercadopago.com${endpoint}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
            ...(options.headers || {})
        },
        signal: AbortSignal.timeout(60000)
    });

    const text = await response.text();
    let data;
    try {
        data = text ? JSON.parse(text) : null;
    } catch (_) {
        data = { raw: text };
    }

    if (!response.ok) {
        throw new Error(data?.message || data?.error || `Mercado Pago HTTP ${response.status}`);
    }

    return data;
}

app.post("/api/pix/criar", requireUser, async (req, res) => {
    if (!MP_ACCESS_TOKEN) {
        return jsonError(res, 503, "Mercado Pago não está configurado no servidor.");
    }

    try {
        const amount = Number(VIP_PRICE.toFixed(2));
        const reference = `clipforge_${req.user.id}_${crypto.randomUUID()}`;

        const body = {
            transaction_amount: amount,
            description: "ClipForge Pro VIP",
            payment_method_id: "pix",
            payer: {
                email: process.env.MP_PAYER_EMAIL || `cliente-${req.user.id}@clipforge.local`
            },
            external_reference: reference
        };

        if (MP_WEBHOOK_URL) body.notification_url = MP_WEBHOOK_URL;

        const payment = await mercadoPagoRequest("/v1/payments", {
            method: "POST",
            headers: { "X-Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify(body)
        });

        const paymentId = String(payment.id);
        const transaction = payment.point_of_interaction?.transaction_data || {};

        payments.set(paymentId, {
            id: paymentId,
            userId: req.user.id,
            amount,
            status: payment.status,
            createdAt: now(),
            externalReference: reference
        });

        metrics.pixCreated++;

        return res.json({
            ok: true,
            id: paymentId,
            paymentId,
            status: payment.status,
            qr_code: transaction.qr_code || "",
            qr_code_base64: transaction.qr_code_base64 || "",
            ticket_url: transaction.ticket_url || "",
            amount
        });
    } catch (error) {
        metrics.errors++;
        console.error("[PIX] ERRO:", error.message);
        return jsonError(res, 502, error.message);
    }
});

app.get("/api/pix/status/:id", requireUser, async (req, res) => {
    try {
        const paymentId = safeString(req.params.id).trim();
        const localPayment = payments.get(paymentId);

        if (localPayment && localPayment.userId !== req.user.id) {
            return jsonError(res, 403, "Pagamento não pertence a este usuário.");
        }

        const payment = await mercadoPagoRequest(`/v1/payments/${encodeURIComponent(paymentId)}`, {
            method: "GET"
        });

        const approved = payment.status === "approved";
        if (localPayment) localPayment.status = payment.status;

        if (approved && !req.user.vip) {
            req.user.vip = true;
            metrics.pixApproved++;
        }

        return res.json({
            ok: true,
            id: paymentId,
            status: payment.status,
            approved,
            user: publicUser(req.user)
        });
    } catch (error) {
        metrics.errors++;
        return jsonError(res, 502, error.message);
    }
});

app.post("/api/admin/login", async (req, res) => {
    if (!ADMIN_PASSWORD) {
        return jsonError(res, 503, "ADMIN_PASSWORD não configurada no Render.");
    }

    const email = safeString(req.body?.email).trim().toLowerCase();
    const password = safeString(req.body?.password);
    const validEmail = !email || email === ADMIN_EMAIL.trim().toLowerCase();

    if (!validEmail || password !== ADMIN_PASSWORD) {
        return jsonError(res, 401, "Credenciais administrativas inválidas.");
    }

    const token = randomToken(48);
    adminSessions.set(token, {
        createdAt: now(),
        expiresAt: now() + ADMIN_SESSION_TTL_MS
    });

    return res.json({ ok: true, token, session: token });
});

function requireAdmin(req, res, next) {
    const headerToken = safeString(req.headers["x-admin-session"]).trim();
    const token = headerToken || getBearerToken(req);
    const session = adminSessions.get(token);

    if (!session) return jsonError(res, 401, "Sessão administrativa inválida.");
    if (session.expiresAt < now()) {
        adminSessions.delete(token);
        return jsonError(res, 401, "Sessão administrativa expirada.");
    }

    req.admin = true;
    next();
}

app.get("/api/admin/dashboard", requireAdmin, (req, res) => {
    let vipUsers = 0;
    let totalPoints = 0;
    let totalDownloads = 0;
    let totalAnalyses = 0;

    for (const user of users.values()) {
        if (user.vip) vipUsers++;
        totalPoints += Math.max(0, user.points);
        totalDownloads += user.downloads || 0;
        totalAnalyses += user.analyses || 0;
    }

    const memory = process.memoryUsage();

    return res.json({
        ok: true,
        version: VERSION,
        metrics: {
            requests: metrics.requests,
            analyses: metrics.analyses,
            successfulAnalyses: metrics.successfulAnalyses,
            failedAnalyses: metrics.failedAnalyses,
            downloads: metrics.downloads,
            pixCreated: metrics.pixCreated,
            pixApproved: metrics.pixApproved,
            geminiRetries: metrics.geminiRetries,
            geminiFallbacks: metrics.geminiFallbacks,
            users: users.size,
            vipUsers,
            totalPoints,
            totalDownloads,
            totalAnalyses,
            errors: metrics.errors
        },
        memory: {
            rss: memory.rss,
            heapUsed: memory.heapUsed,
            heapTotal: memory.heapTotal,
            external: memory.external
        },
        uptime: process.uptime()
    });
});

app.get("/health", async (req, res) => {
    const ffmpeg = await commandExists(FFMPEG_BIN, ["-version"]).catch(() => false);
    const ffprobe = await commandExists(FFPROBE_BIN, ["-version"]).catch(() => false);
    const ytdlp = await commandExists(YTDLP_BIN, ["--version"]).catch(() => false);

    return res.json({
        ok: true,
        status: "online",
        service: "clipforge-server",
        version: VERSION,
        node: process.version,
        uptime: process.uptime(),
        gemini: {
            configured: Boolean(GEMINI_API_KEY),
            primaryModel: GEMINI_MODEL,
            fallbackModels: GEMINI_FALLBACK_MODELS,
            interactions: GEMINI_INTERACTIONS_URL,
            files: GEMINI_FILES_API_URL
        },
        binaries: { ffmpeg, ffprobe, ytDlp: ytdlp },
        upload: { maxMB: MAX_UPLOAD_MB },
        metrics
    });
});

app.get("/", (req, res) => {
    return res.json({
        ok: true,
        service: "ClipForge Pro",
        version: VERSION,
        status: "online",
        message: "Backend online.",
        endpoints: [
            "GET /health",
            "POST /api/auth/login",
            "GET /api/auth/me",
            "POST /api/upload",
            "GET /api/upload/:id",
            "POST /api/analisar",
            "POST /api/analisar-upload",
            "POST /api/download",
            "POST /api/pix/criar",
            "GET /api/pix/status/:id",
            "POST /api/admin/login",
            "GET /api/admin/dashboard"
        ]
    });
});

async function cleanupExpiredUploads() {
    const expiration = now() - UPLOAD_TTL_MS;
    for (const [uploadId, upload] of uploads.entries()) {
        if (upload.createdAt < expiration) {
            await safeRemove(upload.filePath);
            uploads.delete(uploadId);
        }
    }
}

setInterval(() => {
    cleanupExpiredUploads().catch((err) => console.error("[Cleanup]", err.message));
}, 15 * 60 * 1000).unref();

setInterval(() => {
    const timestamp = now();
    for (const [token, session] of sessions.entries()) {
        if (session.expiresAt < timestamp) sessions.delete(token);
    }
    for (const [token, session] of adminSessions.entries()) {
        if (session.expiresAt < timestamp) adminSessions.delete(token);
    }
}, 15 * 60 * 1000).unref();

app.use((req, res) => {
    return jsonError(res, 404, "Endpoint não encontrado.");
});

app.use((error, req, res, next) => {
    metrics.errors++;
    console.error("[Server Error]", error);

    if (error instanceof multer.MulterError) {
        if (error.code === "LIMIT_FILE_SIZE") {
            return jsonError(res, 413, `O arquivo excede o limite de ${MAX_UPLOAD_MB} MB.`);
        }
        return jsonError(res, 400, error.message);
    }

    if (error?.message === "Formato de vídeo não suportado.") {
        return jsonError(res, 400, error.message);
    }

    if (res.headersSent) return next(error);
    return jsonError(res, 500, error.message || "Erro interno do servidor.");
});

async function startServer() {
    try {
        await ensureDirectories();
        await resolveBinaries();

        console.log("");
        console.log("====================================================");
        console.log(` CLIPFORGE PRO — BACKEND ${VERSION}`);
        console.log("====================================================");
        console.log(`[Server] Node.js: ${process.version}`);
        console.log(`[Server] Host: ${HOST}`);
        console.log(`[Server] Port: ${PORT}`);
        console.log(`[Gemini] Primary: ${GEMINI_MODEL}`);
        console.log(`[Gemini] Fallbacks: ${GEMINI_FALLBACK_MODELS.join(", ")}`);
        console.log(`[Gemini] API Key: ${GEMINI_API_KEY ? "CONFIGURADA" : "NÃO CONFIGURADA"}`);
        console.log(`[Gemini] Interactions: ${GEMINI_INTERACTIONS_URL}`);
        console.log(`[Gemini] Files Upload: ${GEMINI_FILES_UPLOAD_URL}`);
        console.log(`[Gemini] Files API: ${GEMINI_FILES_API_URL}`);
        console.log(`[Mercado Pago] ${MP_ACCESS_TOKEN ? "CONFIGURADO" : "NÃO CONFIGURADO"}`);
        console.log(`[Upload] Limite: ${MAX_UPLOAD_MB} MB`);
        console.log("[Gemini] Exponential Backoff + Jitter ativo.");
        console.log("[Gemini] Detecção inteligente de quota ativa.");
        console.log("[Gemini] Upload MP4 por STREAM ativo.");
        console.log("[Gemini] Normalização files/ID ativa.");
        console.log("[Download] MP4 direto via stream ativo.");
        console.log("====================================================");

        app.listen(PORT, HOST, () => {
            console.log("");
            console.log(`🚀 ClipForge Pro ${VERSION} online`);
            console.log(`🌐 http://${HOST}:${PORT}`);
            console.log("❤️ /health");
            console.log("");
        });
    } catch (error) {
        console.error("[Startup] ERRO FATAL:", error);
        process.exit(1);
    }
}

startServer();
