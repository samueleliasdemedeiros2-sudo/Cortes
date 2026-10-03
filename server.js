/**
 * ============================================================
 * CLIPFORGE PRO — BACKEND 13.2.8
 * ============================================================
 *
 * Node.js >= 20 + Express
 *
 * CORREÇÕES 13.2.8
 * ------------------------------------------------------------
 * 1. Gemini Files:
 *    - Corrige resource names como "files/abc123"
 *    - Evita gerar "files/files/abc123"
 *
 * 2. Gemini Files Polling:
 *    - Erros HTTP 4xx/5xx são tratados imediatamente
 *    - Estados FAILED são tratados imediatamente
 *    - Não fica preso falsamente em PROCESSANDO
 *
 * 3. Upload Gemini:
 *    - MP4 enviado por stream
 *    - Não carrega o arquivo inteiro na RAM
 *
 * MANTIDO
 * ------------------------------------------------------------
 * - Upload MP4 até 150 MB
 * - FFmpeg / FFprobe
 * - yt-dlp
 * - YouTube
 * - Gemini Interactions API
 * - Gemini Files API
 * - Fallback de modelos Gemini
 * - PIX Mercado Pago
 * - Autenticação
 * - Sessões
 * - Pontos / VIP
 * - Administração
 * - Download de cortes MP4
 * ============================================================
 */

"use strict";

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const VERSION = "13.2.8";
const PORT = Number(process.env.PORT || 10000);

/* ============================================================
 * CONFIGURAÇÕES
 * ========================================================== */

const MAX_UPLOAD_MB = 150;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DAILY_POINTS = 200;
const FREE_ANALYSIS_COST = 20;
const VIP_ANALYSIS_COST = 0;

const GEMINI_PRIMARY_MODEL =
    process.env.GEMINI_MODEL || "gemini-3.8-flash";

const GEMINI_FALLBACK_MODELS = (
    process.env.GEMINI_FALLBACK_MODELS ||
    "gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash"
)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const GEMINI_MODELS = [
    GEMINI_PRIMARY_MODEL,
    ...GEMINI_FALLBACK_MODELS.filter(
        (model) => model !== GEMINI_PRIMARY_MODEL
    )
];

const GEMINI_INTERACTIONS_URL =
    process.env.GEMINI_INTERACTIONS_URL ||
    "https://generativelanguage.googleapis.com/v1beta/interactions";

const GEMINI_UPLOAD_URL =
    process.env.GEMINI_UPLOAD_URL ||
    "https://generativelanguage.googleapis.com/upload/v1beta/files";

const GEMINI_FILES_API_URL =
    process.env.GEMINI_FILES_API_URL ||
    "https://generativelanguage.googleapis.com/v1beta/files";

const GEMINI_API_KEY =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    "";

const MERCADO_PAGO_ACCESS_TOKEN =
    process.env.MERCADO_PAGO_ACCESS_TOKEN ||
    process.env.MP_ACCESS_TOKEN ||
    "";

const MERCADO_PAGO_WEBHOOK_URL =
    process.env.MERCADO_PAGO_WEBHOOK_URL || "";

const ADMIN_EMAIL =
    process.env.ADMIN_EMAIL ||
    "admin@clipforge.local";

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD ||
    "admin123";

const RAPIDAPI_KEY =
    process.env.RAPIDAPI_KEY ||
    "";

const RAPIDAPI_HOST =
    process.env.RAPIDAPI_HOST ||
    "";

const YTDLP_COOKIES_FILE =
    process.env.YTDLP_COOKIES_FILE ||
    process.env.YOUTUBE_COOKIES_FILE ||
    "";

const YTDLP_TIMEOUT_MS = 12 * 60 * 1000;

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
 * APP
 * ========================================================== */

const app = express();

app.disable("x-powered-by");

app.use(
    cors({
        origin: true,
        credentials: true,
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: [
            "Content-Type",
            "Authorization",
            "X-User-Id",
            "X-Admin-Session"
        ]
    })
);

app.use(
    express.json({
        limit: "10mb"
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: "10mb"
    })
);

/* ============================================================
 * MEMÓRIA
 * ========================================================== */

const users = new Map();
const sessions = new Map();
const adminSessions = new Map();
const uploads = new Map();
const payments = new Map();

const metrics = {
    startedAt: Date.now(),
    requests: 0,
    analyses: 0,
    successfulAnalyses: 0,
    failedAnalyses: 0,
    uploads: 0,
    downloads: 0,
    pixCreated: 0,
    errors: 0
};

/* ============================================================
 * UTILITÁRIOS
 * ========================================================== */

function now() {
    return Date.now();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString("hex");
}

function randomId(prefix = "") {
    return `${prefix}${crypto.randomUUID()}`;
}

function parseNumber(value, fallback = 0) {
    const n = Number(value);

    return Number.isFinite(n)
        ? n
        : fallback;
}

function clamp(value, min, max) {
    return Math.min(
        Math.max(value, min),
        max
    );
}

function safeString(value, fallback = "") {
    if (value === null || value === undefined) {
        return fallback;
    }

    return String(value);
}

function safeUserId(value) {
    const id = safeString(value).trim();

    if (!id) {
        return null;
    }

    if (id.length < 6 || id.length > 200) {
        return null;
    }

    return id;
}

function jsonError(res, status, message, extra = {}) {
    return res.status(status).json({
        ok: false,
        error: message,
        ...extra
    });
}

function redactSecrets(value) {
    const text = safeString(value);

    return text
        .replace(
            /([?&](?:key|api_key|access_token|token)=)[^&]+/gi,
            "$1[REDACTED]"
        )
        .replace(
            /(Bearer\s+)[A-Za-z0-9._-]+/gi,
            "$1[REDACTED]"
        );
}

async function safeRemove(filePath) {
    if (!filePath) {
        return;
    }

    try {
        await fsp.rm(filePath, {
            force: true,
            recursive: true
        });
    } catch (_) {
        // Ignorado propositalmente.
    }
}

async function ensureDirectories() {
    await fsp.mkdir(TEMP_ROOT, {
        recursive: true
    });

    await fsp.mkdir(UPLOAD_DIR, {
        recursive: true
    });

    await fsp.mkdir(OUTPUT_DIR, {
        recursive: true
    });
}

function getFileExtension(filePath) {
    return path.extname(filePath || "").toLowerCase();
}

/* ============================================================
 * PROCESSOS
 * ========================================================== */

function spawnCapture(
    command,
    args = [],
    options = {}
) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            command,
            args,
            {
                windowsHide: true,
                ...options
            }
        );

        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        child.on("error", (error) => {
            reject(error);
        });

        child.on("close", (code, signal) => {
            resolve({
                code,
                signal,
                stdout,
                stderr
            });
        });
    });
}

async function commandExists(command, args = ["-version"]) {
    try {
        const result = await spawnCapture(
            command,
            args
        );

        return (
            result.code === 0 ||
            Boolean(result.stdout) ||
            Boolean(result.stderr)
        );
    } catch (_) {
        return false;
    }
}

async function resolveExecutable(
    candidates,
    testArgs = ["-version"]
) {
    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }

        try {
            const exists = await commandExists(
                candidate,
                testArgs
            );

            if (exists) {
                return candidate;
            }
        } catch (_) {
            // continua
        }
    }

    return null;
}

/* ============================================================
 * FFmpeg / FFprobe
 * ========================================================== */

let FFMPEG_PATH = null;
let FFPROBE_PATH = null;
let YTDLP_PATH = null;

async function resolveBinaries() {
    const ffmpegCandidates = [];

    try {
        const ffmpegInstaller =
            require("@ffmpeg-installer/ffmpeg");

        ffmpegCandidates.push(
            ffmpegInstaller.path
        );
    } catch (_) {}

    try {
        const ffmpegStatic =
            require("ffmpeg-static");

        ffmpegCandidates.push(
            ffmpegStatic
        );
    } catch (_) {}

    ffmpegCandidates.push(
        process.env.FFMPEG_PATH,
        "ffmpeg"
    );

    const ffprobeCandidates = [];

    try {
        const ffprobeInstaller =
            require("@ffprobe-installer/ffprobe");

        ffprobeCandidates.push(
            ffprobeInstaller.path
        );
    } catch (_) {}

    ffprobeCandidates.push(
        process.env.FFPROBE_PATH,
        "ffprobe"
    );

    const ytdlpCandidates = [
        process.env.YTDLP_PATH,
        process.env.YT_DLP_PATH,
        "yt-dlp"
    ];

    FFMPEG_PATH = await resolveExecutable(
        ffmpegCandidates,
        ["-version"]
    );

    FFPROBE_PATH = await resolveExecutable(
        ffprobeCandidates,
        ["-version"]
    );

    YTDLP_PATH = await resolveExecutable(
        ytdlpCandidates,
        ["--version"]
    );

    console.log(
        "[Binaries] FFmpeg:",
        FFMPEG_PATH || "NÃO ENCONTRADO"
    );

    console.log(
        "[Binaries] FFprobe:",
        FFPROBE_PATH || "NÃO ENCONTRADO"
    );

    console.log(
        "[Binaries] yt-dlp:",
        YTDLP_PATH || "NÃO ENCONTRADO"
    );
}

/* ============================================================
 * FFPROBE
 * ========================================================== */

async function getVideoMetadata(filePath) {
    if (!FFPROBE_PATH) {
        throw new Error(
            "FFprobe não está disponível no servidor."
        );
    }

    const result = await spawnCapture(
        FFPROBE_PATH,
        [
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            filePath
        ]
    );

    if (result.code !== 0) {
        throw new Error(
            `FFprobe falhou: ${result.stderr || result.stdout}`
        );
    }

    let data;

    try {
        data = JSON.parse(result.stdout);
    } catch (_) {
        throw new Error(
            "FFprobe retornou JSON inválido."
        );
    }

    const format = data.format || {};

    const duration = parseNumber(
        format.duration,
        0
    );

    const streams = Array.isArray(data.streams)
        ? data.streams
        : [];

    const videoStream =
        streams.find(
            (stream) =>
                stream.codec_type === "video"
        ) || null;

    const audioStream =
        streams.find(
            (stream) =>
                stream.codec_type === "audio"
        ) || null;

    return {
        duration,
        format: format.format_name || null,
        size: parseNumber(format.size, 0),
        videoCodec:
            videoStream?.codec_name || null,
        audioCodec:
            audioStream?.codec_name || null,
        width:
            parseNumber(videoStream?.width, 0),
        height:
            parseNumber(videoStream?.height, 0),
        fps:
            videoStream?.r_frame_rate || null
    };
}

async function validateVideoFile(filePath) {
    if (!filePath) {
        throw new Error(
            "Arquivo de vídeo não informado."
        );
    }

    const stat = await fsp.stat(filePath);

    if (!stat.isFile()) {
        throw new Error(
            "O caminho informado não é um arquivo."
        );
    }

    if (stat.size <= 0) {
        throw new Error(
            "O arquivo de vídeo está vazio."
        );
    }

    if (stat.size > MAX_UPLOAD_BYTES) {
        throw new Error(
            `O vídeo excede o limite de ${MAX_UPLOAD_MB} MB.`
        );
    }

    const metadata =
        await getVideoMetadata(filePath);

    if (!metadata.duration || metadata.duration <= 0) {
        throw new Error(
            "Não foi possível obter a duração do vídeo."
        );
    }

    return metadata;
}

/* ============================================================
 * MULTER
 * ========================================================== */

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOAD_DIR);
    },

    filename: function (req, file, cb) {
        const ext =
            getFileExtension(file.originalname) ||
            ".mp4";

        cb(
            null,
            `${randomId("upload_")}${ext}`
        );
    }
});

const videoUpload = multer({
    storage,

    limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: 1
    },

    fileFilter: function (req, file, cb) {
        const mime =
            safeString(file.mimetype)
                .toLowerCase();

        const name =
            safeString(file.originalname)
                .toLowerCase();

        const validMime =
            mime === "video/mp4" ||
            mime.startsWith("video/");

        const validExtension =
            name.endsWith(".mp4") ||
            name.endsWith(".mov") ||
            name.endsWith(".mkv") ||
            name.endsWith(".webm") ||
            name.endsWith(".avi");

        if (!validMime && !validExtension) {
            return cb(
                new Error(
                    "Formato de vídeo não suportado."
                )
            );
        }

        cb(null, true);
    }
});

/* ============================================================
 * LIMPEZA DE UPLOADS
 * ========================================================== */

async function cleanupExpiredUploads() {
    const expiration =
        now() - UPLOAD_TTL_MS;

    for (const [id, upload] of uploads.entries()) {
        if (
            upload.createdAt < expiration ||
            !upload.filePath
        ) {
            await safeRemove(
                upload.filePath
            );

            uploads.delete(id);
        }
    }
}

setInterval(
    () => {
        cleanupExpiredUploads()
            .catch((error) => {
                console.error(
                    "[Cleanup]",
                    error.message
                );
            });
    },
    15 * 60 * 1000
).unref();

/* ============================================================
 * YOUTUBE
 * ========================================================== */

function isYouTubeUrl(value) {
    try {
        const url = new URL(value);

        const host =
            url.hostname.toLowerCase();

        return (
            host === "youtube.com" ||
            host === "www.youtube.com" ||
            host === "m.youtube.com" ||
            host === "youtu.be" ||
            host.endsWith(".youtube.com")
        );
    } catch (_) {
        return false;
    }
}

function normalizeYouTubeUrl(value) {
    const text =
        safeString(value).trim();

    if (!text) {
        return null;
    }

    if (!isYouTubeUrl(text)) {
        return null;
    }

    return text;
}

async function getYouTubeInfo(url) {
    if (!YTDLP_PATH) {
        return null;
    }

    const args = [
        "--dump-single-json",
        "--skip-download",
        "--no-warnings",
        "--no-playlist",
        url
    ];

    if (YTDLP_COOKIES_FILE) {
        args.splice(
            2,
            0,
            "--cookies",
            YTDLP_COOKIES_FILE
        );
    }

    try {
        const result =
            await spawnCapture(
                YTDLP_PATH,
                args
            );

        if (result.code !== 0) {
            console.warn(
                "[yt-dlp] info falhou:",
                redactSecrets(
                    result.stderr
                )
            );

            return null;
        }

        return JSON.parse(
            result.stdout
        );
    } catch (error) {
        console.warn(
            "[yt-dlp] info exception:",
            error.message
        );

        return null;
    }
}

/* ============================================================
 * DOWNLOAD ORIGINAL
 * ========================================================== */

async function downloadWithYtDlp(
    url,
    outputPath
) {
    if (!YTDLP_PATH) {
        throw new Error(
            "yt-dlp não está disponível."
        );
    }

    const args = [
        "--no-playlist",
        "--no-warnings",
        "--restrict-filenames",
        "-f",
        "bv*+ba/b",
        "--merge-output-format",
        "mp4",
        "-o",
        outputPath,
        url
    ];

    if (YTDLP_COOKIES_FILE) {
        args.splice(
            3,
            0,
            "--cookies",
            YTDLP_COOKIES_FILE
        );
    }

    console.log(
        "[yt-dlp] Iniciando download:",
        redactSecrets(url)
    );

    const result =
        await spawnCapture(
            YTDLP_PATH,
            args
        );

    if (result.code !== 0) {
        throw new Error(
            `yt-dlp falhou: ${
                result.stderr ||
                result.stdout ||
                "erro desconhecido"
            }`
        );
    }

    await fsp.access(
        outputPath
    );

    return outputPath;
}

async function downloadWithRapidApi(
    url,
    outputPath
) {
    if (
        !RAPIDAPI_KEY ||
        !RAPIDAPI_HOST
    ) {
        throw new Error(
            "RapidAPI não configurada."
        );
    }

    /*
     * Mantido como fallback opcional.
     *
     * O formato da resposta varia conforme a API
     * contratada. Tentamos extrair URLs comuns.
     */

    const endpoint =
        process.env.RAPIDAPI_YOUTUBE_URL;

    if (!endpoint) {
        throw new Error(
            "RAPIDAPI_YOUTUBE_URL não configurada."
        );
    }

    const apiUrl =
        new URL(endpoint);

    apiUrl.searchParams.set(
        "url",
        url
    );

    const response =
        await fetch(
            apiUrl,
            {
                headers: {
                    "x-rapidapi-key":
                        RAPIDAPI_KEY,
                    "x-rapidapi-host":
                        RAPIDAPI_HOST
                },
                signal:
                    AbortSignal.timeout(
                        120000
                    )
            }
        );

    const text =
        await response.text();

    if (!response.ok) {
        throw new Error(
            `RapidAPI HTTP ${response.status}: ${text.slice(
                0,
                1000
            )}`
        );
    }

    let data;

    try {
        data = JSON.parse(text);
    } catch (_) {
        throw new Error(
            "RapidAPI retornou JSON inválido."
        );
    }

    const directUrl =
        data?.url ||
        data?.videoUrl ||
        data?.downloadUrl ||
        data?.data?.url ||
        data?.data?.videoUrl ||
        data?.result?.url ||
        data?.result?.videoUrl;

    if (!directUrl) {
        throw new Error(
            "RapidAPI não retornou uma URL de vídeo."
        );
    }

    const videoResponse =
        await fetch(
            directUrl,
            {
                signal:
                    AbortSignal.timeout(
                        120000
                    )
            }
        );

    if (!videoResponse.ok) {
        throw new Error(
            `Download RapidAPI HTTP ${videoResponse.status}.`
        );
    }

    const fileStream =
        fs.createWriteStream(
            outputPath
        );

    if (!videoResponse.body) {
        throw new Error(
            "RapidAPI não retornou stream de vídeo."
        );
    }

    await new Promise(
        (resolve, reject) => {
            const reader =
                videoResponse.body.getReader();

            fileStream.on(
                "finish",
                resolve
            );

            fileStream.on(
                "error",
                reject
            );

            (async () => {
                try {
                    while (true) {
                        const {
                            done,
                            value
                        } =
                            await reader.read();

                        if (done) {
                            fileStream.end();
                            break;
                        }

                        fileStream.write(
                            Buffer.from(value)
                        );
                    }
                } catch (error) {
                    fileStream.destroy(
                        error
                    );

                    reject(error);
                }
            })();
        }
    );

    return outputPath;
}

async function downloadOriginalVideo(
    url
) {
    const tempName =
        `${randomId("source_")}.mp4`;

    const outputPath =
        path.join(
            TEMP_ROOT,
            tempName
        );

    let lastError = null;

    /*
     * yt-dlp é o método principal.
     */

    try {
        await downloadWithYtDlp(
            url,
            outputPath
        );

        const metadata =
            await validateVideoFile(
                outputPath
            );

        console.log(
            "[Download] yt-dlp OK:",
            metadata.duration,
            "segundos"
        );

        return {
            filePath: outputPath,
            metadata
        };
    } catch (error) {
        lastError = error;

        console.warn(
            "[Download] yt-dlp falhou:",
            error.message
        );

        await safeRemove(
            outputPath
        );
    }

    /*
     * RapidAPI como fallback opcional.
     */

    if (
        RAPIDAPI_KEY &&
        RAPIDAPI_HOST &&
        process.env.RAPIDAPI_YOUTUBE_URL
    ) {
        try {
            await downloadWithRapidApi(
                url,
                outputPath
            );

            const metadata =
                await validateVideoFile(
                    outputPath
                );

            console.log(
                "[Download] RapidAPI OK:",
                metadata.duration,
                "segundos"
            );

            return {
                filePath: outputPath,
                metadata
            };
        } catch (error) {
            lastError = error;

            console.warn(
                "[Download] RapidAPI falhou:",
                error.message
            );

            await safeRemove(
                outputPath
            );
        }
    }

    throw new Error(
        `Não foi possível baixar o vídeo do YouTube. ${
            lastError?.message || ""
        }`
    );
}

/* ============================================================
 * AUTENTICAÇÃO
 * ========================================================== */

function createUser({
    email,
    name
}) {
    const normalizedEmail =
        safeString(email)
            .trim()
            .toLowerCase();

    const existing =
        Array.from(
            users.values()
        ).find(
            (user) =>
                user.email ===
                normalizedEmail
        );

    if (existing) {
        return existing;
    }

    const user = {
        id: randomId("user_"),
        userId: randomId("user_"),
        email:
            normalizedEmail ||
            `${randomToken(6)}@clipforge.local`,
        name:
            safeString(name).trim() ||
            "Usuário ClipForge",
        pontos: 200,
        isVip: false,
        createdAt: now(),
        lastDailyClaim: now()
    };

    users.set(
        user.id,
        user
    );

    return user;
}

function createSession(user) {
    const token =
        randomToken(48);

    sessions.set(
        token,
        {
            token,
            userId: user.id,
            createdAt: now(),
            expiresAt:
                now() +
                SESSION_TTL_MS
        }
    );

    return token;
}

function getUserFromToken(token) {
    if (!token) {
        return null;
    }

    const session =
        sessions.get(token);

    if (!session) {
        return null;
    }

    if (
        session.expiresAt < now()
    ) {
        sessions.delete(token);
        return null;
    }

    return (
        users.get(
            session.userId
        ) || null
    );
}

function extractBearerToken(req) {
    const authorization =
        safeString(
            req.headers.authorization
        );

    if (
        authorization
            .toLowerCase()
            .startsWith("bearer ")
    ) {
        return authorization
            .slice(7)
            .trim();
    }

    return null;
}

function getAuthenticatedUser(req) {
    const token =
        extractBearerToken(req);

    const tokenUser =
        getUserFromToken(token);

    if (tokenUser) {
        return tokenUser;
    }

    /*
     * Compatibilidade com frontend antigo.
     */

    const headerUserId =
        safeUserId(
            req.headers["x-user-id"]
        );

    if (headerUserId) {
        return (
            users.get(headerUserId) ||
            Array.from(
                users.values()
            ).find(
                (user) =>
                    user.userId ===
                    headerUserId
            ) ||
            null
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
        getAuthenticatedUser(req);

    if (!user) {
        return jsonError(
            res,
            401,
            "Usuário não autenticado."
        );
    }

    req.user = user;

    next();
}

function claimDailyPoints(user) {
    const elapsed =
        now() -
        Number(
            user.lastDailyClaim || 0
        );

    if (
        elapsed >=
        24 * 60 * 60 * 1000
    ) {
        user.pontos += DAILY_POINTS;
        user.lastDailyClaim = now();

        return DAILY_POINTS;
    }

    return 0;
}

/* ============================================================
 * UPLOAD OWNERSHIP
 * ========================================================== */

function getOwnedUpload(
    user,
    uploadId
) {
    const upload =
        uploads.get(uploadId);

    if (!upload) {
        return null;
    }

    if (
        upload.userId !== user.id
    ) {
        return null;
    }

    return upload;
}

/* ============================================================
 * GEMINI SCHEMA
 * ========================================================== */

const CLIPS_SCHEMA = {
    type: "object",

    properties: {
        clips: {
            type: "array",

            items: {
                type: "object",

                properties: {
                    start: {
                        type: "number"
                    },

                    end: {
                        type: "number"
                    },

                    duration: {
                        type: "number"
                    },

                    title: {
                        type: "string"
                    },

                    description: {
                        type: "string"
                    },

                    score: {
                        type: "number"
                    }
                },

                required: [
                    "start",
                    "end",
                    "duration",
                    "title",
                    "description",
                    "score"
                ]
            }
        }
    },

    required: [
        "clips"
    ]
};

/* ============================================================
 * NORMALIZAÇÃO GEMINI
 * ========================================================== */

function normalizeGeminiClips(
    value,
    videoDuration = null
) {
    let rawClips = [];

    if (Array.isArray(value)) {
        rawClips = value;
    } else if (
        Array.isArray(
            value?.clips
        )
    ) {
        rawClips = value.clips;
    } else if (
        Array.isArray(
            value?.cortes
        )
    ) {
        rawClips = value.cortes;
    } else if (
        Array.isArray(
            value?.results
        )
    ) {
        rawClips = value.results;
    }

    const clips = [];

    for (
        const item of rawClips
    ) {
        if (!item) {
            continue;
        }

        let start =
            parseNumber(
                item.start ??
                item.inicio ??
                item.startTime,
                NaN
            );

        let end =
            parseNumber(
                item.end ??
                item.fim ??
                item.endTime,
                NaN
            );

        let duration =
            parseNumber(
                item.duration ??
                item.duracao,
                NaN
            );

        if (!Number.isFinite(start)) {
            start = 0;
        }

        start = Math.max(
            0,
            start
        );

        if (
            !Number.isFinite(duration) ||
            duration <= 0
        ) {
            if (
                Number.isFinite(end) &&
                end > start
            ) {
                duration =
                    end - start;
            } else {
                duration = 30;
            }
        }

        duration = clamp(
            duration,
            1,
            120
        );

        end =
            start +
            duration;

        if (
            Number.isFinite(
                videoDuration
            ) &&
            videoDuration > 0
        ) {
            if (
                start >=
                videoDuration
            ) {
                continue;
            }

            end =
                Math.min(
                    end,
                    videoDuration
                );

            duration =
                Math.max(
                    1,
                    end - start
                );
        }

        let score =
            parseNumber(
                item.score ??
                item.pontuacao ??
                item.rating,
                0
            );

        score = clamp(
            score,
            0,
            100
        );

        const title =
            safeString(
                item.title ??
                item.titulo,
                "Corte recomendado"
            ).trim();

        const description =
            safeString(
                item.description ??
                item.descricao ??
                item.reason ??
                item.motivo,
                ""
            ).trim();

        clips.push({
            start:
                Number(
                    start.toFixed(3)
                ),

            end:
                Number(
                    end.toFixed(3)
                ),

            duration:
                Number(
                    duration.toFixed(3)
                ),

            title:
                title ||
                "Corte recomendado",

            description,

            score:
                Number(
                    score.toFixed(1)
                )
        });
    }

    return clips;
}

/* ============================================================
 * PARSER GEMINI
 * ========================================================== */

function parseGeminiOutput(data) {
    if (!data) {
        throw new Error(
            "Resposta vazia do Gemini."
        );
    }

    const candidates = [];

    candidates.push(
        data.output
    );

    candidates.push(
        data.response
    );

    candidates.push(
        data.result
    );

    candidates.push(
        data.text
    );

    candidates.push(
        data.content
    );

    candidates.push(
        data
    );

    function inspect(value) {
        if (!value) {
            return null;
        }

        if (
            typeof value ===
            "object"
        ) {
            if (
                Array.isArray(
                    value.clips
                )
            ) {
                return value;
            }

            if (
                Array.isArray(
                    value.cortes
                )
            ) {
                return value;
            }

            if (
                Array.isArray(
                    value.results
                )
            ) {
                return value;
            }

            if (
                typeof value.text ===
                "string"
            ) {
                return inspect(
                    value.text
                );
            }

            if (
                Array.isArray(value)
            ) {
                for (
                    const item of value
                ) {
                    const found =
                        inspect(item);

                    if (found) {
                        return found;
                    }
                }
            }
        }

        if (
            typeof value ===
            "string"
        ) {
            let text =
                value.trim();

            text =
                text.replace(
                    /^```(?:json)?/i,
                    ""
                );

            text =
                text.replace(
                    /```$/i,
                    ""
                );

            text =
                text.trim();

            try {
                return JSON.parse(
                    text
                );
            } catch (_) {}

            const firstBrace =
                text.indexOf("{");

            const lastBrace =
                text.lastIndexOf("}");

            if (
                firstBrace >= 0 &&
                lastBrace >
                    firstBrace
            ) {
                const candidate =
                    text.slice(
                        firstBrace,
                        lastBrace + 1
                    );

                try {
                    return JSON.parse(
                        candidate
                    );
                } catch (_) {}
            }

            const firstBracket =
                text.indexOf("[");

            const lastBracket =
                text.lastIndexOf("]");

            if (
                firstBracket >= 0 &&
                lastBracket >
                    firstBracket
            ) {
                const candidate =
                    text.slice(
                        firstBracket,
                        lastBracket + 1
                    );

                try {
                    return JSON.parse(
                        candidate
                    );
                } catch (_) {}
            }
        }

        return null;
    }

    for (
        const candidate of candidates
    ) {
        const parsed =
            inspect(candidate);

        if (parsed) {
            return parsed;
        }
    }

    throw new Error(
        "Não foi possível interpretar a resposta do Gemini."
    );
}

/* ============================================================
 * PROMPT
 * ========================================================== */

function buildClipPrompt(
    videoDuration = null
) {
    const durationText =
        Number.isFinite(
            videoDuration
        )
            ? `${videoDuration.toFixed(
                  1
              )} segundos`
            : "duração desconhecida";

    return `
Você é um especialista em edição de vídeos curtos para redes sociais.

Analise o vídeo inteiro e encontre os melhores momentos para criar cortes verticais/shorts.

Duração aproximada do vídeo:
${durationText}

REGRAS:

1. Encontre momentos realmente interessantes.
2. Priorize trechos com:
   - gancho forte;
   - informação útil;
   - emoção;
   - surpresa;
   - humor;
   - opinião forte;
   - história;
   - conflito;
   - revelação;
   - frase memorável;
   - potencial de retenção.
3. Evite introduções vazias.
4. Evite trechos sem contexto.
5. Evite pausas longas.
6. Cada corte deve normalmente ter entre 20 e 60 segundos.
7. Não invente falas.
8. Os tempos devem corresponder ao vídeo.
9. Escolha de 3 a 8 cortes.
10. Dê uma nota de 0 a 100 para o potencial do corte.
11. Explique brevemente por que o momento é interessante.

RESPONDA SOMENTE EM JSON COMPATÍVEL COM O SCHEMA FORNECIDO.

Cada corte deve possuir:

start
end
duration
title
description
score
`;
}

/* ============================================================
 * GEMINI FILES — UPLOAD
 * ========================================================== */

/**
 * Extrai o upload URL retornado pelo Google.
 */
function getGeminiUploadUrl(
    response
) {
    return (
        response.headers.get(
            "x-goog-upload-url"
        ) ||
        response.headers.get(
            "X-Goog-Upload-URL"
        )
    );
}

function normalizeGeminiFileId(
    fileName
) {
    let resource =
        safeString(
            fileName
        ).trim();

    resource =
        resource.replace(
            /^\/+/,
            ""
        );

    /*
     * Correção 13.2.8:
     *
     * Se Gemini retorna:
     *
     * files/abc123
     *
     * nós precisamos usar somente:
     *
     * abc123
     *
     * ao montar:
     *
     * /files/abc123
     *
     * e nunca:
     *
     * /files/files/abc123
     */

    if (
        resource.startsWith(
            "files/"
        )
    ) {
        resource =
            resource.slice(
                "files/".length
            );
    }

    resource =
        resource.split(
            "/"
        ).pop();

    return resource;
}

async function uploadVideoToGemini(
    filePath
) {
    if (!GEMINI_API_KEY) {
        throw new Error(
            "GEMINI_API_KEY não configurada no servidor."
        );
    }

    const stat =
        await fsp.stat(
            filePath
        );

    if (
        !stat.isFile()
    ) {
        throw new Error(
            "Arquivo Gemini inválido."
        );
    }

    console.log(
        `[Gemini Files] Preparando upload: ${(
            stat.size /
            1024 /
            1024
        ).toFixed(2)} MB`
    );

    /*
     * --------------------------------------------------------
     * PASSO 1 — INICIALIZAÇÃO RESUMABLE
     * --------------------------------------------------------
     */

    const initResponse =
        await fetch(
            GEMINI_UPLOAD_URL,
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
                        String(
                            stat.size
                        ),

                    "X-Goog-Upload-Header-Content-Type":
                        "video/mp4",

                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({
                    file: {
                        display_name:
                            path.basename(
                                filePath
                            )
                    }
                }),

                signal:
                    AbortSignal.timeout(
                        120000
                    )
            }
        );

    if (!initResponse.ok) {
        const body =
            await initResponse.text();

        throw new Error(
            `Gemini Files init HTTP ${initResponse.status}: ${body.slice(
                0,
                2000
            )}`
        );
    }

    const uploadUrl =
        getGeminiUploadUrl(
            initResponse
        );

    if (!uploadUrl) {
        throw new Error(
            "Gemini não retornou a URL resumable de upload."
        );
    }

    /*
     * --------------------------------------------------------
     * PASSO 2 — UPLOAD POR STREAM
     * --------------------------------------------------------
     *
     * Correção 13.2.8:
     *
     * Não usamos readFile().
     *
     * O MP4 vai direto do disco para o fetch.
     */

    const stream =
        fs.createReadStream(
            filePath
        );

    const uploadResponse =
        await fetch(
            uploadUrl,
            {
                method: "POST",

                headers: {
                    "Content-Length":
                        String(
                            stat.size
                        ),

                    "X-Goog-Upload-Offset":
                        "0",

                    "X-Goog-Upload-Command":
                        "upload, finalize",

                    "Content-Type":
                        "video/mp4"
                },

                body: stream,

                /*
                 * Node.js 20+
                 */
                duplex: "half",

                signal:
                    AbortSignal.timeout(
                        15 * 60 * 1000
                    )
            }
        );

    if (!uploadResponse.ok) {
        const body =
            await uploadResponse.text();

        throw new Error(
            `Gemini Files upload HTTP ${uploadResponse.status}: ${body.slice(
                0,
                2000
            )}`
        );
    }

    let uploadData;

    try {
        uploadData =
            await uploadResponse.json();
    } catch (error) {
        throw new Error(
            "Gemini Files retornou resposta JSON inválida após upload."
        );
    }

    const fileObject =
        uploadData?.file ||
        uploadData?.resource ||
        uploadData;

    const fileUri =
        fileObject?.uri ||
        fileObject?.file?.uri;

    const fileName =
        fileObject?.name ||
        fileObject?.file?.name;

    if (!fileUri) {
        throw new Error(
            `Gemini não retornou file.uri: ${JSON.stringify(
                uploadData
            ).slice(0, 3000)}`
        );
    }

    console.log(
        "[Gemini Files] Upload concluído."
    );

    console.log(
        "[Gemini Files] URI:",
        fileUri
    );

    console.log(
        "[Gemini Files] Name:",
        fileName || "(não informado)"
    );

    /*
     * --------------------------------------------------------
     * PASSO 3 — POLLING
     * --------------------------------------------------------
     */

    let activeFile = null;

    const startPolling =
        now();

    const pollingTimeout =
        10 * 60 * 1000;

    const fileId =
        normalizeGeminiFileId(
            fileName ||
                fileUri
        );

    if (!fileId) {
        throw new Error(
            "Não foi possível determinar o ID do arquivo Gemini."
        );
    }

    /*
     * Correção importante:
     *
     * GEMINI_FILES_API_URL termina em /files.
     *
     * fileId precisa ser somente abc123.
     */

    const statusUrl =
        `${GEMINI_FILES_API_URL}/${encodeURIComponent(
            fileId
        )}`;

    console.log(
        "[Gemini Files] Polling:",
        statusUrl
    );

    while (
        now() -
            startPolling <
        pollingTimeout
    ) {
        await sleep(5000);

        const checkResponse =
            await fetch(
                statusUrl,
                {
                    method: "GET",

                    headers: {
                        "x-goog-api-key":
                            GEMINI_API_KEY
                    },

                    signal:
                        AbortSignal.timeout(
                            60000
                        )
                }
            );

        /*
         * Correção 13.2.8:
         *
         * 404/500/etc. NÃO pode virar
         * "PROCESSANDO".
         */

        if (!checkResponse.ok) {
            const body =
                await checkResponse.text();

            throw new Error(
                `Gemini Files polling HTTP ${checkResponse.status}: ${body.slice(
                    0,
                    3000
                )}`
            );
        }

        let checkData;

        try {
            checkData =
                await checkResponse.json();
        } catch (_) {
            throw new Error(
                "Gemini Files polling retornou JSON inválido."
            );
        }

        const file =
            checkData?.file ||
            checkData;

        const state =
            safeString(
                file?.state
            ).toUpperCase();

        const elapsed =
            Math.round(
                (
                    now() -
                    startPolling
                ) / 1000
            );

        console.log(
            `[Gemini Files] Estado: ${
                state || "DESCONHECIDO"
            } | ${elapsed}s`
        );

        if (
            state ===
            "ACTIVE"
        ) {
            activeFile =
                file;

            break;
        }

        if (
            state ===
            "FAILED"
        ) {
            const message =
                file?.error?.message ||
                checkData?.error?.message ||
                file?.error ||
                checkData?.error ||
                "Gemini Files informou FAILED.";

            throw new Error(
                `Gemini Files FAILED: ${safeString(
                    message
                )}`
            );
        }

        /*
         * Alguns retornos podem não fornecer state.
         * Se já houver URI e o recurso não indicar
         * PROCESSING, continuamos consultando.
         */
    }

    if (!activeFile) {
        throw new Error(
            "Tempo limite excedido aguardando o Gemini processar o vídeo."
        );
    }

    const finalUri =
        activeFile?.uri ||
        fileUri;

    const finalName =
        activeFile?.name ||
        fileName ||
        `files/${fileId}`;

    console.log(
        "[Gemini Files] Vídeo ACTIVE."
    );

    return {
        uri: finalUri,
        name: finalName,
        fileId
    };
}

/* ============================================================
 * GEMINI INTERACTIONS
 * ========================================================== */

async function requestGeminiInteraction({
    model,
    input
}) {
    if (!GEMINI_API_KEY) {
        throw new Error(
            "GEMINI_API_KEY não configurada."
        );
    }

    const controller =
        new AbortController();

    const timeout =
        setTimeout(
            () => controller.abort(),
            120000
        );

    try {
        const response =
            await fetch(
                GEMINI_INTERACTIONS_URL,
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json",

                        "x-goog-api-key":
                            GEMINI_API_KEY
                    },

                    body: JSON.stringify({
                        model,

                        input,

                        response_format: {
                            type:
                                "json_schema",

                            json_schema:
                                CLIPS_SCHEMA
                        }
                    }),

                    signal:
                        controller.signal
                }
            );

        const text =
            await response.text();

        if (!response.ok) {
            throw new Error(
                `Gemini Interactions HTTP ${response.status}: ${text.slice(
                    0,
                    4000
                )}`
            );
        }

        let data;

        try {
            data =
                JSON.parse(text);
        } catch (_) {
            throw new Error(
                "Gemini Interactions retornou JSON inválido."
            );
        }

        return data;
    } finally {
        clearTimeout(timeout);
    }
}

/* ============================================================
 * GEMINI FALLBACK
 * ========================================================== */

async function analyzeWithGeminiFallback({
    input,
    videoDuration
}) {
    if (!GEMINI_API_KEY) {
        throw new Error(
            "GEMINI_API_KEY não configurada no Render."
        );
    }

    const errors = [];

    for (
        const model of GEMINI_MODELS
    ) {
        try {
            console.log(
                `[Gemini] Tentando modelo: ${model}`
            );

            const response =
                await requestGeminiInteraction({
                    model,
                    input
                });

            const parsed =
                parseGeminiOutput(
                    response
                );

            const clips =
                normalizeGeminiClips(
                    parsed,
                    videoDuration
                );

            if (!clips.length) {
                throw new Error(
                    "Gemini não retornou cortes válidos."
                );
            }

            console.log(
                `[Gemini] Modelo ${model} retornou ${clips.length} cortes.`
            );

            return {
                model,
                clips,
                raw: response
            };
        } catch (error) {
            console.error(
                `[Gemini] Modelo ${model} falhou:`,
                error.message
            );

            errors.push(
                `${model}: ${error.message}`
            );
        }
    }

    throw new Error(
        `Todos os modelos Gemini falharam.\n${errors.join(
            "\n"
        )}`
    );
}

/* ============================================================
 * ANÁLISE DE YOUTUBE
 * ========================================================== */

async function analyzeYouTubeUrl(
    url
) {
    const normalized =
        normalizeYouTubeUrl(
            url
        );

    if (!normalized) {
        throw new Error(
            "URL do YouTube inválida."
        );
    }

    let videoDuration = null;

    try {
        const info =
            await getYouTubeInfo(
                normalized
            );

        if (info) {
            videoDuration =
                parseNumber(
                    info.duration,
                    null
                );

            console.log(
                "[YouTube] Título:",
                info.title || "(sem título)"
            );

            console.log(
                "[YouTube] Duração:",
                videoDuration || "desconhecida"
            );
        }
    } catch (_) {}

    const prompt =
        buildClipPrompt(
            videoDuration
        );

    /*
     * Gemini recebe a URL pública do YouTube
     * diretamente.
     */

    const input = [
        {
            type: "text",
            text: prompt
        },

        {
            type: "video",
            uri: normalized
        }
    ];

    return analyzeWithGeminiFallback({
        input,
        videoDuration
    });
}

/* ============================================================
 * ANÁLISE DE UPLOAD
 * ========================================================== */

async function analyzeUploadedVideo(
    upload
) {
    if (!upload) {
        throw new Error(
            "Upload não encontrado."
        );
    }

    if (!upload.filePath) {
        throw new Error(
            "Arquivo do upload não está disponível."
        );
    }

    const metadata =
        upload.metadata ||
        await validateVideoFile(
            upload.filePath
        );

    upload.metadata =
        metadata;

    /*
     * Reaproveita o arquivo Gemini se já
     * tiver sido enviado anteriormente.
     */

    let geminiFile =
        upload.geminiFile;

    if (!geminiFile) {
        console.log(
            "[Gemini] Enviando MP4 para Gemini Files..."
        );

        geminiFile =
            await uploadVideoToGemini(
                upload.filePath
            );

        upload.geminiFile =
            geminiFile;
    } else {
        console.log(
            "[Gemini] Reutilizando arquivo Gemini já enviado."
        );
    }

    const prompt =
        buildClipPrompt(
            metadata.duration
        );

    const input = [
        {
            type: "text",
            text: prompt
        },

        {
            type: "video",
            uri: geminiFile.uri,
            mime_type: "video/mp4"
        }
    ];

    return analyzeWithGeminiFallback({
        input,
        videoDuration:
            metadata.duration
    });
}

/* ============================================================
 * CONTROLE DE PONTOS
 * ========================================================== */

function chargeAnalysis(
    user
) {
    const cost =
        user.isVip
            ? VIP_ANALYSIS_COST
            : FREE_ANALYSIS_COST;

    if (
        user.isVip
    ) {
        return {
            cost: 0,
            remaining:
                user.pontos
        };
    }

    if (
        user.pontos < cost
    ) {
        throw new Error(
            `Pontos insuficientes. Necessário: ${cost}. Disponível: ${user.pontos}.`
        );
    }

    user.pontos -= cost;

    return {
        cost,
        remaining:
            user.pontos
    };
}

/* ============================================================
 * UPLOAD
 * ========================================================== */

app.post(
    "/api/upload",
    requireUser,
    videoUpload.single("video"),
    async (req, res) => {
        try {
            if (!req.file) {
                return jsonError(
                    res,
                    400,
                    "Nenhum vídeo foi enviado."
                );
            }

            console.log(
                `[Upload] Recebido: ${req.file.originalname} (${(
                    req.file.size /
                    1024 /
                    1024
                ).toFixed(2)} MB)`
            );

            const metadata =
                await validateVideoFile(
                    req.file.path
                );

            const uploadId =
                randomId("upload_");

            const upload = {
                id: uploadId,
                userId: req.user.id,
                filePath:
                    req.file.path,
                originalName:
                    req.file.originalname,
                mimeType:
                    req.file.mimetype,
                size:
                    req.file.size,
                createdAt: now(),
                metadata,
                geminiFile: null
            };

            uploads.set(
                uploadId,
                upload
            );

            metrics.uploads++;

            return res.json({
                ok: true,

                uploadId,

                file: {
                    id: uploadId,
                    name:
                        upload.originalName,
                    size:
                        upload.size,
                    mimeType:
                        upload.mimeType
                },

                duration:
                    metadata.duration,

                metadata: {
                    duration:
                        metadata.duration,
                    width:
                        metadata.width,
                    height:
                        metadata.height,
                    videoCodec:
                        metadata.videoCodec,
                    audioCodec:
                        metadata.audioCodec,
                    fps:
                        metadata.fps
                }
            });
        } catch (error) {
            metrics.errors++;

            if (req.file?.path) {
                await safeRemove(
                    req.file.path
                );
            }

            console.error(
                "[Upload] Erro:",
                error
            );

            return jsonError(
                res,
                400,
                error.message ||
                    "Não foi possível processar o upload."
            );
        }
    }
);

/* ============================================================
 * CONSULTAR UPLOAD
 * ========================================================== */

app.get(
    "/api/upload/:id",
    requireUser,
    async (req, res) => {
        try {
            const upload =
                getOwnedUpload(
                    req.user,
                    req.params.id
                );

            if (!upload) {
                return jsonError(
                    res,
                    404,
                    "Upload não encontrado."
                );
            }

            return res.json({
                ok: true,

                upload: {
                    id:
                        upload.id,

                    originalName:
                        upload.originalName,

                    size:
                        upload.size,

                    mimeType:
                        upload.mimeType,

                    createdAt:
                        upload.createdAt,

                    duration:
                        upload.metadata
                            ?.duration ||
                        null,

                    metadata:
                        upload.metadata ||
                        null
                }
            });
        } catch (error) {
            return jsonError(
                res,
                500,
                error.message
            );
        }
    }
);

/* ============================================================
 * ANÁLISE
 * ========================================================== */

app.post(
    "/api/analisar",
    requireUser,
    async (req, res) => {
        const startedAt =
            now();

        metrics.analyses++;

        try {
            const {
                url,
                uploadId
            } = req.body || {};

            /*
             * ------------------------------------------------
             * UPLOAD
             * ------------------------------------------------
             */

            if (uploadId) {
                const upload =
                    getOwnedUpload(
                        req.user,
                        uploadId
                    );

                if (!upload) {
                    metrics.failedAnalyses++;

                    return jsonError(
                        res,
                        404,
                        "Upload não encontrado."
                    );
                }

                const charge =
                    chargeAnalysis(
                        req.user
                    );

                try {
                    console.log(
                        `[Análise] Upload ${uploadId}`
                    );

                    const result =
                        await analyzeUploadedVideo(
                            upload
                        );

                    metrics.successfulAnalyses++;

                    return res.json({
                        ok: true,

                        type: "upload",

                        uploadId,

                        clips:
                            result.clips,

                        model:
                            result.model,

                        pontos:
                            req.user.pontos,

                        charged:
                            charge.cost,

                        elapsedMs:
                            now() -
                            startedAt
                    });
                } catch (error) {
                    /*
                     * Devolve os pontos em caso
                     * de falha da análise.
                     */

                    req.user.pontos +=
                        charge.cost;

                    throw error;
                }
            }

            /*
             * ------------------------------------------------
             * YOUTUBE
             * ------------------------------------------------
             */

            if (url) {
                const normalized =
                    normalizeYouTubeUrl(
                        url
                    );

                if (!normalized) {
                    metrics.failedAnalyses++;

                    return jsonError(
                        res,
                        400,
                        "URL do YouTube inválida."
                    );
                }

                const charge =
                    chargeAnalysis(
                        req.user
                    );

                try {
                    console.log(
                        "[Análise] YouTube:",
                        redactSecrets(
                            normalized
                        )
                    );

                    const result =
                        await analyzeYouTubeUrl(
                            normalized
                        );

                    metrics.successfulAnalyses++;

                    return res.json({
                        ok: true,

                        type: "youtube",

                        url: normalized,

                        clips:
                            result.clips,

                        model:
                            result.model,

                        pontos:
                            req.user.pontos,

                        charged:
                            charge.cost,

                        elapsedMs:
                            now() -
                            startedAt
                    });
                } catch (error) {
                    req.user.pontos +=
                        charge.cost;

                    throw error;
                }
            }

            return jsonError(
                res,
                400,
                "Envie uma URL do YouTube ou um uploadId."
            );
        } catch (error) {
            metrics.failedAnalyses++;
            metrics.errors++;

            console.error(
                "[Análise] ERRO:",
                error
            );

            return jsonError(
                res,
                500,
                error.message ||
                    "Não foi possível analisar o vídeo."
            );
        }
    }
);

/* ============================================================
 * ROTA COMPATIBILIDADE
 * ========================================================== */

app.post(
    "/api/analisar-upload",
    requireUser,
    async (req, res) => {
        const startedAt =
            now();

        metrics.analyses++;

        try {
            const {
                uploadId
            } = req.body || {};

            if (!uploadId) {
                return jsonError(
                    res,
                    400,
                    "uploadId é obrigatório."
                );
            }

            const upload =
                getOwnedUpload(
                    req.user,
                    uploadId
                );

            if (!upload) {
                return jsonError(
                    res,
                    404,
                    "Upload não encontrado."
                );
            }

            const charge =
                chargeAnalysis(
                    req.user
                );

            try {
                const result =
                    await analyzeUploadedVideo(
                        upload
                    );

                metrics.successfulAnalyses++;

                return res.json({
                    ok: true,

                    type: "upload",

                    uploadId,

                    clips:
                        result.clips,

                    model:
                        result.model,

                    pontos:
                        req.user.pontos,

                    charged:
                        charge.cost,

                    elapsedMs:
                        now() -
                        startedAt
                });
            } catch (error) {
                req.user.pontos +=
                    charge.cost;

                throw error;
            }
        } catch (error) {
            metrics.failedAnalyses++;
            metrics.errors++;

            console.error(
                "[Análise Upload] ERRO:",
                error
            );

            return jsonError(
                res,
                500,
                error.message ||
                    "Não foi possível analisar o vídeo."
            );
        }
    }
);

/* ============================================================
 * RENDER DE CORTE
 * ========================================================== */

async function renderClip({
    inputPath,
    outputPath,
    start,
    duration
}) {
    if (!FFMPEG_PATH) {
        throw new Error(
            "FFmpeg não está disponível."
        );
    }

    const safeStart =
        Math.max(
            0,
            Number(start)
        );

    const safeDuration =
        Math.max(
            0.1,
            Number(duration)
        );

    console.log(
        `[FFmpeg] Corte start=${safeStart.toFixed(
            3
        )} duration=${safeDuration.toFixed(
            3
        )}`
    );

    const args = [
        "-hide_banner",
        "-loglevel",
        "error",

        "-ss",
        String(safeStart),

        "-i",
        inputPath,

        "-t",
        String(safeDuration),

        "-map",
        "0:v:0?",

        "-map",
        "0:a:0?",

        "-c:v",
        "libx264",

        "-preset",
        "veryfast",

        "-crf",
        "20",

        "-pix_fmt",
        "yuv420p",

        "-c:a",
        "aac",

        "-b:a",
        "128k",

        "-movflags",
        "+faststart",

        "-y",
        outputPath
    ];

    const result =
        await spawnCapture(
            FFMPEG_PATH,
            args
        );

    if (result.code !== 0) {
        throw new Error(
            `FFmpeg falhou: ${
                result.stderr ||
                result.stdout ||
                "erro desconhecido"
            }`
        );
    }

    const stat =
        await fsp.stat(
            outputPath
        );

    if (
        !stat.isFile() ||
        stat.size <= 0
    ) {
        throw new Error(
            "FFmpeg não gerou um MP4 válido."
        );
    }

    return {
        path: outputPath,
        size: stat.size
    };
}

/* ============================================================
 * DOWNLOAD MP4
 * ========================================================== */

app.post(
    "/api/download",
    requireUser,
    async (req, res) => {
        let temporarySource = null;
        let outputPath = null;

        try {
            const {
                start,
                duration,
                end,
                uploadId,
                url
            } = req.body || {};

            let sourcePath = null;
            let sourceDuration = null;

            /*
             * ------------------------------------------------
             * UPLOAD EXISTENTE
             * ------------------------------------------------
             */

            if (uploadId) {
                const upload =
                    getOwnedUpload(
                        req.user,
                        uploadId
                    );

                if (!upload) {
                    return jsonError(
                        res,
                        404,
                        "Upload não encontrado."
                    );
                }

                sourcePath =
                    upload.filePath;

                sourceDuration =
                    parseNumber(
                        upload.metadata
                            ?.duration,
                        0
                    );

                if (
                    !sourcePath ||
                    !fs.existsSync(
                        sourcePath
                    )
                ) {
                    return jsonError(
                        res,
                        404,
                        "Arquivo original não está mais disponível."
                    );
                }
            }

            /*
             * ------------------------------------------------
             * YOUTUBE
             * ------------------------------------------------
             */

            if (
                !sourcePath &&
                url
            ) {
                const normalized =
                    normalizeYouTubeUrl(
                        url
                    );

                if (!normalized) {
                    return jsonError(
                        res,
                        400,
                        "URL do YouTube inválida."
                    );
                }

                const downloaded =
                    await downloadOriginalVideo(
                        normalized
                    );

                sourcePath =
                    downloaded.filePath;

                sourceDuration =
                    downloaded.metadata
                        .duration;

                temporarySource =
                    sourcePath;
            }

            if (!sourcePath) {
                return jsonError(
                    res,
                    400,
                    "Informe uploadId ou url."
                );
            }

            /*
             * ------------------------------------------------
             * VALIDAÇÃO DE TEMPO
             * ------------------------------------------------
             */

            let safeStart =
                parseNumber(
                    start,
                    NaN
                );

            let safeDuration =
                parseNumber(
                    duration,
                    NaN
                );

            /*
             * Compatibilidade com frontend antigo:
             *
             * se duration não existir, usa end - start.
             */

            if (
                !Number.isFinite(
                    safeDuration
                ) &&
                Number.isFinite(
                    parseNumber(
                        end,
                        NaN
                    )
                )
            ) {
                safeDuration =
                    parseNumber(
                        end,
                        0
                    ) -
                    safeStart;
            }

            if (
                !Number.isFinite(
                    safeStart
                ) ||
                !Number.isFinite(
                    safeDuration
                )
            ) {
                return jsonError(
                    res,
                    400,
                    "start e duration são obrigatórios."
                );
            }

            safeStart =
                Math.max(
                    0,
                    safeStart
                );

            safeDuration =
                Math.max(
                    0.1,
                    safeDuration
                );

            if (
                sourceDuration > 0
            ) {
                if (
                    safeStart >=
                    sourceDuration
                ) {
                    return jsonError(
                        res,
                        400,
                        "O início do corte está além da duração do vídeo."
                    );
                }

                safeDuration =
                    Math.min(
                        safeDuration,
                        sourceDuration -
                            safeStart
                    );
            }

            /*
             * Limite de segurança.
             */

            safeDuration =
                Math.min(
                    safeDuration,
                    120
                );

            outputPath =
                path.join(
                    OUTPUT_DIR,
                    `${randomId(
                        "clip_"
                    )}.mp4`
                );

            await renderClip({
                inputPath:
                    sourcePath,

                outputPath,

                start:
                    safeStart,

                duration:
                    safeDuration
            });

            const stat =
                await fsp.stat(
                    outputPath
                );

            metrics.downloads++;

            /*
             * ------------------------------------------------
             * MP4 DIRETO
             * ------------------------------------------------
             *
             * O frontend espera response.blob().
             */

            res.status(200);

            res.setHeader(
                "Content-Type",
                "video/mp4"
            );

            res.setHeader(
                "Content-Disposition",
                `attachment; filename="clipforge-${Date.now()}.mp4"`
            );

            res.setHeader(
                "Content-Length",
                String(
                    stat.size
                )
            );

            res.setHeader(
                "Cache-Control",
                "no-store"
            );

            const stream =
                fs.createReadStream(
                    outputPath
                );

            stream.on(
                "error",
                (error) => {
                    console.error(
                        "[Download] Stream error:",
                        error.message
                    );

                    if (
                        !res.headersSent
                    ) {
                        res.status(500)
                            .json({
                                ok: false,
                                error:
                                    "Erro ao transmitir o MP4."
                            });
                    } else {
                        res.destroy(
                            error
                        );
                    }
                }
            );

            stream.on(
                "close",
                async () => {
                    await safeRemove(
                        outputPath
                    );

                    if (
                        temporarySource
                    ) {
                        await safeRemove(
                            temporarySource
                        );
                    }
                }
            );

            stream.pipe(res);

            return;
        } catch (error) {
            metrics.errors++;

            console.error(
                "[Download] ERRO:",
                error
            );

            await safeRemove(
                outputPath
            );

            if (
                temporarySource
            ) {
                await safeRemove(
                    temporarySource
                );
            }

            if (
                !res.headersSent
            ) {
                return jsonError(
                    res,
                    500,
                    error.message ||
                        "Não foi possível gerar o corte MP4."
                );
            }

            return;
        }
    }
);

/* ============================================================
 * AUTH LOGIN
 * ========================================================== */

app.post(
    "/api/auth/login",
    async (req, res) => {
        try {
            const {
                email,
                name
            } = req.body || {};

            const user =
                createUser({
                    email,
                    name
                });

            const daily =
                claimDailyPoints(
                    user
                );

            const token =
                createSession(
                    user
                );

            return res.json({
                ok: true,

                token,

                session:
                    token,

                user: {
                    id:
                        user.id,

                    userId:
                        user.userId,

                    email:
                        user.email,

                    name:
                        user.name,

                    pontos:
                        user.pontos,

                    isVip:
                        user.isVip
                },

                dailyPoints:
                    daily
            });
        } catch (error) {
            return jsonError(
                res,
                500,
                error.message
            );
        }
    }
);

/* ============================================================
 * AUTH ME
 * ========================================================== */

app.get(
    "/api/auth/me",
    requireUser,
    async (req, res) => {
        const daily =
            claimDailyPoints(
                req.user
            );

        return res.json({
            ok: true,

            user: {
                id:
                    req.user.id,

                userId:
                    req.user.userId,

                email:
                    req.user.email,

                name:
                    req.user.name,

                pontos:
                    req.user.pontos,

                isVip:
                    req.user.isVip
            },

            dailyPoints:
                daily
        });
    }
);

/* ============================================================
 * PIX — MERCADO PAGO
 * ========================================================== */

async function mercadoPagoCreatePix({
    user,
    amount,
    description
}) {
    if (
        !MERCADO_PAGO_ACCESS_TOKEN
    ) {
        throw new Error(
            "MERCADO_PAGO_ACCESS_TOKEN não configurado."
        );
    }

    const externalReference =
        randomId(
            "clipforge_"
        );

    const body = {
        transaction_amount:
            Number(amount),

        description:
            description ||
            "ClipForge Pro",

        payment_method_id:
            "pix",

        payer: {
            email:
                user.email ||
                `cliente-${user.id}@clipforge.local`
        },

        external_reference:
            externalReference
    };

    if (
        MERCADO_PAGO_WEBHOOK_URL
    ) {
        body.notification_url =
            MERCADO_PAGO_WEBHOOK_URL;
    }

    const response =
        await fetch(
            "https://api.mercadopago.com/v1/payments",
            {
                method: "POST",

                headers: {
                    Authorization:
                        `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`,

                    "Content-Type":
                        "application/json",

                    "X-Idempotency-Key":
                        randomToken(24)
                },

                body:
                    JSON.stringify(
                        body
                    ),

                signal:
                    AbortSignal.timeout(
                        60000
                    )
            }
        );

    const text =
        await response.text();

    if (!response.ok) {
        throw new Error(
            `Mercado Pago HTTP ${response.status}: ${text.slice(
                0,
                3000
            )}`
        );
    }

    let data;

    try {
        data =
            JSON.parse(text);
    } catch (_) {
        throw new Error(
            "Mercado Pago retornou JSON inválido."
        );
    }

    return data;
}

app.post(
    "/api/pix/criar",
    requireUser,
    async (req, res) => {
        try {
            const amount =
                parseNumber(
                    req.body?.amount,
                    0
                );

            const description =
                safeString(
                    req.body?.description,
                    "ClipForge Pro"
                );

            if (
                !Number.isFinite(
                    amount
                ) ||
                amount <= 0
            ) {
                return jsonError(
                    res,
                    400,
                    "Valor PIX inválido."
                );
            }

            const payment =
                await mercadoPagoCreatePix({
                    user:
                        req.user,

                    amount,

                    description
                });

            const paymentId =
                String(
                    payment.id ||
                    randomId(
                        "payment_"
                    )
                );

            const record = {
                id:
                    paymentId,

                userId:
                    req.user.id,

                amount,

                status:
                    payment.status ||
                    "pending",

                createdAt:
                    now(),

                mercadoPago:
                    payment
            };

            payments.set(
                paymentId,
                record
            );

            metrics.pixCreated++;

            const transactionData =
                payment.point_of_interaction
                    ?.transaction_data;

            return res.json({
                ok: true,

                paymentId,

                status:
                    payment.status,

                qrCode:
                    transactionData
                        ?.qr_code ||
                    null,

                qrCodeBase64:
                    transactionData
                        ?.qr_code_base64 ||
                    null,

                ticketUrl:
                    transactionData
                        ?.ticket_url ||
                    null,

                payment
            });
        } catch (error) {
            metrics.errors++;

            console.error(
                "[PIX] Erro:",
                error
            );

            return jsonError(
                res,
                500,
                error.message ||
                    "Não foi possível criar o PIX."
            );
        }
    }
);

/* ============================================================
 * PIX STATUS
 * ========================================================== */

app.get(
    "/api/pix/status/:id",
    requireUser,
    async (req, res) => {
        try {
            const payment =
                payments.get(
                    req.params.id
                );

            if (
                payment &&
                payment.userId !==
                    req.user.id
            ) {
                return jsonError(
                    res,
                    403,
                    "Pagamento não pertence ao usuário."
                );
            }

            if (
                !MERCADO_PAGO_ACCESS_TOKEN
            ) {
                return jsonError(
                    res,
                    500,
                    "Mercado Pago não configurado."
                );
            }

            const response =
                await fetch(
                    `https://api.mercadopago.com/v1/payments/${encodeURIComponent(
                        req.params.id
                    )}`,
                    {
                        headers: {
                            Authorization:
                                `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`
                        },

                        signal:
                            AbortSignal.timeout(
                                30000
                            )
                    }
                );

            const text =
                await response.text();

            if (!response.ok) {
                return jsonError(
                    res,
                    response.status,
                    `Mercado Pago HTTP ${response.status}: ${text.slice(
                        0,
                        1000
                    )}`
                );
            }

            const data =
                JSON.parse(text);

            if (payment) {
                payment.status =
                    data.status ||
                    payment.status;

                payment.mercadoPago =
                    data;
            }

            return res.json({
                ok: true,

                id:
                    data.id,

                status:
                    data.status,

                statusDetail:
                    data.status_detail,

                payment:
                    data
            });
        } catch (error) {
            return jsonError(
                res,
                500,
                error.message
            );
        }
    }
);

/* ============================================================
 * ADMIN
 * ========================================================== */

app.post(
    "/api/admin/login",
    async (req, res) => {
        try {
            const {
                email,
                password
            } = req.body || {};

            if (
                safeString(email)
                    .trim()
                    .toLowerCase() !==
                ADMIN_EMAIL
                    .trim()
                    .toLowerCase()
            ) {
                return jsonError(
                    res,
                    401,
                    "Credenciais inválidas."
                );
            }

            if (
                safeString(
                    password
                ) !==
                ADMIN_PASSWORD
            ) {
                return jsonError(
                    res,
                    401,
                    "Credenciais inválidas."
                );
            }

            const token =
                randomToken(48);

            adminSessions.set(
                token,
                {
                    token,
                    createdAt:
                        now(),
                    expiresAt:
                        now() +
                        SESSION_TTL_MS
                }
            );

            return res.json({
                ok: true,
                token,
                session:
                    token
            });
        } catch (error) {
            return jsonError(
                res,
                500,
                error.message
            );
        }
    }
);

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
        extractBearerToken(req);

    const session =
        adminSessions.get(
            token
        );

    if (!session) {
        return jsonError(
            res,
            401,
            "Sessão administrativa inválida."
        );
    }

    if (
        session.expiresAt < now()
    ) {
        adminSessions.delete(
            token
        );

        return jsonError(
            res,
            401,
            "Sessão administrativa expirada."
        );
    }

    req.admin = true;

    next();
}

app.get(
    "/api/admin/dashboard",
    requireAdmin,
    async (req, res) => {
        const uploadList =
            Array.from(
                uploads.values()
            );

        const paymentList =
            Array.from(
                payments.values()
            );

        const memoryUsage =
            process.memoryUsage();

        return res.json({
            ok: true,

            version:
                VERSION,

            uptime:
                process.uptime(),

            metrics: {
                ...metrics
            },

            counts: {
                users:
                    users.size,

                sessions:
                    sessions.size,

                uploads:
                    uploads.size,

                payments:
                    payments.size,

                adminSessions:
                    adminSessions.size
            },

            uploads: {
                total:
                    uploadList.length,

                totalBytes:
                    uploadList.reduce(
                        (
                            total,
                            item
                        ) =>
                            total +
                            Number(
                                item.size ||
                                    0
                            ),
                        0
                    )
            },

            payments: {
                total:
                    paymentList.length,

                pending:
                    paymentList.filter(
                        (p) =>
                            p.status ===
                            "pending"
                    ).length,

                approved:
                    paymentList.filter(
                        (p) =>
                            p.status ===
                            "approved"
                    ).length
            },

            memory: {
                rss:
                    memoryUsage.rss,

                heapUsed:
                    memoryUsage.heapUsed,

                heapTotal:
                    memoryUsage.heapTotal,

                external:
                    memoryUsage.external
            }
        });
    }
);

/* ============================================================
 * HEALTH
 * ========================================================== */

app.get(
    "/health",
    async (req, res) => {
        const geminiConfigured =
            Boolean(
                GEMINI_API_KEY
            );

        return res.json({
            ok: true,

            status:
                "online",

            service:
                "clipforge-server",

            version:
                VERSION,

            node:
                process.version,

            uptime:
                process.uptime(),

            gemini: {
                configured:
                    geminiConfigured,

                primaryModel:
                    GEMINI_PRIMARY_MODEL,

                fallbackModels:
                    GEMINI_FALLBACK_MODELS
            },

            binaries: {
                ffmpeg:
                    Boolean(
                        FFMPEG_PATH
                    ),

                ffprobe:
                    Boolean(
                        FFPROBE_PATH
                    ),

                ytDlp:
                    Boolean(
                        YTDLP_PATH
                    )
            },

            upload: {
                maxMB:
                    MAX_UPLOAD_MB
            }
        });
    }
);

/* ============================================================
 * ROOT
 * ========================================================== */

app.get(
    "/",
    async (req, res) => {
        return res.json({
            ok: true,

            service:
                "ClipForge Pro Server",

            version:
                VERSION,

            message:
                "Backend online.",

            endpoints: [
                "/health",
                "/api/auth/login",
                "/api/auth/me",
                "/api/upload",
                "/api/upload/:id",
                "/api/analisar",
                "/api/analisar-upload",
                "/api/download",
                "/api/pix/criar",
                "/api/pix/status/:id",
                "/api/admin/login",
                "/api/admin/dashboard"
            ]
        });
    }
);

/* ============================================================
 * 404
 * ========================================================== */

app.use(
    (req, res) => {
        return jsonError(
            res,
            404,
            "Rota não encontrada."
        );
    }
);

/* ============================================================
 * ERROR HANDLER
 * ========================================================== */

app.use(
    (
        error,
        req,
        res,
        next
    ) => {
        metrics.errors++;

        console.error(
            "[Express Error]",
            error
        );

        if (
            error instanceof
            multer.MulterError
        ) {
            if (
                error.code ===
                "LIMIT_FILE_SIZE"
            ) {
                return jsonError(
                    res,
                    413,
                    `O arquivo excede o limite de ${MAX_UPLOAD_MB} MB.`
                );
            }

            return jsonError(
                res,
                400,
                `Erro de upload: ${error.message}`
            );
        }

        if (
            error?.message ===
            "Formato de vídeo não suportado."
        ) {
            return jsonError(
                res,
                400,
                error.message
            );
        }

        if (
            !res.headersSent
        ) {
            return jsonError(
                res,
                500,
                error?.message ||
                    "Erro interno do servidor."
            );
        }

        next(error);
    }
);

/* ============================================================
 * START
 * ========================================================== */

async function startServer() {
    try {
        await ensureDirectories();

        await resolveBinaries();

        console.log("");
        console.log(
            "===================================================="
        );
        console.log(
            ` CLIPFORGE PRO — BACKEND ${VERSION}`
        );
        console.log(
            "===================================================="
        );

        console.log(
            `[Server] Node.js ${process.version}`
        );

        console.log(
            `[Server] Porta ${PORT}`
        );

        console.log(
            `[Gemini] Modelo principal: ${GEMINI_PRIMARY_MODEL}`
        );

        console.log(
            `[Gemini] Fallbacks: ${GEMINI_FALLBACK_MODELS.join(
                ", "
            )}`
        );

        console.log(
            `[Gemini] API Key: ${
                GEMINI_API_KEY
                    ? "CONFIGURADA"
                    : "NÃO CONFIGURADA"
            }`
        );

        console.log(
            "[Gemini] Interactions API:",
            GEMINI_INTERACTIONS_URL
        );

        console.log(
            "[Gemini] Files API:",
            GEMINI_FILES_API_URL
        );

        console.log(
            "[Download] YT-API/RapidAPI + FFmpeg + yt-dlp fallback ativo."
        );

        console.log(
            `[Upload] Limite: ${MAX_UPLOAD_MB} MB`
        );

        console.log(
            "===================================================="
        );

        app.listen(
            PORT,
            "0.0.0.0",
            () => {
                console.log("");
                console.log(
                    `🚀 ClipForge Pro ${VERSION} online`
                );

                console.log(
                    `🌐 Porta: ${PORT}`
                );

                console.log(
                    `❤️ Health: /health`
                );

                console.log("");
            }
        );
    } catch (error) {
        console.error(
            "[Startup] Falha fatal:",
            error
        );

        process.exit(1);
    }
}

startServer();

/* ============================================================
 * EXPORT
 * ========================================================== */

module.exports = app;