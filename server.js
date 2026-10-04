/**
 * ============================================================
 * CLIPFORGE PRO — BACKEND V15.4.2 FINAL CONSOLIDADO
 * ============================================================
 * URL YOUTUBE CORRIGIDA
 * RANGE RFC 7233 ROBUSTO
 * HEAD + GET + 416
 * FFMPEG RESILIENTE
 * YT-DLP + PIPED + INVIDIOUS
 * IA OPENROUTER + FALLBACK AUTOMÁTICO
 * ANÁLISE SÍNCRONA
 * UPLOAD MP4
 * PONTOS + VIP
 * MERCADO PAGO / PIX
 * ADMIN
 * LIMPEZA AUTOMÁTICA
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

const {
    criarPagamentoPix,
    consultarPagamentoPix
} = require("./mercadoPago");

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";
const VERSION = "15.4.2-production-engine";

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

const CONCURRENT_JOBS_LIMIT = 1;
const MAX_QUEUE_LENGTH = 25;

const TEMP_ROOT =
    process.env.TEMP_DIR ||
    path.join(os.tmpdir(), "clipforge");

const UPLOAD_DIR =
    process.env.UPLOAD_DIR ||
    path.join(TEMP_ROOT, "uploads");

const OUTPUT_DIR =
    process.env.OUTPUT_DIR ||
    path.join(TEMP_ROOT, "outputs");

/* ============================================================
   CONFIGURAÇÃO IA — OPENROUTER
============================================================ */

const OPENROUTER_API_KEY =
    process.env.OPENROUTER_API_KEY ||
    process.env.OPEN_ROUTER_API_KEY ||
    "";

const OPENROUTER_URL =
    process.env.OPENROUTER_URL ||
    "https://openrouter.ai/api/v1/chat/completions";

const OPENROUTER_MODEL =
    process.env.OPENROUTER_MODEL ||
    "google/gemini-2.0-flash-001";

const OPENROUTER_FALLBACK_MODELS =
    (
        process.env.OPENROUTER_FALLBACK_MODELS ||
        "google/gemini-2.5-flash,google/gemini-2.5-flash-lite"
    )
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);

const OPENROUTER_MODELS = [
    OPENROUTER_MODEL,
    ...OPENROUTER_FALLBACK_MODELS.filter(
        (m) => m !== OPENROUTER_MODEL
    )
];

const PUBLIC_BASE_URL =
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    "https://clipforge-server-ikai.onrender.com";

const OPENROUTER_SITE_URL =
    process.env.OPENROUTER_SITE_URL ||
    "https://cortesdomnr.vercel.app";

const OPENROUTER_SITE_NAME =
    process.env.OPENROUTER_SITE_NAME ||
    "ClipForge Pro";

const MP_CONFIGURED = Boolean(
    process.env.MP_ACCESS_TOKEN ||
    process.env.MERCADO_PAGO_ACCESS_TOKEN
);

const MP_WEBHOOK_URL =
    process.env.MP_WEBHOOK_URL ||
    process.env.MERCADO_PAGO_WEBHOOK_URL ||
    "";

const ADMIN_EMAIL =
    process.env.ADMIN_EMAIL ||
    "admin@clipforge.local";

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD ||
    "";

const YTDLP_COOKIES_FILE =
    process.env.YTDLP_COOKIES_FILE ||
    process.env.YOUTUBE_COOKIES_FILE ||
    "";

const YOUTUBE_SOURCE_TIMEOUT_MS =
    Number(process.env.YOUTUBE_SOURCE_TIMEOUT_MS || 15000);

const YOUTUBE_DOWNLOAD_TIMEOUT_MS =
    Number(process.env.YOUTUBE_DOWNLOAD_TIMEOUT_MS || 300000);

const PIPED_API_URLS = (
    process.env.PIPED_API_URLS ||
    [
        "https://pipedapi.kavin.rocks",
        "https://pipedapi.leptons.xyz",
        "https://pipedapi.tokhmi.xyz"
    ].join(",")
)
    .split(",")
    .map((x) => x.trim().replace(/\/+$/, ""))
    .filter(Boolean);

const INVIDIOUS_API_URLS = (
    process.env.INVIDIOUS_API_URLS ||
    [
        "https://inv.nadeko.net",
        "https://invidious.nerdvpn.de",
        "https://yt.chocolatemoo53.com"
    ].join(",")
)
    .split(",")
    .map((x) => x.trim().replace(/\/+$/, ""))
    .filter(Boolean);

let FFMPEG_BIN = "ffmpeg";
let FFPROBE_BIN = "ffprobe";
let YTDLP_BIN = path.join(__dirname, "bin", "yt-dlp");

/* ============================================================
   ESTADOS EM MEMÓRIA
============================================================ */

const users = new Map();
const sessions = new Map();
const adminSessions = new Map();
const uploads = new Map();
const payments = new Map();
const jobs = new Map();
const aiVideoTokens = new Map();

const jobQueue = [];
const analysisWaiters = new Map();

let activeWorkers = 0;

/* ============================================================
   MÉTRICAS
============================================================ */

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
    openRouterRetries: 0,
    openRouterFallbacks: 0,
    errors: 0
};

/* ============================================================
   EXPRESS + CORS
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
            "HEAD",
            "OPTIONS"
        ],
        allowedHeaders: [
            "Content-Type",
            "Authorization",
            "X-User-Id",
            "X-Admin-Session",
            "Range"
        ],
        exposedHeaders: [
            "Content-Range",
            "Accept-Ranges",
            "Content-Length",
            "Content-Disposition",
            "X-ClipForge-Version",
            "X-ClipForge-User-Points"
        ]
    })
);

app.options("*", cors());

app.use(
    express.json({
        limit: "5mb"
    })
);

app.use(
    express.urlencoded({
        extended: false,
        limit: "2mb"
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
   UTILITÁRIOS
============================================================ */

const now = () => Date.now();

const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

const randomToken = (bytes = 32) =>
    crypto.randomBytes(bytes).toString("hex");

const randomId = (prefix = "") =>
    prefix + crypto.randomUUID();

function safeString(value, fallback = "") {
    if (
        value === null ||
        value === undefined
    ) {
        return fallback;
    }

    return String(value);
}

function parseNumber(value, fallback = 0) {
    const number = Number(value);

    return Number.isFinite(number)
        ? number
        : fallback;
}

function clamp(value, min, max) {
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
    return res.status(status).json({
        ok: false,
        error: message,
        ...extra
    });
}

function extractJsonFromText(text) {
    if (
        !text ||
        typeof text !== "string"
    ) {
        return null;
    }

    let clean = text.trim();

    clean = clean
        .replace(/^```json/i, "")
        .replace(/^```/i, "")
        .replace(/```$/i, "")
        .trim();

    try {
        return JSON.parse(clean);
    } catch (_) {}

    const firstBrace =
        clean.indexOf("{");

    const lastBrace =
        clean.lastIndexOf("}");

    if (
        firstBrace !== -1 &&
        lastBrace > firstBrace
    ) {
        try {
            return JSON.parse(
                clean.substring(
                    firstBrace,
                    lastBrace + 1
                )
            );
        } catch (_) {}
    }

    const firstBracket =
        clean.indexOf("[");

    const lastBracket =
        clean.lastIndexOf("]");

    if (
        firstBracket !== -1 &&
        lastBracket > firstBracket
    ) {
        try {
            return JSON.parse(
                clean.substring(
                    firstBracket,
                    lastBracket + 1
                )
            );
        } catch (_) {}
    }

    return null;
}

async function safeRemove(filePath) {
    if (!filePath) return;

    try {
        await fsp.rm(
            filePath,
            {
                recursive: true,
                force: true
            }
        );
    } catch (_) {}
}

async function ensureDirectories() {
    await fsp.mkdir(
        TEMP_ROOT,
        { recursive: true }
    );

    await fsp.mkdir(
        UPLOAD_DIR,
        { recursive: true }
    );

    await fsp.mkdir(
        OUTPUT_DIR,
        { recursive: true }
    );
}

/* ============================================================
   SPAWN COM CAPTURA E TIMEOUT
============================================================ */

function spawnCapture(
    command,
    args = [],
    options = {}
) {
    return new Promise((resolve, reject) => {
        const {
            timeoutMs,
            killGraceMs = 1500,
            ...spawnOptions
        } = options;

        let child;

        try {
            child = spawn(
                command,
                args,
                {
                    windowsHide: true,
                    ...spawnOptions
                }
            );
        } catch (error) {
            return reject(error);
        }

        let stdout = "";
        let stderr = "";

        let finished = false;
        let timedOut = false;

        let timeoutTimer = null;
        let killTimer = null;

        const cleanupTimers = () => {
            if (timeoutTimer) {
                clearTimeout(timeoutTimer);
                timeoutTimer = null;
            }

            if (killTimer) {
                clearTimeout(killTimer);
                killTimer = null;
            }
        };

        const finishResolve = (result) => {
            if (finished) return;

            finished = true;
            cleanupTimers();

            resolve(result);
        };

        const finishReject = (error) => {
            if (finished) return;

            finished = true;
            cleanupTimers();

            reject(error);
        };

        child.stdout?.on(
            "data",
            (chunk) => {
                stdout += chunk.toString();

                if (stdout.length > 250000) {
                    stdout = stdout.slice(-250000);
                }
            }
        );

        child.stderr?.on(
            "data",
            (chunk) => {
                stderr += chunk.toString();

                if (stderr.length > 250000) {
                    stderr = stderr.slice(-250000);
                }
            }
        );

        child.once(
            "error",
            (error) => {
                if (timedOut) {
                    const timeoutError =
                        new Error(
                            `Processo excedeu timeout de ${timeoutMs}ms.`
                        );

                    timeoutError.code =
                        "ETIMEDOUT";

                    return finishReject(
                        timeoutError
                    );
                }

                finishReject(error);
            }
        );

        child.once(
            "close",
            (code, signal) => {
                if (timedOut) {
                    const timeoutError =
                        new Error(
                            `Processo excedeu timeout de ${timeoutMs}ms.`
                        );

                    timeoutError.code =
                        "ETIMEDOUT";

                    timeoutError.stdout =
                        stdout;

                    timeoutError.stderr =
                        stderr;

                    return finishReject(
                        timeoutError
                    );
                }

                finishResolve({
                    code,
                    signal,
                    stdout,
                    stderr
                });
            }
        );

        if (
            Number.isFinite(timeoutMs) &&
            timeoutMs > 0
        ) {
            timeoutTimer = setTimeout(() => {
                if (finished) return;

                timedOut = true;

                try {
                    child.kill("SIGTERM");
                } catch (_) {}

                killTimer = setTimeout(() => {
                    if (finished) return;

                    try {
                        child.kill("SIGKILL");
                    } catch (_) {}
                }, killGraceMs);
            }, timeoutMs);
        }
    });
}

async function commandExists(
    command,
    args = ["--version"]
) {
    try {
        const result =
            await spawnCapture(
                command,
                args,
                {
                    timeoutMs: 10000
                }
            );

        return result.code === 0;
    } catch (_) {
        return false;
    }
}

/* ============================================================
   RESOLUÇÃO DINÂMICA DE BINÁRIOS
============================================================ */

async function resolveBinaries() {
    const ffmpegCandidates = [
        process.env.FFMPEG_PATH,
        process.env.FFMPEG_BIN,
        path.join(
            __dirname,
            "bin",
            "ffmpeg"
        )
    ];

    try {
        const staticFfmpeg =
            require("ffmpeg-static");

        if (staticFfmpeg) {
            ffmpegCandidates.unshift(
                staticFfmpeg
            );
        }
    } catch (_) {}

    try {
        const installerFfmpeg =
            require("@ffmpeg-installer/ffmpeg");

        if (installerFfmpeg?.path) {
            ffmpegCandidates.push(
                installerFfmpeg.path
            );
        }
    } catch (_) {}

    ffmpegCandidates.push("ffmpeg");

    for (const cand of ffmpegCandidates) {
        if (!cand) continue;

        if (fs.existsSync(cand)) {
            try {
                fs.chmodSync(
                    cand,
                    0o755
                );
            } catch (_) {}
        }

        if (
            await commandExists(
                cand,
                ["-version"]
            )
        ) {
            FFMPEG_BIN = cand;
            break;
        }
    }

    const ffprobeCandidates = [
        process.env.FFPROBE_PATH,
        process.env.FFPROBE_BIN,
        path.join(
            __dirname,
            "bin",
            "ffprobe"
        )
    ];

    try {
        const installerFfprobe =
            require("@ffprobe-installer/ffprobe");

        if (installerFfprobe?.path) {
            ffprobeCandidates.unshift(
                installerFfprobe.path
            );
        }
    } catch (_) {}

    ffprobeCandidates.push("ffprobe");

    for (const cand of ffprobeCandidates) {
        if (!cand) continue;

        if (fs.existsSync(cand)) {
            try {
                fs.chmodSync(
                    cand,
                    0o755
                );
            } catch (_) {}
        }

        if (
            await commandExists(
                cand,
                ["-version"]
            )
        ) {
            FFPROBE_BIN = cand;
            break;
        }
    }

    const ytdlpCandidates = [
        path.join(
            __dirname,
            "bin",
            "yt-dlp"
        ),
        process.env.YTDLP_BIN,
        process.env.YTDLP_PATH,
        path.join(
            process.cwd(),
            "bin",
            "yt-dlp"
        ),
        "yt-dlp"
    ];

    for (const cand of ytdlpCandidates) {
        if (!cand) continue;

        if (fs.existsSync(cand)) {
            try {
                fs.chmodSync(
                    cand,
                    0o755
                );
            } catch (_) {}
        }

        if (
            await commandExists(
                cand,
                ["--version"]
            )
        ) {
            YTDLP_BIN = cand;
            break;
        }
    }

    console.log(
        `[Binaries] FFmpeg: ${
            await commandExists(
                FFMPEG_BIN,
                ["-version"]
            )
                ? FFMPEG_BIN
                : "AUSENTE"
        }`
    );

    console.log(
        `[Binaries] FFprobe: ${
            await commandExists(
                FFPROBE_BIN,
                ["-version"]
            )
                ? FFPROBE_BIN
                : "AUSENTE"
        }`
    );

    console.log(
        `[Binaries] yt-dlp: ${
            await commandExists(
                YTDLP_BIN,
                ["--version"]
            )
                ? YTDLP_BIN
                : "AUSENTE"
        }`
    );
}

/* ============================================================
   METADADOS E VALIDAÇÃO DE VÍDEO
============================================================ */

async function getVideoMetadata(
    filePath
) {
    if (!FFPROBE_BIN) {
        throw new Error(
            "FFprobe não está disponível."
        );
    }

    const result =
        await spawnCapture(
            FFPROBE_BIN,
            [
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                filePath
            ],
            {
                timeoutMs: 30000
            }
        );

    if (result.code !== 0) {
        throw new Error(
            `FFprobe falhou: ${
                result.stderr ||
                result.stdout
            }`
        );
    }

    let data;

    try {
        data = JSON.parse(
            result.stdout
        );
    } catch (_) {
        throw new Error(
            "FFprobe retornou JSON inválido."
        );
    }

    const format =
        data.format || {};

    const streams =
        Array.isArray(data.streams)
            ? data.streams
            : [];

    const videoStream =
        streams.find(
            (s) =>
                s.codec_type === "video"
        ) || null;

    const audioStream =
        streams.find(
            (s) =>
                s.codec_type === "audio"
        ) || null;

    return {
        duration: parseNumber(
            format.duration,
            0
        ),

        size: parseNumber(
            format.size,
            0
        ),

        format:
            format.format_name ||
            null,

        width: parseNumber(
            videoStream?.width,
            0
        ),

        height: parseNumber(
            videoStream?.height,
            0
        ),

        videoCodec:
            videoStream?.codec_name ||
            null,

        audioCodec:
            audioStream?.codec_name ||
            null,

        fps:
            videoStream?.r_frame_rate ||
            null
    };
}

async function validateVideoFile(
    filePath
) {
    if (!filePath) {
        throw new Error(
            "Arquivo de vídeo não informado."
        );
    }

    const stat =
        await fsp.stat(filePath);

    if (!stat.isFile()) {
        throw new Error(
            "O caminho informado não é um arquivo."
        );
    }

    if (stat.size <= 10000) {
        throw new Error(
            "O arquivo de vídeo está vazio ou inválido."
        );
    }

    if (stat.size > MAX_UPLOAD_BYTES) {
        throw new Error(
            `O vídeo excede o limite de ${MAX_UPLOAD_MB} MB.`
        );
    }

    const metadata =
        await getVideoMetadata(
            filePath
        );

    if (
        !metadata.duration ||
        metadata.duration <= 0
    ) {
        throw new Error(
            "Não foi possível obter a duração do vídeo."
        );
    }

    return metadata;
}

/* ============================================================
   MULTER
============================================================ */

const storage =
    multer.diskStorage({
        destination: (
            req,
            file,
            cb
        ) => {
            cb(
                null,
                UPLOAD_DIR
            );
        },

        filename: (
            req,
            file,
            cb
        ) => {
            cb(
                null,
                `${randomId(
                    "upload_"
                )}.mp4`
            );
        }
    });

const uploadMiddleware =
    multer({
        storage,

        limits: {
            fileSize:
                MAX_UPLOAD_BYTES,
            files: 1
        },

        fileFilter: (
            req,
            file,
            cb
        ) => {
            const mime =
                safeString(
                    file.mimetype
                ).toLowerCase();

            const name =
                safeString(
                    file.originalname
                ).toLowerCase();

            const validMime =
                mime === "video/mp4";

            const validExtension =
                /\.mp4$/i.test(name);

            if (
                !validMime ||
                !validExtension
            ) {
                return cb(
                    new Error(
                        "Apenas arquivos MP4 são suportados."
                    )
                );
            }

            cb(null, true);
        }
    });

/* ============================================================
   YOUTUBE
============================================================ */

function getYouTubeId(value) {
    const input =
        safeString(value).trim();

    if (
        /^[A-Za-z0-9_-]{11}$/.test(
            input
        )
    ) {
        return input;
    }

    try {
        const url =
            new URL(input);

        const host =
            url.hostname.toLowerCase();

        if (host === "youtu.be") {
            const id =
                url.pathname
                    .replace(/^\//, "")
                    .split("/")[0];

            return /^[A-Za-z0-9_-]{11}$/.test(
                id
            )
                ? id
                : null;
        }

        if (
            host.includes(
                "youtube.com"
            )
        ) {
            const v =
                url.searchParams.get(
                    "v"
                );

            if (
                v &&
                /^[A-Za-z0-9_-]{11}$/.test(
                    v
                )
            ) {
                return v;
            }

            const parts =
                url.pathname
                    .split("/")
                    .filter(Boolean);

            const index =
                parts.findIndex(
                    (part) =>
                        [
                            "shorts",
                            "embed",
                            "live"
                        ].includes(part)
                );

            if (
                index >= 0 &&
                parts[index + 1]
            ) {
                const id =
                    parts[index + 1];

                if (
                    /^[A-Za-z0-9_-]{11}$/.test(
                        id
                    )
                ) {
                    return id;
                }
            }
        }
    } catch (_) {}

    return null;
}

function normalizeYouTubeUrl(value) {
    const id =
        getYouTubeId(value);

    if (!id) return null;

    return `https://www.youtube.com/watch?v=${id}`;
}

function isMp4Stream(stream) {
    if (!stream) return false;

    const type =
        safeString(
            stream.type ||
            stream.mimeType ||
            stream.mime_type ||
            ""
        ).toLowerCase();

    const container =
        safeString(
            stream.container ||
            stream.format ||
            ""
        ).toLowerCase();

    const url =
        safeString(
            stream.url || ""
        ).toLowerCase();

    return (
        type.includes("video/mp4") ||
        container === "mp4" ||
        container.includes("mp4") ||
        url.includes(".mp4")
    );
}

function normalizeQualityNumber(
    value
) {
    const match =
        safeString(value).match(
            /(\d{3,4})/
        );

    return match
        ? Number(match[1])
        : 0;
}

/* ============================================================
   DOWNLOAD REMOTO
============================================================ */

async function downloadRemoteVideo(
    url,
    outputFile
) {
    if (!url) {
        throw new Error(
            "URL do stream não informada."
        );
    }

    const controller =
        new AbortController();

    const timer =
        setTimeout(
            () =>
                controller.abort(),
            YOUTUBE_DOWNLOAD_TIMEOUT_MS
        );

    let fileHandle = null;

    try {
        const res =
            await fetch(
                url,
                {
                    method: "GET",
                    redirect: "follow",
                    signal:
                        controller.signal,

                    headers: {
                        "User-Agent":
                            "ClipForge-Pro/15.4.2",
                        Accept:
                            "video/mp4,video/*;q=0.9,*/*;q=0.8"
                    }
                }
            );

        if (!res.ok) {
            throw new Error(
                `Download HTTP ${res.status}`
            );
        }

        if (!res.body) {
            throw new Error(
                "Sem corpo de resposta no stream."
            );
        }

        const contentLength =
            Number(
                res.headers.get(
                    "content-length"
                ) || 0
            );

        if (
            contentLength >
            MAX_UPLOAD_BYTES
        ) {
            throw new Error(
                `Vídeo excede o limite de ${MAX_UPLOAD_MB} MB.`
            );
        }

        await fsp.mkdir(
            path.dirname(
                outputFile
            ),
            {
                recursive: true
            }
        );

        fileHandle =
            fs.createWriteStream(
                outputFile
            );

        let totalBytes = 0;

        for await (
            const chunk of res.body
        ) {
            const buffer =
                Buffer.from(chunk);

            totalBytes +=
                buffer.length;

            if (
                totalBytes >
                MAX_UPLOAD_BYTES
            ) {
                throw new Error(
                    `Download excedeu ${MAX_UPLOAD_MB} MB.`
                );
            }

            if (
                !fileHandle.write(
                    buffer
                )
            ) {
                await new Promise(
                    (
                        resolve,
                        reject
                    ) => {
                        fileHandle.once(
                            "drain",
                            resolve
                        );

                        fileHandle.once(
                            "error",
                            reject
                        );
                    }
                );
            }
        }

        await new Promise(
            (
                resolve,
                reject
            ) => {
                fileHandle.end(
                    () => resolve()
                );

                fileHandle.once(
                    "error",
                    reject
                );
            }
        );

        fileHandle = null;

        if (totalBytes <= 10000) {
            throw new Error(
                "Stream retornou arquivo inválido ou muito pequeno."
            );
        }

        return outputFile;
    } catch (err) {
        try {
            fileHandle?.destroy();
        } catch (_) {}

        await safeRemove(
            outputFile
        );

        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/* ============================================================
   YT-DLP
============================================================ */

async function downloadYouTubeWithYtDlp(
    url,
    outputTemplate
) {
    const args = [
        "--no-playlist",
        "--no-warnings",
        "--no-mtime",
        "--restrict-filenames",
        "--extractor-args",
        "youtube:player-client=web,android",
        "-f",
        "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]/best",
        "--merge-output-format",
        "mp4",
        "-o",
        outputTemplate,
        url
    ];

    if (
        YTDLP_COOKIES_FILE &&
        fs.existsSync(
            YTDLP_COOKIES_FILE
        )
    ) {
        args.splice(
            2,
            0,
            "--cookies",
            YTDLP_COOKIES_FILE
        );
    }

    const result =
        await spawnCapture(
            YTDLP_BIN,
            args,
            {
                timeoutMs:
                    YOUTUBE_DOWNLOAD_TIMEOUT_MS
            }
        );

    if (result.code !== 0) {
        const errorOut =
            (
                result.stderr ||
                result.stdout ||
                "Erro desconhecido"
            ).slice(0, 500);

        throw new Error(
            errorOut
        );
    }

    const directory =
        path.dirname(
            outputTemplate
        );

    const files =
        await fsp.readdir(
            directory
        );

    let candidate =
        files.find(
            (f) =>
                f === "source.mp4"
        );

    if (!candidate) {
        candidate =
            files.find(
                (f) =>
                    /^source\.mp4$/i.test(
                        f
                    ) ||
                    /\.mp4$/i.test(
                        f
                    )
            );
    }

    if (!candidate) {
        throw new Error(
            "yt-dlp terminou sem gerar arquivo MP4."
        );
    }

    const filePath =
        path.join(
            directory,
            candidate
        );

    const metadata =
        await validateVideoFile(
            filePath
        );

    return {
        filePath,
        title: "",
        duration:
            metadata.duration,
        source: "yt-dlp"
    };
}

/* ============================================================
   PIPED
============================================================ */

async function tryPipedDownload(
    videoId,
    outputFile
) {
    let lastError = null;

    for (
        const apiBase
        of PIPED_API_URLS
    ) {
        try {
            const res =
                await fetch(
                    `${apiBase}/streams/${encodeURIComponent(
                        videoId
                    )}`,
                    {
                        headers: {
                            Accept:
                                "application/json",
                            "User-Agent":
                                "ClipForge-Pro/15.4.2"
                        },

                        signal:
                            AbortSignal.timeout(
                                YOUTUBE_SOURCE_TIMEOUT_MS
                            )
                    }
                );

            if (!res.ok) continue;

            const data =
                await res.json();

            const streams =
                Array.isArray(
                    data?.videoStreams
                )
                    ? data.videoStreams
                    : [];

            const candidates =
                streams
                    .filter(
                        (s) =>
                            s?.url &&
                            s.videoOnly !==
                                true &&
                            isMp4Stream(s)
                    )
                    .map(
                        (s) => ({
                            ...s,
                            qualityNumber:
                                normalizeQualityNumber(
                                    s.quality ||
                                    s.qualityLabel ||
                                    s.resolution
                                )
                        })
                    )
                    .filter(
                        (s) =>
                            s.qualityNumber >
                                0 &&
                            s.qualityNumber <=
                                720
                    );

            candidates.sort(
                (a, b) =>
                    b.qualityNumber -
                    a.qualityNumber
            );

            if (
                !candidates[0]?.url
            ) {
                continue;
            }

            await downloadRemoteVideo(
                candidates[0].url,
                outputFile
            );

            const metadata =
                await validateVideoFile(
                    outputFile
                );

            return {
                filePath:
                    outputFile,

                title:
                    safeString(
                        data?.title,
                        ""
                    ),

                duration:
                    metadata.duration,

                source: "piped"
            };
        } catch (e) {
            lastError = e;

            await safeRemove(
                outputFile
            );
        }
    }

    throw (
        lastError ||
        new Error(
            "Piped indisponível."
        )
    );
}

/* ============================================================
   INVIDIOUS
============================================================ */

async function tryInvidiousDownload(
    videoId,
    outputFile
) {
    let lastError = null;

    for (
        const apiBase
        of INVIDIOUS_API_URLS
    ) {
        try {
            const res =
                await fetch(
                    `${apiBase}/api/v1/videos/${encodeURIComponent(
                        videoId
                    )}?region=BR`,
                    {
                        headers: {
                            Accept:
                                "application/json",
                            "User-Agent":
                                "ClipForge-Pro/15.4.2"
                        },

                        signal:
                            AbortSignal.timeout(
                                YOUTUBE_SOURCE_TIMEOUT_MS
                            )
                    }
                );

            if (!res.ok) continue;

            const data =
                await res.json();

            const streams =
                Array.isArray(
                    data?.formatStreams
                )
                    ? data.formatStreams
                    : [];

            const candidates =
                streams
                    .filter(
                        (s) =>
                            s?.url &&
                            isMp4Stream(s)
                    )
                    .map(
                        (s) => ({
                            ...s,
                            qualityNumber:
                                normalizeQualityNumber(
                                    s.qualityLabel ||
                                    s.quality ||
                                    s.resolution
                                )
                        })
                    )
                    .filter(
                        (s) =>
                            s.qualityNumber >
                                0 &&
                            s.qualityNumber <=
                                720
                    );

            candidates.sort(
                (a, b) =>
                    b.qualityNumber -
                    a.qualityNumber
            );

            if (
                !candidates[0]?.url
            ) {
                continue;
            }

            await downloadRemoteVideo(
                candidates[0].url,
                outputFile
            );

            const metadata =
                await validateVideoFile(
                    outputFile
                );

            return {
                filePath:
                    outputFile,

                title:
                    safeString(
                        data?.title,
                        ""
                    ),

                duration:
                    metadata.duration,

                source: "invidious"
            };
        } catch (e) {
            lastError = e;

            await safeRemove(
                outputFile
            );
        }
    }

    throw (
        lastError ||
        new Error(
            "Invidious indisponível."
        )
    );
}

/* ============================================================
   DOWNLOAD YOUTUBE COM FALLBACKS
============================================================ */

async function downloadYouTubeVideo(
    url,
    outputTemplate
) {
    const videoId =
        getYouTubeId(url);

    if (!videoId) {
        throw new Error(
            "ID do YouTube inválido."
        );
    }

    console.log(
        `[YouTube] ID: ${videoId}`
    );

    const directory =
        path.dirname(
            outputTemplate
        );

    await fsp.mkdir(
        directory,
        {
            recursive: true
        }
    );

    const outputFile =
        path.join(
            directory,
            "source.mp4"
        );

    const errors = [];

    try {
        console.log(
            "[YouTube] Baixando via yt-dlp..."
        );

        const result =
            await downloadYouTubeWithYtDlp(
                url,
                outputTemplate
            );

        console.log(
            `[YouTube] yt-dlp OK! Duração: ${result.duration}s`
        );

        return result;
    } catch (err) {
        console.warn(
            `[YouTube] yt-dlp falhou: ${err.message}`
        );

        errors.push(
            `yt-dlp: ${err.message}`
        );
    }

    try {
        console.log(
            "[YouTube] Tentando fallback Piped..."
        );

        const result =
            await tryPipedDownload(
                videoId,
                outputFile
            );

        return result;
    } catch (err) {
        errors.push(
            `Piped: ${err.message}`
        );
    }

    try {
        console.log(
            "[YouTube] Tentando fallback Invidious..."
        );

        const result =
            await tryInvidiousDownload(
                videoId,
                outputFile
            );

        return result;
    } catch (err) {
        errors.push(
            `Invidious: ${err.message}`
        );
    }

    throw new Error(
        `Falha no download do YouTube:\n${errors.join(
            "\n"
        )}`
    );
}

/* ============================================================
   IA — PROMPT
============================================================ */

function buildClipPrompt(
    videoDuration
) {
    const duration =
        Number(videoDuration) || 0;

    return `Você é um editor profissional de vídeos virais para TikTok, YouTube Shorts e Instagram Reels.

Analise o vídeo e encontre os melhores momentos para gerar cortes.

Duração total do vídeo: ${duration.toFixed(
        1
    )} segundos.

REGRAS OBRIGATÓRIAS:
1. Retorne até ${MAX_CLIPS} cortes.
2. Cada corte deve ter entre 10 e 90 segundos.
3. Nunca ultrapasse a duração total do vídeo.
4. Para vídeos menores que 10 segundos, use o máximo possível da duração real.
5. Não sobreponha cortes.
6. Priorize:
   - ganchos fortes;
   - frases impactantes;
   - emoção;
   - surpresa;
   - humor;
   - conflito;
   - informação importante;
   - momentos com potencial de retenção;
   - começo e final que façam sentido isoladamente.
7. Dê uma nota de 0 a 100 para cada corte.
8. Ordene mentalmente os melhores momentos primeiro.
9. Retorne SOMENTE JSON válido.

FORMATO:
{
  "clips": [
    {
      "start": 10.5,
      "end": 55.5,
      "duration": 45,
      "title": "Gancho magnético",
      "description": "Trecho com alto potencial de retenção",
      "score": 95
    }
  ]
}`;
}

/* ============================================================
   NORMALIZAÇÃO DOS CORTES
============================================================ */

function normalizeClipsScoreFirst(
    rawArray,
    maxDuration
) {
    if (!Array.isArray(rawArray)) {
        return [];
    }

    const total =
        Number(maxDuration) || 0;

    const cleaned =
        rawArray
            .map((c, i) => {
                if (
                    !c ||
                    typeof c !==
                        "object"
                ) {
                    return null;
                }

                let start =
                    parseNumber(
                        c.start ??
                            c.inicio ??
                            c.startTime ??
                            c.inicio_segundos,
                        0
                    );

                let end =
                    parseNumber(
                        c.end ??
                            c.fim ??
                            c.endTime ??
                            c.fim_segundos,
                        0
                    );

                let duration =
                    parseNumber(
                        c.duration ??
                            c.duracao ??
                            c.length,
                        0
                    );

                start = Math.max(
                    0,
                    start
                );

                if (
                    start >= total &&
                    total > 0
                ) {
                    return null;
                }

                if (
                    end > start &&
                    duration <= 0
                ) {
                    duration =
                        end - start;
                }

                if (
                    duration <= 0 &&
                    end > start
                ) {
                    duration =
                        end - start;
                }

                if (
                    duration <= 0
                ) {
                    duration =
                        Math.min(
                            30,
                            Math.max(
                                1,
                                total - start
                            )
                        );
                }

                if (total >= 10) {
                    duration =
                        clamp(
                            duration,
                            10,
                            90
                        );
                } else {
                    duration =
                        clamp(
                            duration,
                            1,
                            total
                        );
                }

                if (
                    total > 0 &&
                    start + duration >
                        total
                ) {
                    start =
                        Math.max(
                            0,
                            total -
                                duration
                        );

                    duration =
                        total - start;
                }

                if (
                    duration <= 0
                ) {
                    return null;
                }

                end =
                    start + duration;

                const title =
                    safeString(
                        c.title ??
                            c.titulo ??
                            c.name,
                        `Corte #${
                            i + 1
                        }`
                    ).trim();

                const description =
                    safeString(
                        c.description ??
                            c.descricao ??
                            c.reason,
                        "Momento de destaque do vídeo"
                    ).trim();

                const score =
                    clamp(
                        parseNumber(
                            c.score ??
                                c.pontuacao ??
                                c.rating ??
                                c.relevance,
                            85
                        ),
                        0,
                        100
                    );

                return {
                    start: Number(
                        start.toFixed(2)
                    ),

                    end: Number(
                        end.toFixed(2)
                    ),

                    duration: Number(
                        duration.toFixed(2)
                    ),

                    title:
                        title ||
                        `Corte #${
                            i + 1
                        }`,

                    description:
                        description ||
                        "Momento de destaque do vídeo",

                    score: Number(
                        score.toFixed(0)
                    )
                };
            })
            .filter(Boolean);

    cleaned.sort(
        (a, b) =>
            b.score - a.score
    );

    const selected = [];

    for (
        const candidate
        of cleaned
    ) {
        const overlap =
            selected.some(
                (existing) =>
                    candidate.start <
                        existing.end &&
                    candidate.end >
                        existing.start
            );

        if (!overlap) {
            selected.push(
                candidate
            );
        }

        if (
            selected.length >=
            MAX_CLIPS
        ) {
            break;
        }
    }

    return selected.sort(
        (a, b) =>
            a.start - b.start
    );
}

/* ============================================================
   FALLBACK AUTOMÁTICO
============================================================ */

function generateFallbackClips(
    totalDuration,
    requestedCount = 5
) {
    const duration =
        Number(totalDuration) || 0;

    if (duration <= 0) {
        return [];
    }

    if (duration < 10) {
        return [
            {
                start: 0,

                end: Number(
                    duration.toFixed(2)
                ),

                duration: Number(
                    duration.toFixed(2)
                ),

                title:
                    "Destaque do vídeo",

                description:
                    "Trecho automático do vídeo",

                score: 75
            }
        ];
    }

    const maxClips =
        Math.min(
            MAX_CLIPS,
            Math.max(
                1,
                Number(
                    requestedCount
                ) || 5
            )
        );

    const clipDuration =
        Math.min(
            60,
            Math.max(
                10,
                Math.min(
                    30,
                    duration
                )
            )
        );

    if (
        duration <=
        clipDuration + 2
    ) {
        return [
            {
                start: 0,

                end: Number(
                    duration.toFixed(2)
                ),

                duration: Number(
                    duration.toFixed(2)
                ),

                title:
                    "Melhor momento",

                description:
                    "Trecho automático selecionado pelo ClipForge",

                score: 80
            }
        ];
    }

    const clips = [];
    const possibleStarts = [];

    if (
        duration >
        clipDuration
    ) {
        possibleStarts.push(0);

        const middle =
            (duration -
                clipDuration) /
            2;

        possibleStarts.push(
            middle
        );

        possibleStarts.push(
            duration -
                clipDuration
        );
    }

    if (
        duration >
        clipDuration * 3
    ) {
        const usable =
            duration -
            clipDuration;

        for (
            let i = 1;
            i < maxClips - 1;
            i++
        ) {
            possibleStarts.push(
                (usable * i) /
                    (maxClips - 1)
            );
        }
    }

    const uniqueStarts = [
        ...new Set(
            possibleStarts
                .map((x) =>
                    Math.max(
                        0,
                        Math.min(
                            x,
                            duration -
                                clipDuration
                        )
                    )
                )
                .map((x) =>
                    Number(
                        x.toFixed(2)
                    )
                )
        )
    ].sort(
        (a, b) => a - b
    );

    for (
        const start
        of uniqueStarts
    ) {
        if (
            clips.length >=
            maxClips
        ) {
            break;
        }

        const end =
            Math.min(
                duration,
                start +
                    clipDuration
            );

        const realDuration =
            end - start;

        if (
            realDuration < 1
        ) {
            continue;
        }

        const overlap =
            clips.some(
                (c) =>
                    start < c.end &&
                    end > c.start
            );

        if (overlap) {
            continue;
        }

        clips.push({
            start: Number(
                start.toFixed(2)
            ),

            end: Number(
                end.toFixed(2)
            ),

            duration: Number(
                realDuration.toFixed(2)
            ),

            title:
                `Destaque #${
                    clips.length + 1
                }`,

            description:
                "Momento selecionado automaticamente pelo ClipForge",

            score:
                Math.max(
                    70,
                    82 -
                        clips.length *
                            2
                )
        });
    }

    return clips.sort(
        (a, b) =>
            a.start - b.start
    );
}

function completeClipsWithFallback(
    clips,
    totalDuration
) {
    const duration =
        Number(totalDuration) || 0;

    const valid =
        normalizeClipsScoreFirst(
            Array.isArray(clips)
                ? clips
                : [],
            duration
        );

    if (!valid.length) {
        return generateFallbackClips(
            duration,
            Math.min(
                5,
                MAX_CLIPS
            )
        );
    }

    const minimumDesired =
        duration >= 30
            ? 3
            : 1;

    if (
        valid.length >=
        minimumDesired
    ) {
        return valid.slice(
            0,
            MAX_CLIPS
        );
    }

    const fallback =
        generateFallbackClips(
            duration,
            MAX_CLIPS
        );

    const combined = [
        ...valid
    ];

    for (
        const candidate
        of fallback
    ) {
        if (
            combined.length >=
            MAX_CLIPS
        ) {
            break;
        }

        const overlap =
            combined.some(
                (existing) =>
                    candidate.start <
                        existing.end &&
                    candidate.end >
                        existing.start
            );

        if (!overlap) {
            combined.push(
                candidate
            );
        }
    }

    return combined
        .sort(
            (a, b) =>
                b.score -
                a.score
        )
        .slice(
            0,
            MAX_CLIPS
        )
        .sort(
            (a, b) =>
                a.start -
                b.start
        );
}

/* ============================================================
   OPENROUTER
============================================================ */

async function requestOpenRouter(
    model,
    promptText,
    videoUrl
) {
    const controller =
        new AbortController();

    const timeout =
        setTimeout(
            () =>
                controller.abort(),
            120000
        );

    try {
        const content = [
            {
                type: "text",
                text: promptText
            }
        ];

        if (videoUrl) {
            content.push({
                type: "video_url",

                video_url: {
                    url: videoUrl
                }
            });
        }

        const res =
            await fetch(
                OPENROUTER_URL,
                {
                    method: "POST",

                    headers: {
                        Authorization:
                            `Bearer ${OPENROUTER_API_KEY}`,

                        "Content-Type":
                            "application/json",

                        "HTTP-Referer":
                            OPENROUTER_SITE_URL,

                        "X-Title":
                            OPENROUTER_SITE_NAME
                    },

                    body: JSON.stringify({
                        model,

                        messages: [
                            {
                                role: "user",
                                content
                            }
                        ],

                        response_format: {
                            type: "json_object"
                        }
                    }),

                    signal:
                        controller.signal
                }
            );

        const text =
            await res.text();

        if (!res.ok) {
            throw new Error(
                `OpenRouter HTTP ${res.status}: ${text.slice(
                    0,
                    300
                )}`
            );
        }

        return JSON.parse(
            text
        );
    } finally {
        clearTimeout(
            timeout
        );
    }
}

async function analyzeWithOpenRouterFallback(
    promptText,
    videoUrl,
    videoDuration
) {
    if (
        !OPENROUTER_API_KEY
    ) {
        throw new Error(
            "OPENROUTER_API_KEY não configurada."
        );
    }

    let lastError = null;

    for (
        let i = 0;
        i < OPENROUTER_MODELS.length;
        i++
    ) {
        const model =
            OPENROUTER_MODELS[i];

        try {
            console.log(
                `[IA] Modelo ${model}`
            );

            const data =
                await requestOpenRouter(
                    model,
                    promptText,
                    videoUrl
                );

            const message =
                data?.choices?.[0]
                    ?.message?.content;

            const parsed =
                extractJsonFromText(
                    typeof message ===
                        "string"
                        ? message
                        : JSON.stringify(
                              message
                          )
                );

            const raw =
                parsed?.clips ||
                parsed?.cortes ||
                parsed?.results ||
                parsed;

            const clips =
                normalizeClipsScoreFirst(
                    raw,
                    videoDuration
                );

            if (clips.length) {
                return {
                    model,
                    clips
                };
            }

            throw new Error(
                "IA respondeu, mas não retornou cortes válidos."
            );
        } catch (e) {
            lastError = e;

            if (
                i <
                OPENROUTER_MODELS.length -
                    1
            ) {
                metrics.openRouterRetries++;
                metrics.openRouterFallbacks++;

                console.warn(
                    `[IA] Fallback após falha em ${model}: ${e.message}`
                );
            } else {
                console.warn(
                    `[IA] Último modelo falhou: ${e.message}`
                );
            }
        }
    }

    throw (
        lastError ||
        new Error(
            "Todos os modelos de IA falharam."
        )
    );
}

/* ============================================================
   RENDERIZAÇÃO FFMPEG
============================================================ */

async function renderClip(
    sourceFile,
    outputFile,
    start,
    duration,
    format = "9:16"
) {
    if (!FFMPEG_BIN) {
        throw new Error(
            "FFmpeg não disponível."
        );
    }

    let vf = "";

    if (format === "9:16") {
        vf =
            "scale=1080:1920:force_original_aspect_ratio=decrease," +
            "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black";
    } else if (
        format === "1:1"
    ) {
        vf =
            "scale=1080:1080:force_original_aspect_ratio=decrease," +
            "pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=black";
    } else if (
        format === "16:9"
    ) {
        vf =
            "scale=1920:1080:force_original_aspect_ratio=decrease," +
            "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black";
    } else {
        throw new Error(
            `Formato '${format}' inválido. Escolha entre 9:16, 1:1 ou 16:9.`
        );
    }

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

        "-vf",
        vf,

        "-c:v",
        "libx264",

        "-preset",
        "ultrafast",

        "-threads",
        "2",

        "-crf",
        "24",

        "-c:a",
        "aac",

        "-b:a",
        "128k",

        "-avoid_negative_ts",
        "make_zero",

        "-movflags",
        "+faststart",

        "-y",
        outputFile
    ];

    const res =
        await spawnCapture(
            FFMPEG_BIN,
            args,
            {
                timeoutMs: 180000
            }
        );

    if (res.code !== 0) {
        throw new Error(
            `FFmpeg falhou: ${
                res.stderr ||
                res.stdout
            }`
        );
    }

    const stat =
        await fsp.stat(
            outputFile
        );

    if (
        !stat.isFile() ||
        stat.size === 0
    ) {
        throw new Error(
            "Renderização não produziu um MP4 válido."
        );
    }

    return stat;
}

/* ============================================================
   FILA E WORKER
============================================================ */

function processNextInQueue() {
    while (
        activeWorkers <
            CONCURRENT_JOBS_LIMIT &&
        jobQueue.length
    ) {
        const item =
            jobQueue.shift();

        activeWorkers++;

        runAnalysisWorker(
            item.jobId,
            item.payload
        )
            .then((result) => {
                const waiter =
                    analysisWaiters.get(
                        item.jobId
                    );

                if (waiter) {
                    analysisWaiters.delete(
                        item.jobId
                    );

                    waiter.resolve(
                        result
                    );
                }
            })
            .catch((error) => {
                const waiter =
                    analysisWaiters.get(
                        item.jobId
                    );

                if (waiter) {
                    analysisWaiters.delete(
                        item.jobId
                    );

                    waiter.reject(
                        error
                    );
                }
            })
            .finally(() => {
                activeWorkers--;

                processNextInQueue();
            });
    }
}

function enqueueJob(
    jobId,
    payload
) {
    if (
        jobQueue.length >=
        MAX_QUEUE_LENGTH
    ) {
        throw new Error(
            "Fila cheia. Tente novamente em alguns instantes."
        );
    }

    return new Promise(
        (
            resolve,
            reject
        ) => {
            analysisWaiters.set(
                jobId,
                {
                    resolve,
                    reject
                }
            );

            jobQueue.push({
                jobId,
                payload
            });

            processNextInQueue();
        }
    );
}

/* ============================================================
   WORKER DE ANÁLISE
============================================================ */

async function runAnalysisWorker(
    jobId,
    payload
) {
    const job =
        jobs.get(jobId);

    if (!job) {
        throw new Error(
            "Job não encontrado."
        );
    }

    let workDir = null;
    let aiToken = null;

    const user =
        users.get(
            job.userId
        );

    const setStage = (
        status,
        message,
        progress
    ) => {
        job.status =
            status;

        job.stageMessage =
            message;

        job.progress =
            progress;

        job.updatedAt =
            now();

        console.log(
            `[Job ${jobId}] ${progress}% ${status}: ${message}`
        );
    };

    try {
        setStage(
            "downloading",
            "Obtendo vídeo original...",
            20
        );

        let sourceFile = "";
        let duration = 0;
        let title = "";

        if (
            payload.type ===
            "youtube"
        ) {
            workDir =
                await fsp.mkdtemp(
                    path.join(
                        TEMP_ROOT,
                        "job_yt_"
                    )
                );

            const dl =
                await downloadYouTubeVideo(
                    payload.url,
                    path.join(
                        workDir,
                        "source.%(ext)s"
                    )
                );

            sourceFile =
                dl.filePath;

            duration =
                dl.duration;

            title =
                dl.title ||
                "Vídeo do YouTube";
        } else {
            sourceFile =
                payload.filePath;

            duration =
                payload.duration;

            title =
                payload.originalName ||
                "Vídeo MP4";

            const metadata =
                await validateVideoFile(
                    sourceFile
                );

            duration =
                metadata.duration;
        }

        if (
            !duration ||
            duration <= 0
        ) {
            throw new Error(
                "Não foi possível determinar a duração do vídeo."
            );
        }

        setStage(
            "analyzing",
            "IA analisando os melhores momentos...",
            60
        );

        aiToken =
            randomToken(32);

        aiVideoTokens.set(
            aiToken,
            {
                filePath:
                    sourceFile,

                expiresAt:
                    now() +
                    15 * 60 * 1000
            }
        );

        const proxy =
            `${PUBLIC_BASE_URL}/api/ai-video/${aiToken}`;

        let aiModel =
            "fallback";

        let clips = [];

        try {
            const aiResult =
                await analyzeWithOpenRouterFallback(
                    buildClipPrompt(
                        duration
                    ) +
                        `\nTítulo: ${title}`,
                    proxy,
                    duration
                );

            aiModel =
                aiResult.model;

            clips =
                aiResult.clips ||
                [];

            console.log(
                `[IA] ${aiModel} retornou ${clips.length} corte(s).`
            );
        } catch (
            aiError
        ) {
            console.warn(
                `[IA] Falha na análise semântica: ${aiError.message}`
            );

            clips = [];

            aiModel =
                "automatic-fallback";
        }

        clips =
            completeClipsWithFallback(
                clips,
                duration
            );

        if (!clips.length) {
            throw new Error(
                "Não foi possível gerar cortes para este vídeo."
            );
        }

        if (
            user &&
            !user.vip &&
            job.reservedPoints >
                0
        ) {
            user.reservedPoints =
                Math.max(
                    0,
                    (user.reservedPoints ||
                        0) -
                        job.reservedPoints
                );

            job.reservedPoints =
                0;
        }

        job.status =
            "completed";

        job.stageMessage =
            "Análise concluída com sucesso.";

        job.progress = 100;

        job.updatedAt =
            now();

        job.result = {
            model: aiModel,

            clips,

            duration,

            type:
                payload.type,

            uploadId:
                payload.uploadId ||
                null,

            url:
                payload.url ||
                null,

            title
        };

        if (user) {
            user.analyses =
                (user.analyses ||
                    0) +
                1;
        }

        metrics.successfulAnalyses++;

        console.log(
            `[Worker] Job ${jobId} concluído com ${clips.length} corte(s).`
        );

        return job.result;
    } catch (err) {
        console.error(
            `[Worker] Falha ${jobId}: ${err.message}`
        );

        job.status =
            "failed";

        job.stageMessage =
            `Falha no processamento: ${err.message}`;

        job.error =
            err.message;

        job.progress = 0;

        job.updatedAt =
            now();

        if (
            user &&
            !user.vip &&
            job.reservedPoints >
                0
        ) {
            user.points +=
                job.reservedPoints;

            user.reservedPoints =
                Math.max(
                    0,
                    (user.reservedPoints ||
                        0) -
                        job.reservedPoints
                );

            job.reservedPoints =
                0;
        }

        metrics.failedAnalyses++;

        throw err;
    } finally {
        if (aiToken) {
            aiVideoTokens.delete(
                aiToken
            );
        }

        if (workDir) {
            await safeRemove(
                workDir
            );
        }
    }
}

/* ============================================================
   USUÁRIOS E AUTENTICAÇÃO
============================================================ */

function ensureUser(
    requestedId
) {
    let userId =
        safeString(
            requestedId
        ).trim() ||
        randomId("user_");

    let user =
        users.get(userId);

    if (!user) {
        user = {
            id: userId,

            points:
                FREE_POINTS,

            reservedPoints: 0,

            vip: false,

            createdAt:
                now(),

            lastDailyClaim:
                now(),

            downloads: 0,

            analyses: 0
        };

        users.set(
            userId,
            user
        );
    }

    const today =
        new Date()
            .toISOString()
            .slice(0, 10);

    const previous =
        user.lastDailyClaim
            ? new Date(
                  user.lastDailyClaim
              )
                  .toISOString()
                  .slice(0, 10)
            : "";

    if (
        today !==
        previous
    ) {
        user.points +=
            DAILY_POINTS;

        user.lastDailyClaim =
            now();
    }

    return user;
}

function publicUser(user) {
    return {
        id: user.id,

        userId: user.id,

        pontos: Math.max(
            0,
            Math.floor(
                user.points
            )
        ),

        points: Math.max(
            0,
            Math.floor(
                user.points
            )
        ),

        vip:
            Boolean(
                user.vip
            ),

        isVip:
            Boolean(
                user.vip
            )
    };
}

function getBearerToken(
    req
) {
    const header =
        safeString(
            req.headers.authorization
        );

    if (
        header
            .toLowerCase()
            .startsWith("bearer ")
    ) {
        return header
            .slice(7)
            .trim();
    }

    return "";
}

function requireUser(
    req,
    res,
    next
) {
    const token =
        getBearerToken(req);

    let user = null;

    if (token) {
        const session =
            sessions.get(
                token
            );

        if (
            session &&
            session.expiresAt >
                now()
        ) {
            user =
                users.get(
                    session.userId
                );
        }
    }

    if (!user) {
        const headerId =
            safeString(
                req.headers[
                    "x-user-id"
                ]
            ).trim();

        if (headerId) {
            user =
                ensureUser(
                    headerId
                );
        }
    }

    if (!user) {
        return jsonError(
            res,
            401,
            "Sessão inválida ou não autenticada."
        );
    }

    req.user =
        user;

    next();
}

function requireAdmin(
    req,
    res,
    next
) {
    const token =
        safeString(
            req.headers[
                "x-admin-session"
            ]
        ).trim() ||
        getBearerToken(req);

    const session =
        adminSessions.get(
            token
        );

    if (
        !session ||
        session.expiresAt <
            now()
    ) {
        return jsonError(
            res,
            401,
            "Sessão administrativa expirada ou inválida."
        );
    }

    next();
}

/* ============================================================
   AUTH
============================================================ */

app.post(
    "/api/auth/login",
    (req, res) => {
        const user =
            ensureUser(
                req.body?.userId
            );

        const token =
            randomToken(48);

        sessions.set(
            token,
            {
                userId:
                    user.id,

                expiresAt:
                    now() +
                    SESSION_TTL_MS
            }
        );

        res.json({
            ok: true,

            token,

            session:
                token,

            user:
                publicUser(
                    user
                )
        });
    }
);

app.get(
    "/api/auth/me",
    requireUser,
    (req, res) => {
        res.json({
            ok: true,

            user:
                publicUser(
                    req.user
                )
        });
    }
);

/* ============================================================
   UPLOAD MP4
============================================================ */

app.post(
    "/api/upload",
    requireUser,
    uploadMiddleware.single(
        "video"
    ),
    async (
        req,
        res
    ) => {
        try {
            if (!req.file) {
                return jsonError(
                    res,
                    400,
                    "Nenhum vídeo enviado."
                );
            }

            const metadata =
                await validateVideoFile(
                    req.file.path
                );

            const uploadId =
                randomId(
                    "upload_"
                );

            const item = {
                id: uploadId,

                userId:
                    req.user.id,

                filePath:
                    req.file.path,

                originalName:
                    req.file.originalname,

                mimeType:
                    req.file.mimetype,

                size:
                    req.file.size,

                createdAt:
                    now(),

                metadata
            };

            uploads.set(
                uploadId,
                item
            );

            metrics.uploads++;

            res.json({
                ok: true,

                uploadId,

                id:
                    uploadId,

                duration:
                    metadata.duration,

                file: {
                    name:
                        item.originalName,

                    size:
                        item.size
                }
            });
        } catch (err) {
            if (
                req.file?.path
            ) {
                await safeRemove(
                    req.file.path
                );
            }

            jsonError(
                res,
                400,
                err.message
            );
        }
    }
);

/* ============================================================
   ANÁLISE SÍNCRONA
============================================================ */

app.post(
    "/api/analisar",
    requireUser,
    async (
        req,
        res
    ) => {
        metrics.analyses++;

        const {
            url,
            uploadId
        } = req.body || {};

        if (
            !req.user.vip &&
            req.user.points <
                ANALYSIS_COST
        ) {
            return jsonError(
                res,
                402,
                `Pontos insuficientes (Necessário: ${ANALYSIS_COST}, Disponível: ${req.user.points}).`
            );
        }

        let payload;

        if (uploadId) {
            const up =
                uploads.get(
                    uploadId
                );

            if (
                !up ||
                up.userId !==
                    req.user.id
            ) {
                return jsonError(
                    res,
                    404,
                    "Upload não encontrado."
                );
            }

            payload = {
                type:
                    "upload",

                uploadId,

                filePath:
                    up.filePath,

                duration:
                    up.metadata.duration,

                originalName:
                    up.originalName
            };
        } else if (url) {
            const norm =
                normalizeYouTubeUrl(
                    url
                );

            if (!norm) {
                return jsonError(
                    res,
                    400,
                    "URL do YouTube inválida."
                );
            }

            payload = {
                type:
                    "youtube",

                url:
                    norm
            };
        } else {
            return jsonError(
                res,
                400,
                "Informe url ou uploadId."
            );
        }

        if (
            jobQueue.length >=
            MAX_QUEUE_LENGTH
        ) {
            return jsonError(
                res,
                429,
                "Fila cheia. Tente novamente em alguns instantes."
            );
        }

        let reserved = 0;

        if (!req.user.vip) {
            req.user.points -=
                ANALYSIS_COST;

            req.user.reservedPoints =
                (req.user.reservedPoints ||
                    0) +
                ANALYSIS_COST;

            reserved =
                ANALYSIS_COST;
        }

        const jobId =
            randomId(
                "job_"
            );

        jobs.set(
            jobId,
            {
                id: jobId,

                userId:
                    req.user.id,

                status:
                    "queued",

                stageMessage:
                    "Aguardando processamento...",

                progress: 5,

                reservedPoints:
                    reserved,

                createdAt:
                    now(),

                updatedAt:
                    now()
            }
        );

        try {
            const result =
                await enqueueJob(
                    jobId,
                    payload
                );

            return res.json({
                ok: true,

                clips:
                    result.clips,

                duration:
                    result.duration,

                model:
                    result.model,

                title:
                    result.title ||
                    "",

                uploadId:
                    result.uploadId ||
                    null,

                url:
                    result.url ||
                    null,

                jobId,

                status:
                    "completed",

                user:
                    publicUser(
                        req.user
                    )
            });
        } catch (e) {
            const job =
                jobs.get(
                    jobId
                );

            if (
                reserved &&
                job &&
                job.reservedPoints >
                    0
            ) {
                req.user.points +=
                    reserved;

                req.user.reservedPoints =
                    Math.max(
                        0,
                        (req.user.reservedPoints ||
                            0) -
                            reserved
                    );

                job.reservedPoints =
                    0;
            }

            return jsonError(
                res,
                500,
                e.message ||
                    "Erro durante a análise."
            );
        }
    }
);

/* ============================================================
   DOWNLOAD + RENDERIZAÇÃO
============================================================ */

app.post(
    "/api/download",
    requireUser,
    async (
        req,
        res
    ) => {
        let temporarySource =
            null;

        let outputFile =
            null;

        try {
            const {
                start,
                duration,
                format = "9:16",
                uploadId,
                url
            } =
                req.body || {};

            const nStart =
                parseNumber(
                    start,
                    -1
                );

            let nDuration =
                parseNumber(
                    duration,
                    -1
                );

            if (
                nStart < 0 ||
                nDuration <= 0
            ) {
                return jsonError(
                    res,
                    400,
                    "Intervalo ou duração inválidos."
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
                    `Pontos insuficientes para download (Necessário: ${DOWNLOAD_COST}).`
                );
            }

            let sourceFile =
                null;

            let sourceDuration =
                0;

            if (uploadId) {
                const up =
                    uploads.get(
                        uploadId
                    );

                if (
                    !up ||
                    up.userId !==
                        req.user.id
                ) {
                    throw new Error(
                        "Upload não encontrado."
                    );
                }

                sourceFile =
                    up.filePath;

                sourceDuration =
                    up.metadata.duration;
            } else if (url) {
                const norm =
                    normalizeYouTubeUrl(
                        url
                    );

                if (!norm) {
                    throw new Error(
                        "URL do YouTube inválida."
                    );
                }

                const workDir =
                    await fsp.mkdtemp(
                        path.join(
                            TEMP_ROOT,
                            "render_yt_"
                        )
                    );

                const dl =
                    await downloadYouTubeVideo(
                        norm,
                        path.join(
                            workDir,
                            "source.%(ext)s"
                        )
                    );

                sourceFile =
                    dl.filePath;

                sourceDuration =
                    dl.duration;

                temporarySource =
                    workDir;
            } else {
                throw new Error(
                    "Informe uploadId ou url."
                );
            }

            if (
                !sourceDuration
            ) {
                const meta =
                    await getVideoMetadata(
                        sourceFile
                    );

                sourceDuration =
                    meta.duration;
            }

            if (
                nStart >=
                sourceDuration
            ) {
                throw new Error(
                    "O ponto de início ultrapassa a duração total do vídeo."
                );
            }

            if (
                nStart +
                    nDuration >
                sourceDuration
            ) {
                nDuration =
                    sourceDuration -
                    nStart;
            }

            outputFile =
                path.join(
                    OUTPUT_DIR,
                    `${randomId(
                        "clip_"
                    )}.mp4`
                );

            const stat =
                await renderClip(
                    sourceFile,
                    outputFile,
                    nStart,
                    nDuration,
                    format
                );

            if (!req.user.vip) {
                req.user.points =
                    Math.max(
                        0,
                        req.user.points -
                            DOWNLOAD_COST
                    );
            }

            req.user.downloads++;

            metrics.downloads++;

            res.setHeader(
                "Content-Type",
                "video/mp4"
            );

            res.setHeader(
                "Content-Length",
                String(
                    stat.size
                )
            );

            res.setHeader(
                "Content-Disposition",
                `attachment; filename="clipforge_${Date.now()}.mp4"`
            );

            res.setHeader(
                "X-ClipForge-User-Points",
                String(
                    req.user.points
                )
            );

            const stream =
                fs.createReadStream(
                    outputFile
                );

            const cleanup =
                async () => {
                    await safeRemove(
                        outputFile
                    );

                    if (
                        temporarySource
                    ) {
                        await safeRemove(
                            temporarySource
                        );
                    }
                };

            stream.on(
                "close",
                cleanup
            );

            stream.on(
                "error",
                async (
                    err
                ) => {
                    await cleanup();

                    if (
                        !res.headersSent
                    ) {
                        jsonError(
                            res,
                            500,
                            "Erro ao transmitir MP4."
                        );
                    }
                }
            );

            stream.pipe(res);
        } catch (err) {
            if (outputFile) {
                await safeRemove(
                    outputFile
                );
            }

            if (
                temporarySource
            ) {
                await safeRemove(
                    temporarySource
                );
            }

            jsonError(
                res,
                500,
                err.message ||
                    "Erro durante o processamento do corte."
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
    async (
        req,
        res
    ) => {
        if (!MP_CONFIGURED) {
            return jsonError(
                res,
                503,
                "Mercado Pago não configurado."
            );
        }

        try {
            const amount =
                Number(
                    VIP_PRICE.toFixed(
                        2
                    )
                );

            const reference =
                `clipforge_${req.user.id}_${crypto.randomUUID()}`;

            const payerEmail =
                process.env.MP_PAYER_EMAIL ||
                `cliente-${req.user.id}@clipforge.local`;

            const payment =
                await criarPagamentoPix(
                    {
                        amount,

                        description:
                            "ClipForge Pro VIP",

                        email:
                            payerEmail,

                        externalReference:
                            reference,

                        notificationUrl:
                            MP_WEBHOOK_URL ||
                            undefined
                    }
                );

            const paymentId =
                String(
                    payment.id
                );

            const transaction =
                payment
                    .point_of_interaction
                    ?.transaction_data ||
                {};

            payments.set(
                paymentId,
                {
                    id:
                        paymentId,

                    userId:
                        req.user.id,

                    amount,

                    status:
                        payment.status,

                    createdAt:
                        now(),

                    externalReference:
                        reference
                }
            );

            metrics.pixCreated++;

            res.json({
                ok: true,

                id:
                    paymentId,

                status:
                    payment.status,

                qr_code:
                    transaction.qr_code ||
                    "",

                qr_code_base64:
                    transaction.qr_code_base64 ||
                    "",

                ticket_url:
                    transaction.ticket_url ||
                    "",

                amount
            });
        } catch (err) {
            metrics.errors++;

            jsonError(
                res,
                502,
                err.message
            );
        }
    }
);

app.get(
    "/api/pix/status/:id",
    requireUser,
    async (
        req,
        res
    ) => {
        try {
            const paymentId =
                safeString(
                    req.params.id
                ).trim();

            const localPayment =
                payments.get(
                    paymentId
                );

            if (
                !localPayment ||
                localPayment.userId !==
                    req.user.id
            ) {
                return jsonError(
                    res,
                    403,
                    "Pagamento não encontrado ou não pertence a este usuário."
                );
            }

            const payment =
                await consultarPagamentoPix(
                    paymentId
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

            res.json({
                ok: true,

                id:
                    paymentId,

                status:
                    payment.status,

                approved,

                user:
                    publicUser(
                        req.user
                    )
            });
        } catch (err) {
            metrics.errors++;

            jsonError(
                res,
                502,
                err.message
            );
        }
    }
);

/* ============================================================
   ADMIN
============================================================ */

app.post(
    "/api/admin/login",
    (
        req,
        res
    ) => {
        if (!ADMIN_PASSWORD) {
            return jsonError(
                res,
                503,
                "ADMIN_PASSWORD não configurada."
            );
        }

        const email =
            safeString(
                req.body?.email
            )
                .trim()
                .toLowerCase();

        const password =
            safeString(
                req.body?.password
            );

        const validEmail =
            !email ||
            email ===
                ADMIN_EMAIL
                    .trim()
                    .toLowerCase();

        if (
            !validEmail ||
            password !==
                ADMIN_PASSWORD
        ) {
            return jsonError(
                res,
                401,
                "Credenciais administrativas inválidas."
            );
        }

        const token =
            randomToken(48);

        adminSessions.set(
            token,
            {
                createdAt:
                    now(),

                expiresAt:
                    now() +
                    ADMIN_SESSION_TTL_MS
            }
        );

        res.json({
            ok: true,

            token,

            session:
                token
        });
    }
);

app.get(
    "/api/admin/dashboard",
    requireAdmin,
    (
        req,
        res
    ) => {
        let vipUsers = 0;
        let totalPoints = 0;

        for (
            const u
            of users.values()
        ) {
            if (u.vip) {
                vipUsers++;
            }

            totalPoints +=
                Math.max(
                    0,
                    u.points
                );
        }

        res.json({
            ok: true,

            version:
                VERSION,

            metrics: {
                ...metrics,

                users:
                    users.size,

                vipUsers,

                totalPoints
            },

            uptime:
                process.uptime()
        });
    }
);

/* ============================================================
   PARSER RFC 7233 — RANGE ÚNICO
============================================================ */

function parseSingleRange(
    rangeHeader,
    fileSize
) {
    if (
        !rangeHeader ||
        !Number.isFinite(
            fileSize
        ) ||
        fileSize <= 0
    ) {
        return {
            invalid: true
        };
    }

    const normalized =
        String(
            rangeHeader
        ).trim();

    /*
     * Só aceitamos:
     *
     * bytes=0-499
     * bytes=500-
     * bytes=-500
     *
     * Não aceitamos múltiplos ranges.
     */
    if (
        !/^bytes=/i.test(
            normalized
        )
    ) {
        return {
            invalid: true
        };
    }

    const rangeValue =
        normalized
            .slice(6)
            .trim();

    /*
     * RFC 7233:
     * apenas um range é aceito.
     *
     * Exemplo rejeitado:
     * bytes=0-499,500-999
     */
    if (
        rangeValue.includes(",")
    ) {
        return {
            invalid: true
        };
    }

    const match =
        rangeValue.match(
            /^(\d*)-(\d*)$/
        );

    if (!match) {
        return {
            invalid: true
        };
    }

    const startRaw =
        match[1];

    const endRaw =
        match[2];

    if (
        startRaw === "" &&
        endRaw === ""
    ) {
        return {
            invalid: true
        };
    }

    let start = 0;
    let end =
        fileSize - 1;

    /*
     * Suffix byte range:
     *
     * bytes=-500
     */
    if (
        startRaw === "" &&
        endRaw !== ""
    ) {
        const suffixLength =
            parseInt(
                endRaw,
                10
            );

        if (
            isNaN(
                suffixLength
            ) ||
            suffixLength <= 0
        ) {
            return {
                invalid: true
            };
        }

        start = Math.max(
            0,
            fileSize -
                suffixLength
        );

        end =
            fileSize - 1;
    }

    /*
     * Open-ended range:
     *
     * bytes=500-
     */
    else if (
        startRaw !== "" &&
        endRaw === ""
    ) {
        start =
            parseInt(
                startRaw,
                10
            );

        end =
            fileSize - 1;
    }

    /*
     * Closed range:
     *
     * bytes=0-499
     */
    else {
        start =
            parseInt(
                startRaw,
                10
            );

        end =
            parseInt(
                endRaw,
                10
            );
    }

    if (
        isNaN(start) ||
        isNaN(end) ||
        start < 0 ||
        start >= fileSize ||
        end < start
    ) {
        return {
            invalid: true
        };
    }

    /*
     * Trava o end no último
     * byte real do arquivo.
     */
    end =
        Math.min(
            end,
            fileSize - 1
        );

    return {
        start,
        end,

        chunkSize:
            end -
            start +
            1
    };
}

/* ============================================================
   ENDPOINT DA IA
   GET + HEAD
   RANGE RFC 7233
   206 + 416
============================================================ */

const handleAiVideoStreaming =
    async (
        req,
        res
    ) => {
        const entry =
            aiVideoTokens.get(
                req.params.token
            );

        if (
            !entry ||
            entry.expiresAt <
                now() ||
            !fs.existsSync(
                entry.filePath
            )
        ) {
            return res
                .status(404)
                .send(
                    "Vídeo temporário expirado ou indisponível."
                );
        }

        try {
            const stat =
                await fsp.stat(
                    entry.filePath
                );

            const fileSize =
                stat.size;

            const rangeHeader =
                req.headers.range;

            /*
             * Sem Range:
             * retorna arquivo completo.
             */
            if (!rangeHeader) {
                res.writeHead(
                    200,
                    {
                        "Content-Length":
                            fileSize,

                        "Content-Type":
                            "video/mp4",

                        "Accept-Ranges":
                            "bytes"
                    }
                );

                if (
                    req.method ===
                    "HEAD"
                ) {
                    return res.end();
                }

                return fs
                    .createReadStream(
                        entry.filePath
                    )
                    .pipe(res);
            }

            /*
             * Range RFC 7233.
             */
            const range =
                parseSingleRange(
                    rangeHeader,
                    fileSize
                );

            /*
             * Range inválido:
             * 416.
             */
            if (
                !range ||
                range.invalid
            ) {
                res.setHeader(
                    "Content-Range",
                    `bytes */${fileSize}`
                );

                return res
                    .status(416)
                    .send(
                        "Requested Range Not Satisfiable"
                    );
            }

            /*
             * Range válido:
             * 206 Partial Content.
             */
            res.writeHead(
                206,
                {
                    "Content-Range":
                        `bytes ${range.start}-${range.end}/${fileSize}`,

                    "Accept-Ranges":
                        "bytes",

                    "Content-Length":
                        range.chunkSize,

                    "Content-Type":
                        "video/mp4"
                }
            );

            /*
             * HEAD não envia
             * corpo.
             */
            if (
                req.method ===
                "HEAD"
            ) {
                return res.end();
            }

            const file =
                fs.createReadStream(
                    entry.filePath,
                    {
                        start:
                            range.start,

                        end:
                            range.end
                    }
                );

            file.pipe(res);
        } catch (err) {
            console.error(
                "[AI Video] Range error:",
                err.message
            );

            if (
                !res.headersSent
            ) {
                return res
                    .status(500)
                    .send(
                        "Erro ao ler arquivo de vídeo."
                    );
            }

            try {
                res.end();
            } catch (_) {}
        }
    };

app.get(
    "/api/ai-video/:token",
    handleAiVideoStreaming
);

app.head(
    "/api/ai-video/:token",
    handleAiVideoStreaming
);

/* ============================================================
   DIAGNÓSTICO E SAÚDE
============================================================ */

app.get(
    "/health",
    async (
        req,
        res
    ) => {
        res.json({
            ok: true,

            status:
                "online",

            service:
                "clipforge-server",

            version:
                VERSION,

            models: {
                primary:
                    OPENROUTER_MODEL,

                fallbacks:
                    OPENROUTER_FALLBACK_MODELS
            },

            binaries: {
                ffmpeg:
                    await commandExists(
                        FFMPEG_BIN,
                        ["-version"]
                    ),

                ffprobe:
                    await commandExists(
                        FFPROBE_BIN,
                        ["-version"]
                    ),

                ytDlp:
                    await commandExists(
                        YTDLP_BIN,
                        ["--version"]
                    )
            },

            queue: {
                inQueue:
                    jobQueue.length,

                activeWorkers
            },

            jobs: {
                total:
                    jobs.size,

                queued:
                    Array.from(
                        jobs.values()
                    ).filter(
                        (j) =>
                            j.status ===
                            "queued"
                    ).length,

                running:
                    Array.from(
                        jobs.values()
                    ).filter(
                        (j) =>
                            [
                                "downloading",
                                "analyzing"
                            ].includes(
                                j.status
                            )
                    ).length
            }
        });
    }
);

/* ============================================================
   ROOT
============================================================ */

app.get(
    "/",
    (
        req,
        res
    ) => {
        res.json({
            ok: true,

            service:
                "ClipForge Pro",

            version:
                VERSION,

            status:
                "online"
        });
    }
);

/* ============================================================
   LIMPEZA AUTOMÁTICA
============================================================ */

setInterval(
    async () => {
        const expiration =
            now() -
            UPLOAD_TTL_MS;

        /*
         * Remove uploads antigos.
         */
        for (
            const [
                id,
                up
            ] of uploads.entries()
        ) {
            if (
                up.createdAt <
                expiration
            ) {
                await safeRemove(
                    up.filePath
                );

                uploads.delete(
                    id
                );
            }
        }

        const current =
            now();

        /*
         * Remove sessões
         * expiradas.
         */
        for (
            const [
                token,
                s
            ] of sessions.entries()
        ) {
            if (
                s.expiresAt <
                current
            ) {
                sessions.delete(
                    token
                );
            }
        }

        /*
         * Remove sessões
         * administrativas.
         */
        for (
            const [
                token,
                s
            ] of adminSessions.entries()
        ) {
            if (
                s.expiresAt <
                current
            ) {
                adminSessions.delete(
                    token
                );
            }
        }

        /*
         * Remove tokens
         * temporários da IA.
         */
        for (
            const [
                token,
                v
            ] of aiVideoTokens.entries()
        ) {
            if (
                v.expiresAt <
                current
            ) {
                aiVideoTokens.delete(
                    token
                );
            }
        }

        /*
         * Remove jobs antigos.
         */
        for (
            const [
                id,
                j
            ] of jobs.entries()
        ) {
            if (
                now() -
                    j.createdAt >
                3 *
                    3600 *
                    1000
            ) {
                jobs.delete(
                    id
                );
            }
        }
    },
    15 * 60 * 1000
).unref();

/* ============================================================
   INICIALIZAÇÃO
============================================================ */

async function startServer() {
    try {
        await ensureDirectories();

        await resolveBinaries();

        app.listen(
            PORT,
            HOST,
            () => {
                console.log(
                    "===================================================="
                );

                console.log(
                    ` 🚀 CLIPFORGE PRO — BACKEND ${VERSION} ONLINE`
                );

                console.log(
                    ` 🌐 http://${HOST}:${PORT}`
                );

                console.log(
                    ` 🤖 Modelo Primário: ${OPENROUTER_MODEL}`
                );

                console.log(
                    "===================================================="
                );
            }
        );
    } catch (err) {
        console.error(
            "[Startup] FATAL ERROR:",
            err
        );

        process.exit(1);
    }
}

startServer();