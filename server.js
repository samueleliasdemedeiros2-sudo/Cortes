/**
 * ============================================================
 * CLIPFORGE PRO — BACKEND 13.4.4
 * (TIMEOUT REAL YT-DLP + TIMEOUTS SEPARADOS + YOUTUBE FALLBACK)
 * ============================================================
 *
 * Node.js >= 20 + Express
 *
 * CORREÇÕES:
 * 1. Resolução local de binários (FFmpeg e yt-dlp em ./bin)
 * 2. Análise de IA via OpenRouter com suporte a "video_url"
 * 3. Camada Multi-Source de Download com Timeout Separado
 * 4. Timeout REAL para processos yt-dlp
 * 5. Timeout separado para metadados do yt-dlp
 * 6. URLs temporárias seguras via tokens
 * 7. Módulo isolado de Mercado Pago mantido intacto
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

const VERSION = "13.4.4-openrouter-youtube-fallback";

const MAX_UPLOAD_MB =
    Number(process.env.MAX_UPLOAD_MB || 150);

const MAX_UPLOAD_BYTES =
    MAX_UPLOAD_MB * 1024 * 1024;

const UPLOAD_TTL_MS =
    2 * 60 * 60 * 1000;

const SESSION_TTL_MS =
    30 * 24 * 60 * 60 * 1000;

const ADMIN_SESSION_TTL_MS =
    24 * 60 * 60 * 1000;

const FREE_POINTS =
    Number(process.env.FREE_POINTS || 200);

const DAILY_POINTS =
    Number(process.env.DAILY_POINTS || 50);

const ANALYSIS_COST =
    Number(process.env.ANALYSIS_COST || 20);

const DOWNLOAD_COST =
    Number(process.env.DOWNLOAD_COST || 50);

const VIP_PRICE =
    Number(process.env.VIP_PRICE || 19.90);

const MAX_CLIPS =
    Number(process.env.MAX_CLIPS || 8);

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
   OPENROUTER — CONFIGURAÇÃO DA IA
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
    "google/gemini-2.5-flash";

const OPENROUTER_FALLBACK_MODELS = (
    process.env.OPENROUTER_FALLBACK_MODELS ||
    "google/gemini-2.5-flash-lite"
)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const OPENROUTER_MODELS = [
    OPENROUTER_MODEL,
    ...OPENROUTER_FALLBACK_MODELS.filter(
        (model) => model !== OPENROUTER_MODEL
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

const aiVideoTokens = new Map();

const AI_VIDEO_TOKEN_TTL_MS =
    15 * 60 * 1000;

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
    process.env.ADMIN_PASSWORD || "";

const YTDLP_COOKIES_FILE =
    process.env.YTDLP_COOKIES_FILE ||
    process.env.YOUTUBE_COOKIES_FILE ||
    "";

/* ============================================================
   YOUTUBE — TIMEOUTS
============================================================ */

const YOUTUBE_SOURCE_TIMEOUT_MS =
    Number(
        process.env.YOUTUBE_SOURCE_TIMEOUT_MS ||
        15000
    );

const YOUTUBE_DOWNLOAD_TIMEOUT_MS =
    Number(
        process.env.YOUTUBE_DOWNLOAD_TIMEOUT_MS ||
        300000
    );

/*
 * Timeout específico para chamadas do yt-dlp
 * usadas apenas para obter metadados.
 *
 * Não usamos o timeout de download aqui porque
 * metadados devem ser rápidos.
 */
const YOUTUBE_METADATA_TIMEOUT_MS =
    Number(
        process.env.YOUTUBE_METADATA_TIMEOUT_MS ||
        15000
    );

/* ============================================================
   YOUTUBE — INSTÂNCIAS
============================================================ */

const PIPED_API_URLS = (
    process.env.PIPED_API_URLS ||
    [
        "https://pipedapi.kavin.rocks",
        "https://pipedapi.leptons.xyz",
        "https://pipedapi.tokhmi.xyz"
    ].join(",")
)
    .split(",")
    .map((x) =>
        x.trim().replace(/\/+$/, "")
    )
    .filter(Boolean);

const INVIDIOUS_API_URLS = (
    process.env.INVIDIOUS_API_URLS ||
    [
        "https://inv.nadeko.net",
        "https://invidious.nerdvpn.de",
        "https://yt.chocolatemoo53.com",
        "https://invidious.tiekoetter.com"
    ].join(",")
)
    .split(",")
    .map((x) =>
        x.trim().replace(/\/+$/, "")
    )
    .filter(Boolean);

/* ============================================================
   BINÁRIOS
============================================================ */

let FFMPEG_BIN = "ffmpeg";
let FFPROBE_BIN = "ffprobe";

let YTDLP_BIN =
    path.join(
        __dirname,
        "bin",
        "yt-dlp"
    );

/* ============================================================
   MEMÓRIA
============================================================ */

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
    openRouterRetries: 0,
    openRouterFallbacks: 0,
    errors: 0
};

/* ============================================================
   EXPRESS
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
            "OPTIONS"
        ],
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

function now() {
    return Date.now();
}

function sleep(ms) {
    return new Promise(
        (resolve) => setTimeout(resolve, ms)
    );
}

function randomToken(bytes = 32) {
    return crypto
        .randomBytes(bytes)
        .toString("hex");
}

function randomId(prefix = "") {
    return prefix +
        crypto.randomUUID();
}

function safeString(
    value,
    fallback = ""
) {
    if (
        value === null ||
        value === undefined
    ) {
        return fallback;
    }

    return String(value);
}

function parseNumber(
    value,
    fallback = 0
) {
    const number = Number(value);

    return Number.isFinite(number)
        ? number
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
            ok: false,
            error: message,
            ...extra
        });
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
        {
            recursive: true
        }
    );

    await fsp.mkdir(
        UPLOAD_DIR,
        {
            recursive: true
        }
    );

    await fsp.mkdir(
        OUTPUT_DIR,
        {
            recursive: true
        }
    );
}

/* ============================================================
   SPAWN CAPTURE — COM TIMEOUT REAL
============================================================ */

/*
 * IMPORTANTE:
 *
 * Na 13.4.3, timeoutMs era simplesmente ignorado pelo
 * child_process.spawn().
 *
 * Agora o timeout é controlado pelo próprio backend.
 *
 * Quando o tempo acaba:
 *
 * 1. marcamos o processo como timedOut;
 * 2. enviamos SIGTERM;
 * 3. aguardamos uma pequena janela;
 * 4. se ainda estiver vivo, enviamos SIGKILL;
 * 5. o Promise termina com ETIMEDOUT.
 */

function spawnCapture(
    command,
    args = [],
    options = {}
) {
    return new Promise(
        (resolve, reject) => {
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
                reject(error);
                return;
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

            const finishResolve = (
                result
            ) => {
                if (finished) return;

                finished = true;
                cleanupTimers();

                resolve(result);
            };

            const finishReject = (
                error
            ) => {
                if (finished) return;

                finished = true;
                cleanupTimers();

                reject(error);
            };

            child.stdout?.on(
                "data",
                (chunk) => {
                    stdout += chunk.toString();

                    if (
                        stdout.length >
                        150000
                    ) {
                        stdout =
                            stdout.slice(
                                -150000
                            );
                    }
                }
            );

            child.stderr?.on(
                "data",
                (chunk) => {
                    stderr += chunk.toString();

                    if (
                        stderr.length >
                        250000
                    ) {
                        stderr =
                            stderr.slice(
                                -250000
                            );
                    }
                }
            );

            child.once(
                "error",
                (error) => {
                    if (timedOut) {
                        const timeoutError =
                            new Error(
                                `Processo excedeu o timeout de ${timeoutMs}ms.`
                            );

                        timeoutError.code =
                            "ETIMEDOUT";

                        timeoutError.timeoutMs =
                            timeoutMs;

                        timeoutError.command =
                            command;

                        finishReject(
                            timeoutError
                        );

                        return;
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
                                `Processo excedeu o timeout de ${timeoutMs}ms.`
                            );

                        timeoutError.code =
                            "ETIMEDOUT";

                        timeoutError.timeoutMs =
                            timeoutMs;

                        timeoutError.command =
                            command;

                        timeoutError.stdout =
                            stdout;

                        timeoutError.stderr =
                            stderr;

                        finishReject(
                            timeoutError
                        );

                        return;
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
                timeoutTimer =
                    setTimeout(() => {
                        if (finished) {
                            return;
                        }

                        timedOut = true;

                        console.warn(
                            `[Process] Timeout de ${timeoutMs}ms: ${command}`
                        );

                        try {
                            child.kill(
                                "SIGTERM"
                            );
                        } catch (_) {}

                        killTimer =
                            setTimeout(() => {
                                if (finished) {
                                    return;
                                }

                                try {
                                    child.kill(
                                        "SIGKILL"
                                    );
                                } catch (_) {}

                            }, killGraceMs);

                    }, timeoutMs);
            }
        }
    );
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
   RESOLUÇÃO DE BINÁRIOS
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
            require(
                "@ffmpeg-installer/ffmpeg"
            );

        if (
            installerFfmpeg?.path
        ) {
            ffmpegCandidates.push(
                installerFfmpeg.path
            );
        }
    } catch (_) {}

    ffmpegCandidates.push(
        "ffmpeg"
    );

    for (
        const cand
        of ffmpegCandidates
    ) {
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
            require(
                "@ffprobe-installer/ffprobe"
            );

        if (
            installerFfprobe?.path
        ) {
            ffprobeCandidates.unshift(
                installerFfprobe.path
            );
        }
    } catch (_) {}

    ffprobeCandidates.push(
        "ffprobe"
    );

    for (
        const cand
        of ffprobeCandidates
    ) {
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

    const localYtDlp =
        path.join(
            __dirname,
            "bin",
            "yt-dlp"
        );

    const ytdlpCandidates = [
        localYtDlp,
        process.env.YTDLP_BIN,
        process.env.YTDLP_PATH,
        path.join(
            process.cwd(),
            "bin",
            "yt-dlp"
        ),
        "yt-dlp"
    ];

    for (
        const cand
        of ytdlpCandidates
    ) {
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

    const ffmpegOk =
        await commandExists(
            FFMPEG_BIN,
            ["-version"]
        );

    const ffprobeOk =
        await commandExists(
            FFPROBE_BIN,
            ["-version"]
        );

    const ytdlpOk =
        await commandExists(
            YTDLP_BIN,
            ["--version"]
        );

    console.log(
        `[Binaries] FFmpeg: ${
            ffmpegOk
                ? FFMPEG_BIN
                : "AUSENTE"
        }`
    );

    console.log(
        `[Binaries] FFprobe: ${
            ffprobeOk
                ? FFPROBE_BIN
                : "AUSENTE"
        }`
    );

    console.log(
        `[Binaries] yt-dlp: ${
            ytdlpOk
                ? YTDLP_BIN
                : "AUSENTE"
        }`
    );
}

/* ============================================================
   VÍDEO / METADADOS
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
        data =
            JSON.parse(
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
        Array.isArray(
            data.streams
        )
            ? data.streams
            : [];

    const videoStream =
        streams.find(
            (stream) =>
                stream.codec_type ===
                "video"
        ) || null;

    const audioStream =
        streams.find(
            (stream) =>
                stream.codec_type ===
                "audio"
        ) || null;

    return {
        duration:
            parseNumber(
                format.duration,
                0
            ),

        size:
            parseNumber(
                format.size,
                0
            ),

        format:
            format.format_name ||
            null,

        width:
            parseNumber(
                videoStream?.width,
                0
            ),

        height:
            parseNumber(
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
        await fsp.stat(
            filePath
        );

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

    if (
        stat.size >
        MAX_UPLOAD_BYTES
    ) {
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
   UPLOAD — MP4 ESTRITO
============================================================ */

const storage =
    multer.diskStorage({
        destination:
            function (
                req,
                file,
                cb
            ) {
                cb(
                    null,
                    UPLOAD_DIR
                );
            },

        filename:
            function (
                req,
                file,
                cb
            ) {
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

        fileFilter:
            function (
                req,
                file,
                cb
            ) {
                const mime =
                    safeString(
                        file.mimetype
                    ).toLowerCase();

                const name =
                    safeString(
                        file.originalname
                    ).toLowerCase();

                const validMime =
                    mime ===
                    "video/mp4";

                const validExtension =
                    /\.mp4$/i.test(
                        name
                    );

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

function getYouTubeId(
    value
) {
    const input =
        safeString(
            value
        ).trim();

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

        if (
            host === "youtu.be"
        ) {
            const id =
                url.pathname
                    .replace(
                        /^\//,
                        ""
                    )
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

function normalizeYouTubeUrl(
    value
) {
    const id =
        getYouTubeId(value);

    return id
        ? `https://www.youtube.com/watch?v=${id}`
        : null;
}

function createTimeoutController(
    timeoutMs
) {
    const controller =
        new AbortController();

    const timer =
        setTimeout(
            () => {
                controller.abort();
            },
            timeoutMs
        );

    return {
        controller,

        clear:
            () =>
                clearTimeout(
                    timer
                )
    };
}

async function fetchJsonWithTimeout(
    url,
    options = {}
) {
    const timeoutMs =
        Number(
            options.timeoutMs
        ) ||
        YOUTUBE_SOURCE_TIMEOUT_MS;

    const {
        timeoutMs: ignored,
        ...fetchOptions
    } = options;

    const timeout =
        createTimeoutController(
            timeoutMs
        );

    try {
        const response =
            await fetch(
                url,
                {
                    ...fetchOptions,

                    signal:
                        timeout
                            .controller
                            .signal,

                    headers: {
                        Accept:
                            "application/json",

                        "User-Agent":
                            "ClipForge-Pro/13.4.4",

                        ...(fetchOptions.headers ||
                            {})
                    }
                }
            );

        const text =
            await response.text();

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}: ${text.slice(
                    0,
                    500
                )}`
            );
        }

        try {
            return JSON.parse(
                text
            );
        } catch (_) {
            throw new Error(
                "Resposta JSON inválida."
            );
        }

    } catch (error) {
        if (
            error?.name ===
            "AbortError"
        ) {
            throw new Error(
                `Timeout após ${timeoutMs}ms`
            );
        }

        throw error;

    } finally {
        timeout.clear();
    }
}

function normalizeQualityNumber(
    value
) {
    const match =
        safeString(value)
            .match(
                /(\d{3,4})/
            );

    if (!match) {
        return 0;
    }

    const number =
        Number(
            match[1]
        );

    return Number.isFinite(
        number
    )
        ? number
        : 0;
}

function isMp4Stream(
    stream
) {
    if (!stream) {
        return false;
    }

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
            stream.url ||
            ""
        ).toLowerCase();

    return (
        type.includes(
            "video/mp4"
        ) ||
        container === "mp4" ||
        container.includes(
            "mp4"
        ) ||
        url.includes(
            ".mp4"
        )
    );
}

function choosePipedStream(
    data
) {
    const streams =
        Array.isArray(
            data?.videoStreams
        )
            ? data.videoStreams
            : [];

    const candidates =
        streams
            .filter(
                (stream) => {
                    if (
                        !stream?.url
                    ) {
                        return false;
                    }

                    if (
                        stream.videoOnly ===
                        true
                    ) {
                        return false;
                    }

                    return isMp4Stream(
                        stream
                    );
                }
            )
            .map(
                (stream) => ({
                    ...stream,

                    qualityNumber:
                        normalizeQualityNumber(
                            stream.quality ||
                            stream.qualityLabel ||
                            stream.resolution
                        )
                })
            )
            .filter(
                (stream) => {
                    if (
                        stream.qualityNumber >
                        0 &&
                        stream.qualityNumber >
                        720
                    ) {
                        return false;
                    }

                    return true;
                }
            );

    candidates.sort(
        (a, b) =>
            b.qualityNumber -
            a.qualityNumber
    );

    return (
        candidates[0] ||
        null
    );
}

async function tryPipedDownload(
    videoId,
    outputFile
) {
    let lastError =
        null;

    for (
        const apiBase
        of PIPED_API_URLS
    ) {
        try {
            console.log(
                `[YouTube/Piped] Consultando ${apiBase}`
            );

            const endpoint =
                `${apiBase}/streams/` +
                `${encodeURIComponent(
                    videoId
                )}`;

            const data =
                await fetchJsonWithTimeout(
                    endpoint
                );

            const stream =
                choosePipedStream(
                    data
                );

            if (
                !stream?.url
            ) {
                throw new Error(
                    "Nenhum stream MP4 progressivo <=720p encontrado."
                );
            }

            console.log(
                `[YouTube/Piped] Stream encontrado em ${apiBase}`
            );

            await downloadRemoteVideo(
                stream.url,
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

                source:
                    "piped"
            };

        } catch (error) {
            lastError =
                error;

            console.warn(
                `[YouTube/Piped] ${apiBase} falhou:`,
                error.message
            );

            await safeRemove(
                outputFile
            );
        }
    }

    throw (
        lastError ||
        new Error(
            "Todas as instâncias Piped falharam."
        )
    );
}

function chooseInvidiousStream(
    data
) {
    const streams =
        Array.isArray(
            data?.formatStreams
        )
            ? data.formatStreams
            : [];

    const candidates =
        streams
            .filter(
                (stream) => {
                    if (
                        !stream?.url
                    ) {
                        return false;
                    }

                    const container =
                        safeString(
                            stream.container
                        ).toLowerCase();

                    return (
                        container ===
                            "mp4" ||
                        isMp4Stream(
                            stream
                        )
                    );
                }
            )
            .map(
                (stream) => ({
                    ...stream,

                    qualityNumber:
                        normalizeQualityNumber(
                            stream.qualityLabel ||
                            stream.quality ||
                            stream.resolution
                        )
                })
            )
            .filter(
                (stream) => {
                    if (
                        stream.qualityNumber >
                        0 &&
                        stream.qualityNumber >
                        720
                    ) {
                        return false;
                    }

                    return true;
                }
            );

    candidates.sort(
        (a, b) =>
            b.qualityNumber -
            a.qualityNumber
    );

    return (
        candidates[0] ||
        null
    );
}

async function tryInvidiousDownload(
    videoId,
    outputFile
) {
    let lastError =
        null;

    for (
        const apiBase
        of INVIDIOUS_API_URLS
    ) {
        try {
            console.log(
                `[YouTube/Invidious] Consultando ${apiBase}`
            );

            const endpoint =
                `${apiBase}/api/v1/videos/` +
                `${encodeURIComponent(
                    videoId
                )}` +
                `?region=BR`;

            const data =
                await fetchJsonWithTimeout(
                    endpoint
                );

            const stream =
                chooseInvidiousStream(
                    data
                );

            if (
                !stream?.url
            ) {
                throw new Error(
                    "Nenhum stream MP4 <=720p encontrado."
                );
            }

            console.log(
                `[YouTube/Invidious] Stream encontrado em ${apiBase}`
            );

            await downloadRemoteVideo(
                stream.url,
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

                source:
                    "invidious"
            };

        } catch (error) {
            lastError =
                error;

            console.warn(
                `[YouTube/Invidious] ${apiBase} falhou:`,
                error.message
            );

            await safeRemove(
                outputFile
            );
        }
    }

    throw (
        lastError ||
        new Error(
            "Todas as instâncias Invidious falharam."
        )
    );
}

async function downloadRemoteVideo(
    url,
    outputFile
) {
    if (!url) {
        throw new Error(
            "URL do stream não informada."
        );
    }

    const timeout =
        createTimeoutController(
            YOUTUBE_DOWNLOAD_TIMEOUT_MS
        );

    let fileHandle =
        null;

    try {
        const response =
            await fetch(
                url,
                {
                    method:
                        "GET",

                    redirect:
                        "follow",

                    signal:
                        timeout
                            .controller
                            .signal,

                    headers: {
                        "User-Agent":
                            "ClipForge-Pro/13.4.4",

                        Accept:
                            "video/mp4,video/*;q=0.9,*/*;q=0.8"
                    }
                }
            );

        if (!response.ok) {
            throw new Error(
                `Download HTTP ${response.status}`
            );
        }

        if (!response.body) {
            throw new Error(
                "O servidor não retornou um corpo de vídeo."
            );
        }

        const contentLength =
            Number(
                response.headers.get(
                    "content-length"
                ) || 0
            );

        if (
            contentLength >
                0 &&
            contentLength >
                MAX_UPLOAD_BYTES
        ) {
            throw new Error(
                `Stream excede o limite de ${MAX_UPLOAD_MB} MB.`
            );
        }

        await fsp.mkdir(
            path.dirname(
                outputFile
            ),
            {
                recursive:
                    true
            }
        );

        fileHandle =
            fs.createWriteStream(
                outputFile
            );

        let totalBytes =
            0;

        for await (
            const chunk
            of response.body
        ) {
            const buffer =
                Buffer.from(
                    chunk
                );

            totalBytes +=
                buffer.length;

            if (
                totalBytes >
                MAX_UPLOAD_BYTES
            ) {
                throw new Error(
                    `Download excedeu o limite de ${MAX_UPLOAD_MB} MB.`
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

        fileHandle =
            null;

        if (
            totalBytes <=
            10000
        ) {
            throw new Error(
                "Stream retornou um arquivo muito pequeno."
            );
        }

        return outputFile;

    } catch (error) {
        try {
            fileHandle?.destroy();
        } catch (_) {}

        await safeRemove(
            outputFile
        );

        if (
            error?.name ===
            "AbortError"
        ) {
            throw new Error(
                `Timeout no download após ${YOUTUBE_DOWNLOAD_TIMEOUT_MS}ms`
            );
        }

        throw error;

    } finally {
        timeout.clear();
    }
}

/* ============================================================
   YT-DLP — METADADOS COM TIMEOUT REAL
============================================================ */

async function getYouTubeInfo(
    url
) {
    const args = [
        "--no-playlist",
        "--skip-download",
        "--dump-single-json",
        "--no-warnings",
        url
    ];

    if (
        YTDLP_COOKIES_FILE
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
                    YOUTUBE_METADATA_TIMEOUT_MS
            }
        );

    if (result.code !== 0) {
        throw new Error(
            result.stderr ||
            result.stdout ||
            "yt-dlp falhou nos metadados."
        );
    }

    try {
        return JSON.parse(
            result.stdout
        );
    } catch (_) {
        throw new Error(
            "yt-dlp retornou dados inválidos."
        );
    }
}

/* ============================================================
   YT-DLP — DOWNLOAD COM TIMEOUT REAL
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

        "-f",
        "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]/best",

        "--merge-output-format",
        "mp4",

        "-o",
        outputTemplate,

        url
    ];

    if (
        YTDLP_COOKIES_FILE
    ) {
        args.splice(
            2,
            0,
            "--cookies",
            YTDLP_COOKIES_FILE
        );
    }

    console.log(
        "[YouTube/yt-dlp] Iniciando fallback final..."
    );

    console.log(
        `[YouTube/yt-dlp] Timeout: ${YOUTUBE_DOWNLOAD_TIMEOUT_MS}ms`
    );

    let result;

    try {
        result =
            await spawnCapture(
                YTDLP_BIN,
                args,
                {
                    timeoutMs:
                        YOUTUBE_DOWNLOAD_TIMEOUT_MS
                }
            );

    } catch (error) {
        if (
            error?.code ===
            "ETIMEDOUT"
        ) {
            throw new Error(
                `yt-dlp excedeu o timeout de download de ${YOUTUBE_DOWNLOAD_TIMEOUT_MS}ms.`
            );
        }

        throw error;
    }

    if (
        result.code !== 0
    ) {
        throw new Error(
            result.stderr ||
            result.stdout ||
            "yt-dlp falhou no download."
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

    const candidates =
        [];

    for (
        const filename
        of files
    ) {
        if (
            !/^source\.mp4$/i.test(
                filename
            )
        ) {
            continue;
        }

        const fullPath =
            path.join(
                directory,
                filename
            );

        try {
            const stat =
                await fsp.stat(
                    fullPath
                );

            if (
                stat.isFile() &&
                stat.size > 0
            ) {
                candidates.push(
                    fullPath
                );
            }
        } catch (_) {}
    }

    if (
        !candidates.length
    ) {
        throw new Error(
            "yt-dlp terminou sem produzir um arquivo MP4."
        );
    }

    const filePath =
        candidates[0];

    const metadata =
        await validateVideoFile(
            filePath
        );

    let title = "";

    try {
        const info =
            await getYouTubeInfo(
                url
            );

        title =
            safeString(
                info?.title,
                ""
            );

    } catch (error) {
        console.warn(
            "[YouTube/yt-dlp] Não foi possível obter metadados:",
            error.message
        );
    }

    return {
        filePath,

        title,

        duration:
            metadata.duration,

        source:
            "yt-dlp"
    };
}

/* ============================================================
   DOWNLOAD YOUTUBE MULTI-SOURCE
============================================================ */

async function downloadYouTubeVideo(
    url,
    outputTemplate
) {
    const videoId =
        getYouTubeId(
            url
        );

    if (!videoId) {
        throw new Error(
            "ID do YouTube inválido."
        );
    }

    const directory =
        path.dirname(
            outputTemplate
        );

    await fsp.mkdir(
        directory,
        {
            recursive:
                true
        }
    );

    const outputFile =
        path.join(
            directory,
            "source.mp4"
        );

    const errors =
        [];

    /* ========================================================
       1. PIPED
    ======================================================== */

    try {
        const result =
            await tryPipedDownload(
                videoId,
                outputFile
            );

        console.log(
            `[YouTube] Download concluído via ${result.source}.`
        );

        return result;

    } catch (error) {
        errors.push(
            `Piped: ${error.message}`
        );
    }

    /* ========================================================
       2. INVIDIOUS
    ======================================================== */

    try {
        const result =
            await tryInvidiousDownload(
                videoId,
                outputFile
            );

        console.log(
            `[YouTube] Download concluído via ${result.source}.`
        );

        return result;

    } catch (error) {
        errors.push(
            `Invidious: ${error.message}`
        );
    }

    /* ========================================================
       3. YT-DLP
    ======================================================== */

    try {
        const result =
            await downloadYouTubeWithYtDlp(
                url,
                outputTemplate
            );

        console.log(
            "[YouTube] Download concluído via yt-dlp."
        );

        return result;

    } catch (error) {
        errors.push(
            `yt-dlp: ${error.message}`
        );
    }

    throw new Error(
        "Todas as fontes gratuitas de download do YouTube falharam.\n" +
        errors.join("\n")
    );
}

/* ============================================================
   USUÁRIOS / SESSÕES
============================================================ */

function ensureUser(
    requestedId
) {
    let userId =
        safeString(
            requestedId
        ).trim();

    if (!userId) {
        userId =
            randomId(
                "user_"
            );
    }

    let user =
        users.get(
            userId
        );

    if (!user) {
        user = {
            id: userId,
            points:
                FREE_POINTS,
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

    claimDailyPoints(
        user
    );

    return user;
}

function claimDailyPoints(
    user
) {
    if (!user) return 0;

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

        return DAILY_POINTS;
    }

    return 0;
}

function publicUser(
    user
) {
    return {
        id:
            user.id,

        userId:
            user.id,

        pontos:
            Math.max(
                0,
                Math.floor(
                    user.points
                )
            ),

        points:
            Math.max(
                0,
                Math.floor(
                    user.points
                )
            ),

        isVip:
            Boolean(
                user.vip
            ),

        vip:
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
            .startsWith(
                "bearer "
            )
    ) {
        return header
            .slice(7)
            .trim();
    }

    return "";
}

function createUserSession(
    user
) {
    const token =
        randomToken(48);

    sessions.set(
        token,
        {
            userId:
                user.id,

            createdAt:
                now(),

            expiresAt:
                now() +
                SESSION_TTL_MS
        }
    );

    return token;
}

function getAuthenticatedUser(
    req
) {
    const token =
        getBearerToken(
            req
        );

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
            return (
                users.get(
                    session.userId
                ) ||
                null
            );
        }

        if (session) {
            sessions.delete(
                token
            );
        }
    }

    const headerUser =
        safeString(
            req.headers[
                "x-user-id"
            ]
        ).trim();

    if (headerUser) {
        return (
            users.get(
                headerUser
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
        getAuthenticatedUser(
            req
        );

    if (!user) {
        return jsonError(
            res,
            401,
            "Usuário não autenticado."
        );
    }

    claimDailyPoints(
        user
    );

    req.user =
        user;

    next();
}

function getOwnedUpload(
    user,
    uploadId
) {
    const upload =
        uploads.get(
            uploadId
        );

    if (
        !upload ||
        upload.userId !==
            user.id
    ) {
        return null;
    }

    return upload;
}

/* ============================================================
   SCHEMA / PARSER DE CLIPS
============================================================ */

function normalizeGeminiClips(
    value,
    videoDuration = null
) {
    let rawClips = [];

    if (
        Array.isArray(
            value
        )
    ) {
        rawClips =
            value;

    } else if (
        Array.isArray(
            value?.clips
        )
    ) {
        rawClips =
            value.clips;

    } else if (
        Array.isArray(
            value?.cortes
        )
    ) {
        rawClips =
            value.cortes;

    } else if (
        Array.isArray(
            value?.results
        )
    ) {
        rawClips =
            value.results;
    }

    const result = [];

    for (
        const item
        of rawClips
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

        if (
            !Number.isFinite(
                start
            )
        ) {
            start = 0;
        }

        start =
            Math.max(
                0,
                start
            );

        if (
            !Number.isFinite(
                duration
            ) ||
            duration <= 0
        ) {
            duration =
                Number.isFinite(
                    end
                ) &&
                end > start
                    ? end - start
                    : 30;
        }

        duration =
            clamp(
                duration,
                1,
                90
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
                item.rating ??
                item.pontuacao,
                0
            );

        score =
            clamp(
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

        result.push({
            start:
                Number(
                    start.toFixed(
                        3
                    )
                ),

            end:
                Number(
                    end.toFixed(
                        3
                    )
                ),

            duration:
                Number(
                    duration.toFixed(
                        3
                    )
                ),

            title:
                title ||
                "Corte recomendado",

            description,

            score:
                Number(
                    score.toFixed(
                        1
                    )
                )
        });
    }

    return result.slice(
        0,
        MAX_CLIPS
    );
}

function parseOpenRouterOutput(
    data
) {
    if (!data) {
        throw new Error(
            "Resposta vazia da IA."
        );
    }

    let primaryText =
        "";

    const messageContent =
        data?.choices?.[0]
            ?.message?.content;

    if (
        typeof messageContent ===
        "string"
    ) {
        primaryText =
            messageContent;

    } else if (
        Array.isArray(
            messageContent
        )
    ) {
        for (
            const part
            of messageContent
        ) {
            if (part?.text) {
                primaryText +=
                    part.text +
                    "\n";
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

    function inspect(
        value
    ) {
        if (
            value === null ||
            value === undefined
        ) {
            return null;
        }

        if (
            typeof value ===
            "object"
        ) {
            if (
                Array.isArray(
                    value.clips
                ) ||
                Array.isArray(
                    value.cortes
                ) ||
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
                Array.isArray(
                    value
                )
            ) {
                for (
                    const item
                    of value
                ) {
                    const found =
                        inspect(
                            item
                        );

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
                value
                    .trim()
                    .replace(
                        /^```json/i,
                        ""
                    )
                    .replace(
                        /^```/i,
                        ""
                    )
                    .replace(
                        /```$/i,
                        ""
                    )
                    .trim();

            try {
                return JSON.parse(
                    text
                );
            } catch (_) {}

            const firstBrace =
                text.indexOf(
                    "{"
                );

            const lastBrace =
                text.lastIndexOf(
                    "}"
                );

            if (
                firstBrace >= 0 &&
                lastBrace >
                    firstBrace
            ) {
                try {
                    return JSON.parse(
                        text.slice(
                            firstBrace,
                            lastBrace +
                                1
                        )
                    );
                } catch (_) {}
            }

            const firstBracket =
                text.indexOf(
                    "["
                );

            const lastBracket =
                text.lastIndexOf(
                    "]"
                );

            if (
                firstBracket >= 0 &&
                lastBracket >
                    firstBracket
            ) {
                try {
                    return JSON.parse(
                        text.slice(
                            firstBracket,
                            lastBracket +
                                1
                        )
                    );
                } catch (_) {}
            }
        }

        return null;
    }

    for (
        const candidate
        of possible
    ) {
        const parsed =
            inspect(
                candidate
            );

        if (parsed) {
            return parsed;
        }
    }

    throw new Error(
        "Não foi possível interpretar a resposta da IA."
    );
}

function buildClipPrompt(
    videoDuration
) {
    const durationText =
        Number.isFinite(
            videoDuration
        )
            ? `${videoDuration.toFixed(
                1
            )} segundos`
            : "desconhecida";

    return `
Você é um editor profissional de vídeos verticais para redes sociais.
Analise o vídeo fornecido e selecione os melhores momentos para cortes verticais (Shorts, TikTok, Reels).

Duração do vídeo: ${durationText}

Regras:
1. Encontre momentos de alto engajamento, falas de impacto, ganchos ou narrativas completas.
2. Evite silêncios e introduções vazias.
3. Cortes entre 20 e 60 segundos com início e fim naturais.
4. Selecione até ${MAX_CLIPS} trechos.
5. Retorne estritamente um JSON no seguinte formato exato:
{
  "clips": [
    {
      "start": 10.5,
      "end": 50.0,
      "duration": 39.5,
      "title": "Título atraente do corte",
      "description": "Motivo da escolha do trecho",
      "score": 90
    }
  ]
}
`.trim();
}

/* ============================================================
   TOKENS TEMPORÁRIOS
============================================================ */

function createVideoToken(
    filePath
) {
    const token =
        randomToken(32);

    aiVideoTokens.set(
        token,
        {
            filePath,

            expiresAt:
                now() +
                AI_VIDEO_TOKEN_TTL_MS
        }
    );

    return token;
}

app.get(
    "/api/ai-video/:token",
    (req, res) => {
        const token =
            safeString(
                req.params.token
            ).trim();

        const entry =
            aiVideoTokens.get(
                token
            );

        if (
            !entry ||
            entry.expiresAt <
                now()
        ) {
            if (entry) {
                aiVideoTokens.delete(
                    token
                );
            }

            return res
                .status(404)
                .send(
                    "Vídeo temporário expirado ou não encontrado."
                );
        }

        if (
            !fs.existsSync(
                entry.filePath
            )
        ) {
            return res
                .status(404)
                .send(
                    "Arquivo de vídeo não encontrado no disco."
                );
        }

        return res.sendFile(
            entry.filePath
        );
    }
);

setInterval(
    () => {
        const current =
            now();

        for (
            const [
                token,
                entry
            ]
            of aiVideoTokens.entries()
        ) {
            if (
                entry.expiresAt <
                current
            ) {
                aiVideoTokens.delete(
                    token
                );
            }
        }
    },
    5 * 60 * 1000
).unref();

/* ============================================================
   OPENROUTER
============================================================ */

async function requestOpenRouter(
    model,
    promptText,
    videoUrl = null
) {
    if (
        !OPENROUTER_API_KEY
    ) {
        throw new Error(
            "OPENROUTER_API_KEY não configurada no servidor."
        );
    }

    const controller =
        new AbortController();

    const timeout =
        setTimeout(
            () =>
                controller.abort(),
            120000
        );

    try {
        const contentArray = [
            {
                type:
                    "text",

                text:
                    promptText
            }
        ];

        if (videoUrl) {
            contentArray.push({
                type:
                    "video_url",

                video_url: {
                    url:
                        videoUrl
                }
            });
        }

        const body = {
            model,

            messages: [
                {
                    role:
                        "user",

                    content:
                        contentArray
                }
            ],

            response_format: {
                type:
                    "json_object"
            }
        };

        const response =
            await fetch(
                OPENROUTER_URL,
                {
                    method:
                        "POST",

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

                    body:
                        JSON.stringify(
                            body
                        ),

                    signal:
                        controller.signal
                }
            );

        const text =
            await response.text();

        let data;

        try {
            data =
                JSON.parse(
                    text
                );
        } catch (_) {
            data = {
                raw:
                    text
            };
        }

        if (!response.ok) {
            const err =
                new Error(
                    data?.error?.message ||
                    data?.message ||
                    `OpenRouter HTTP ${response.status}: ${text.slice(
                        0,
                        1000
                    )}`
                );

            err.status =
                response.status;

            err.code =
                data?.error?.code ||
                "";

            throw err;
        }

        return data;

    } finally {
        clearTimeout(
            timeout
        );
    }
}

async function executeOpenRouterWithRetry(
    model,
    promptText,
    videoUrl,
    maxRetries = 2
) {
    let attempt =
        0;

    while (
        attempt <=
        maxRetries
    ) {
        try {
            if (
                attempt > 0
            ) {
                console.log(
                    `[OpenRouter] Tentando novamente ${model} (tentativa ${attempt + 1}/${maxRetries + 1})...`
                );
            }

            return await requestOpenRouter(
                model,
                promptText,
                videoUrl
            );

        } catch (error) {
            const status =
                error.status ||
                0;

            const isTransient =
                [
                    408,
                    429,
                    500,
                    502,
                    503,
                    504
                ].includes(
                    status
                );

            if (
                isTransient &&
                attempt <
                    maxRetries
            ) {
                attempt++;

                metrics.openRouterRetries++;

                const baseDelay =
                    Math.pow(
                        2,
                        attempt
                    ) *
                    1000;

                const jitter =
                    Math.floor(
                        Math.random() *
                            700
                    ) + 100;

                await sleep(
                    baseDelay +
                    jitter
                );

                continue;
            }

            throw error;
        }
    }

    throw new Error(
        "Falha inesperada no OpenRouter."
    );
}

async function analyzeWithOpenRouterFallback({
    promptText,
    videoUrl,
    videoDuration
}) {
    if (
        !OPENROUTER_API_KEY
    ) {
        throw new Error(
            "OPENROUTER_API_KEY não configurada no servidor."
        );
    }

    const errors =
        [];

    const transientStatuses =
        [
            408,
            429,
            500,
            502,
            503,
            504
        ];

    let onlyTransientErrors =
        true;

    for (
        let i = 0;
        i <
        OPENROUTER_MODELS.length;
        i++
    ) {
        const model =
            OPENROUTER_MODELS[i];

        try {
            console.log(
                `[OpenRouter] Tentando modelo: ${model}`
            );

            const response =
                await executeOpenRouterWithRetry(
                    model,
                    promptText,
                    videoUrl,
                    2
                );

            const parsed =
                parseOpenRouterOutput(
                    response
                );

            const clips =
                normalizeGeminiClips(
                    parsed,
                    videoDuration
                );

            if (
                !clips.length
            ) {
                throw new Error(
                    "A IA não retornou cortes válidos."
                );
            }

            console.log(
                `[OpenRouter] Sucesso com ${model}: ${clips.length} cortes obtidos.`
            );

            return {
                model,
                clips,
                raw:
                    response
            };

        } catch (error) {
            console.error(
                `[OpenRouter] ${model} falhou:`,
                error.message
            );

            errors.push(
                `${model}: ${error.message}`
            );

            if (
                !transientStatuses.includes(
                    error.status
                )
            ) {
                onlyTransientErrors =
                    false;
            }

            if (
                i <
                OPENROUTER_MODELS.length -
                    1
            ) {
                metrics.openRouterFallbacks++;

                await sleep(
                    1500
                );
            }
        }
    }

    if (
        onlyTransientErrors &&
        errors.length > 0
    ) {
        throw new Error(
            "O serviço de IA está temporariamente indisponível. Tente novamente em alguns minutos."
        );
    }

    throw new Error(
        `Todos os modelos do OpenRouter falharam.\n` +
        errors.join("\n")
    );
}

/* ============================================================
   ANÁLISE YOUTUBE / UPLOAD
============================================================ */

async function analyzeYouTube(
    url
) {
    let duration =
        null;

    let title =
        "";

    let workDir =
        null;

    let downloadedFile =
        null;

    try {
        workDir =
            await fsp.mkdtemp(
                path.join(
                    TEMP_ROOT,
                    "yt_download_"
                )
            );

        const template =
            path.join(
                workDir,
                "source.%(ext)s"
            );

        const downloaded =
            await downloadYouTubeVideo(
                url,
                template
            );

        downloadedFile =
            downloaded.filePath;

        duration =
            parseNumber(
                downloaded.duration,
                null
            );

        title =
            safeString(
                downloaded.title,
                ""
            );

        if (!duration) {
            try {
                const metadata =
                    await getVideoMetadata(
                        downloadedFile
                    );

                duration =
                    metadata.duration;
            } catch (_) {}
        }

        if (!duration) {
            throw new Error(
                "Não foi possível determinar a duração do vídeo."
            );
        }

        console.log(
            `[YouTube] Fonte utilizada: ${downloaded.source || "desconhecida"}`
        );

        const token =
            createVideoToken(
                downloadedFile
            );

        const videoUrl =
            `${PUBLIC_BASE_URL}/api/ai-video/${token}`;

        const prompt =
            buildClipPrompt(
                duration
            ) +
            `\nURL do Vídeo do YouTube: ${url}` +
            `\nTítulo: ${title}`;

        try {
            const result =
                await analyzeWithOpenRouterFallback(
                    {
                        promptText:
                            prompt,

                        videoUrl,

                        videoDuration:
                            duration
                    }
                );

            await safeRemove(
                workDir
            );

            return result;

        } catch (err) {
            await safeRemove(
                workDir
            );

            throw err;
        }

    } catch (error) {
        if (workDir) {
            await safeRemove(
                workDir
            );
        }

        throw new Error(
            `Erro ao processar YouTube: ${error.message}`
        );
    }
}

async function analyzeUpload(
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

    const token =
        createVideoToken(
            upload.filePath
        );

    const videoUrl =
        `${PUBLIC_BASE_URL}/api/ai-video/${token}`;

    const prompt =
        buildClipPrompt(
            metadata.duration
        ) +
        `\nNome do arquivo: ${upload.originalName}` +
        `\nDuração: ${metadata.duration}s`;

    return analyzeWithOpenRouterFallback(
        {
            promptText:
                prompt,

            videoUrl,

            videoDuration:
                metadata.duration
        }
    );
}

function chargeAnalysis(
    user
) {
    if (user.vip) {
        return 0;
    }

    if (
        user.points <
        ANALYSIS_COST
    ) {
        throw new Error(
            `Pontos insuficientes. Necessário: ${ANALYSIS_COST}. Disponível: ${user.points}.`
        );
    }

    user.points -=
        ANALYSIS_COST;

    return ANALYSIS_COST;
}

/* ============================================================
   AUTENTICAÇÃO
============================================================ */

app.post(
    "/api/auth/login",
    async (req, res) => {
        try {
            const requestedId =
                safeString(
                    req.body?.userId
                ).trim();

            const user =
                ensureUser(
                    requestedId
                );

            const token =
                createUserSession(
                    user
                );

            return res.json({
                ok: true,
                token,
                session:
                    token,
                user:
                    publicUser(
                        user
                    )
            });

        } catch (error) {
            metrics.errors++;

            return jsonError(
                res,
                500,
                error.message
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

        return res.json({
            ok: true,

            user:
                publicUser(
                    req.user
                )
        });
    }
);

/* ============================================================
   UPLOAD
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
                    "Nenhum vídeo foi enviado."
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
                id:
                    uploadId,

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

            return res.json({
                ok: true,

                uploadId,

                id:
                    uploadId,

                duration:
                    metadata.duration,

                file: {
                    id:
                        uploadId,

                    name:
                        item.originalName,

                    size:
                        item.size,

                    mimeType:
                        item.mimeType
                },

                metadata
            });

        } catch (error) {
            metrics.errors++;

            if (
                req.file?.path
            ) {
                await safeRemove(
                    req.file.path
                );
            }

            return jsonError(
                res,
                400,
                error.message
            );
        }
    }
);

app.get(
    "/api/upload/:id",
    requireUser,
    async (
        req,
        res
    ) => {
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
   ANÁLISE IA
============================================================ */

app.post(
    "/api/analisar",
    requireUser,
    async (
        req,
        res
    ) => {
        metrics.analyses++;

        try {
            const {
                url,
                uploadId
            } =
                req.body || {};

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

                let charged =
                    0;

                try {
                    charged =
                        chargeAnalysis(
                            req.user
                        );

                    const result =
                        await analyzeUpload(
                            upload
                        );

                    metrics.successfulAnalyses++;

                    req.user.analyses++;

                    return res.json({
                        ok: true,

                        type:
                            "upload",

                        uploadId,

                        clips:
                            result.clips,

                        model:
                            result.model,

                        user:
                            publicUser(
                                req.user
                            ),

                        charged,

                        version:
                            VERSION
                    });

                } catch (error) {
                    if (
                        charged > 0
                    ) {
                        req.user.points +=
                            charged;
                    }

                    throw error;
                }
            }

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

                let charged =
                    0;

                try {
                    charged =
                        chargeAnalysis(
                            req.user
                        );

                    const result =
                        await analyzeYouTube(
                            normalized
                        );

                    metrics.successfulAnalyses++;

                    req.user.analyses++;

                    return res.json({
                        ok: true,

                        type:
                            "youtube",

                        url:
                            normalized,

                        clips:
                            result.clips,

                        model:
                            result.model,

                        user:
                            publicUser(
                                req.user
                            ),

                        charged,

                        version:
                            VERSION
                    });

                } catch (error) {
                    if (
                        charged > 0
                    ) {
                        req.user.points +=
                            charged;
                    }

                    throw error;
                }
            }

            return jsonError(
                res,
                400,
                "Envie url ou uploadId."
            );

        } catch (error) {
            metrics.failedAnalyses++;
            metrics.errors++;

            console.error(
                "[Análise] ERRO:",
                error.message
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

app.post(
    "/api/analisar-upload",
    requireUser,
    async (
        req,
        res
    ) => {
        metrics.analyses++;

        try {
            const uploadId =
                safeString(
                    req.body?.uploadId
                ).trim();

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

            let charged =
                0;

            try {
                charged =
                    chargeAnalysis(
                        req.user
                    );

                const result =
                    await analyzeUpload(
                        upload
                    );

                metrics.successfulAnalyses++;

                req.user.analyses++;

                return res.json({
                    ok: true,

                    type:
                        "upload",

                    uploadId,

                    clips:
                        result.clips,

                    model:
                        result.model,

                    user:
                        publicUser(
                            req.user
                        ),

                    charged,

                    version:
                        VERSION
                });

            } catch (error) {
                if (
                    charged > 0
                ) {
                    req.user.points +=
                        charged;
                }

                throw error;
            }

        } catch (error) {
            metrics.failedAnalyses++;
            metrics.errors++;

            console.error(
                "[Análise Upload] ERRO:",
                error.message
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
   FFMPEG
============================================================ */

async function renderClip(
    sourceFile,
    outputFile,
    start,
    duration
) {
    if (!FFMPEG_BIN) {
        throw new Error(
            "FFmpeg não está disponível."
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

        "-c",
        "copy",

        "-avoid_negative_ts",
        "make_zero",

        "-movflags",
        "+faststart",

        "-y",

        outputFile
    ];

    const result =
        await spawnCapture(
            FFMPEG_BIN,
            args,
            {
                timeoutMs:
                    120000
            }
        );

    if (
        result.code !== 0
    ) {
        const fallbackArgs = [
            "-hide_banner",
            "-loglevel",
            "error",

            "-ss",
            String(start),

            "-i",
            sourceFile,

            "-t",
            String(duration),

            "-c:v",
            "libx264",

            "-preset",
            "ultrafast",

            "-threads",
            "1",

            "-crf",
            "26",

            "-c:a",
            "aac",

            "-b:a",
            "96k",

            "-movflags",
            "+faststart",

            "-y",

            outputFile
        ];

        const fallbackResult =
            await spawnCapture(
                FFMPEG_BIN,
                fallbackArgs,
                {
                    timeoutMs:
                        120000
                }
            );

        if (
            fallbackResult.code !==
            0
        ) {
            throw new Error(
                `FFmpeg falhou: ${
                    fallbackResult.stderr ||
                    result.stderr
                }`
            );
        }
    }

    const stat =
        await fsp.stat(
            outputFile
        );

    if (
        !stat.isFile() ||
        stat.size <= 0
    ) {
        throw new Error(
            "FFmpeg não produziu um MP4 válido."
        );
    }

    return stat;
}

/* ============================================================
   DOWNLOAD
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
                end,
                uploadId,
                url
            } =
                req.body || {};

            let safeStart =
                parseNumber(
                    start,
                    NaN
                );

            let requestedDuration =
                parseNumber(
                    duration,
                    NaN
                );

            if (
                !Number.isFinite(
                    requestedDuration
                ) &&
                Number.isFinite(
                    parseNumber(
                        end,
                        NaN
                    )
                )
            ) {
                requestedDuration =
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
                safeStart < 0
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
                    "Duração inválida. O corte deve ter entre 0 e 90 segundos."
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
                    `Pontos insuficientes. Necessário: ${DOWNLOAD_COST}. Disponível: ${req.user.points}.`
                );
            }

            let sourceFile =
                null;

            let sourceDuration =
                0;

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

                sourceFile =
                    upload.filePath;

                sourceDuration =
                    parseNumber(
                        upload.metadata
                            ?.duration,
                        0
                    );

                if (
                    !sourceFile ||
                    !fs.existsSync(
                        sourceFile
                    )
                ) {
                    return jsonError(
                        res,
                        404,
                        "Arquivo original não está mais disponível."
                    );
                }
            }

            if (
                !sourceFile &&
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

                const workDir =
                    await fsp.mkdtemp(
                        path.join(
                            TEMP_ROOT,
                            "download_"
                        )
                    );

                const template =
                    path.join(
                        workDir,
                        "source.%(ext)s"
                    );

                try {
                    const downloaded =
                        await downloadYouTubeVideo(
                            normalized,
                            template
                        );

                    sourceFile =
                        downloaded.filePath;

                    sourceDuration =
                        parseNumber(
                            downloaded.duration,
                            0
                        );

                    if (
                        !sourceDuration
                    ) {
                        try {
                            const metadata =
                                await getVideoMetadata(
                                    sourceFile
                                );

                            sourceDuration =
                                metadata.duration;
                        } catch (_) {}
                    }

                    console.log(
                        `[Download] YouTube via ${
                            downloaded.source ||
                            "desconhecido"
                        }`
                    );

                    temporarySource =
                        workDir;

                } catch (error) {
                    await safeRemove(
                        workDir
                    );

                    throw error;
                }
            }

            if (!sourceFile) {
                return jsonError(
                    res,
                    400,
                    "Informe uploadId ou url."
                );
            }

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
                        "O início do corte está além do fim do vídeo."
                    );
                }

                requestedDuration =
                    Math.min(
                        requestedDuration,
                        sourceDuration -
                            safeStart
                    );
            }

            requestedDuration =
                Math.min(
                    requestedDuration,
                    90
                );

            outputFile =
                path.join(
                    OUTPUT_DIR,
                    `${randomId(
                        "clip_"
                    )}.mp4`
                );

            await renderClip(
                sourceFile,
                outputFile,
                safeStart,
                requestedDuration
            );

            const stat =
                await fsp.stat(
                    outputFile
                );

            if (!req.user.vip) {
                req.user.points -=
                    DOWNLOAD_COST;
            }

            req.user.downloads++;

            metrics.downloads++;

            const filename =
                `clipforge_${Date.now()}.mp4`;

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
                "no-store, no-cache, must-revalidate, proxy-revalidate"
            );

            res.setHeader(
                "Pragma",
                "no-cache"
            );

            res.setHeader(
                "Expires",
                "0"
            );

            res.setHeader(
                "X-ClipForge-Version",
                VERSION
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

            let cleaned =
                false;

            const cleanupAfterStream =
                async () => {
                    if (cleaned) {
                        return;
                    }

                    cleaned =
                        true;

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
                "error",
                async (
                    error
                ) => {
                    console.error(
                        "[Download] Stream:",
                        error.message
                    );

                    await cleanupAfterStream();

                    if (
                        !res.headersSent
                    ) {
                        res.status(
                            500
                        ).json({
                            ok:
                                false,

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
                cleanupAfterStream
            );

            res.on(
                "close",
                () => {
                    cleanupAfterStream()
                        .catch(
                            () => {}
                        );
                }
            );

            stream.pipe(
                res
            );

            return;

        } catch (error) {
            metrics.errors++;

            console.error(
                "[Download] ERRO:",
                error.message
            );

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
        }
    }
);

/* ============================================================
   MERCADO PAGO / PIX
   MANTIDO INTACTO
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
                "Mercado Pago não está configurado no servidor."
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
                await criarPagamentoPix({
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
                });

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

            return res.json({
                ok: true,

                id:
                    paymentId,

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

        } catch (error) {
            metrics.errors++;

            console.error(
                "[PIX] ERRO:",
                error.message
            );

            return jsonError(
                res,
                502,
                error.message
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
                localPayment &&
                localPayment.userId !==
                    req.user.id
            ) {
                return jsonError(
                    res,
                    403,
                    "Pagamento não pertence a este usuário."
                );
            }

            const payment =
                await consultarPagamentoPix(
                    paymentId
                );

            const approved =
                payment.status ===
                "approved";

            if (
                localPayment
            ) {
                localPayment.status =
                    payment.status;
            }

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
                    )
            });

        } catch (error) {
            metrics.errors++;

            return jsonError(
                res,
                502,
                error.message
            );
        }
    }
);

/* ============================================================
   ADMIN
============================================================ */

app.post(
    "/api/admin/login",
    async (
        req,
        res
    ) => {
        if (!ADMIN_PASSWORD) {
            return jsonError(
                res,
                503,
                "ADMIN_PASSWORD não configurada no Render."
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

        return res.json({
            ok: true,

            token,

            session:
                token
        });
    }
);

function requireAdmin(
    req,
    res,
    next
) {
    const headerToken =
        safeString(
            req.headers[
                "x-admin-session"
            ]
        ).trim();

    const token =
        headerToken ||
        getBearerToken(
            req
        );

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
        session.expiresAt <
        now()
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

    req.admin =
        true;

    next();
}

app.get(
    "/api/admin/dashboard",
    requireAdmin,
    (req, res) => {
        let vipUsers =
            0;

        let totalPoints =
            0;

        let totalDownloads =
            0;

        let totalAnalyses =
            0;

        for (
            const user
            of users.values()
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
                user.downloads ||
                0;

            totalAnalyses +=
                user.analyses ||
                0;
        }

        const memory =
            process.memoryUsage();

        return res.json({
            ok: true,

            version:
                VERSION,

            metrics: {
                requests:
                    metrics.requests,

                analyses:
                    metrics.analyses,

                successfulAnalyses:
                    metrics.successfulAnalyses,

                failedAnalyses:
                    metrics.failedAnalyses,

                downloads:
                    metrics.downloads,

                pixCreated:
                    metrics.pixCreated,

                pixApproved:
                    metrics.pixApproved,

                openRouterRetries:
                    metrics.openRouterRetries,

                openRouterFallbacks:
                    metrics.openRouterFallbacks,

                users:
                    users.size,

                vipUsers,

                totalPoints,

                totalDownloads,

                totalAnalyses,

                errors:
                    metrics.errors
            },

            memory: {
                rss:
                    memory.rss,

                heapUsed:
                    memory.heapUsed,

                heapTotal:
                    memory.heapTotal,

                external:
                    memory.external
            },

            uptime:
                process.uptime()
        });
    }
);

/* ============================================================
   HEALTH
============================================================ */

app.get(
    "/health",
    async (
        req,
        res
    ) => {
        const ffmpeg =
            await commandExists(
                FFMPEG_BIN,
                ["-version"]
            ).catch(
                () => false
            );

        const ffprobe =
            await commandExists(
                FFPROBE_BIN,
                ["-version"]
            ).catch(
                () => false
            );

        const ytdlp =
            await commandExists(
                YTDLP_BIN,
                ["--version"]
            ).catch(
                () => false
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

            openRouter: {
                configured:
                    Boolean(
                        OPENROUTER_API_KEY
                    ),

                primaryModel:
                    OPENROUTER_MODEL,

                fallbackModels:
                    OPENROUTER_FALLBACK_MODELS,

                url:
                    OPENROUTER_URL
            },

            binaries: {
                ffmpeg,

                ffprobe,

                ytDlp:
                    ytdlp
            },

            youtube: {
                sourceTimeoutMs:
                    YOUTUBE_SOURCE_TIMEOUT_MS,

                downloadTimeoutMs:
                    YOUTUBE_DOWNLOAD_TIMEOUT_MS,

                metadataTimeoutMs:
                    YOUTUBE_METADATA_TIMEOUT_MS,

                pipedInstances:
                    PIPED_API_URLS,

                invidiousInstances:
                    INVIDIOUS_API_URLS,

                fallback:
                    "yt-dlp"
            },

            upload: {
                maxMB:
                    MAX_UPLOAD_MB,

                format:
                    "MP4"
            },

            mercadoPago: {
                configured:
                    MP_CONFIGURED
            },

            metrics
        });
    }
);

app.get(
    "/",
    (req, res) => {
        return res.json({
            ok: true,

            service:
                "ClipForge Pro",

            version:
                VERSION,

            status:
                "online",

            message:
                "Backend online via OpenRouter com Multi-Source YouTube.",

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
    }
);

/* ============================================================
   LIMPEZA AUTOMÁTICA
============================================================ */

async function cleanupExpiredUploads() {
    const expiration =
        now() -
        UPLOAD_TTL_MS;

    for (
        const [
            uploadId,
            upload
        ]
        of uploads.entries()
    ) {
        if (
            upload.createdAt <
            expiration
        ) {
            await safeRemove(
                upload.filePath
            );

            uploads.delete(
                uploadId
            );
        }
    }
}

setInterval(
    () => {
        cleanupExpiredUploads()
            .catch(
                (err) =>
                    console.error(
                        "[Cleanup]",
                        err.message
                    )
            );
    },
    15 * 60 * 1000
).unref();

setInterval(
    () => {
        const timestamp =
            now();

        for (
            const [
                token,
                session
            ]
            of sessions.entries()
        ) {
            if (
                session.expiresAt <
                timestamp
            ) {
                sessions.delete(
                    token
                );
            }
        }

        for (
            const [
                token,
                session
            ]
            of adminSessions.entries()
        ) {
            if (
                session.expiresAt <
                timestamp
            ) {
                adminSessions.delete(
                    token
                );
            }
        }
    },
    15 * 60 * 1000
).unref();

/* ============================================================
   TRATAMENTO DE ERROS
============================================================ */

app.use(
    (req, res) => {
        return jsonError(
            res,
            404,
            "Endpoint não encontrado."
        );
    }
);

app.use(
    (
        error,
        req,
        res,
        next
    ) => {
        metrics.errors++;

        console.error(
            "[Server Error]",
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
                error.message
            );
        }

        if (
            error?.message ===
            "Apenas arquivos MP4 são suportados."
        ) {
            return jsonError(
                res,
                400,
                error.message
            );
        }

        if (
            res.headersSent
        ) {
            return next(
                error
            );
        }

        return jsonError(
            res,
            500,
            error.message ||
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

        await resolveBinaries();

        await cleanupExpiredUploads();

        if (
            !OPENROUTER_API_KEY
        ) {
            console.warn(
                "[OpenRouter] AVISO: OPENROUTER_API_KEY não configurada."
            );
        }

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
            `[Server] Node.js: ${process.version}`
        );

        console.log(
            `[Server] Host: ${HOST}`
        );

        console.log(
            `[Server] Port: ${PORT}`
        );

        console.log(
            `[OpenRouter] Primary Model: ${OPENROUTER_MODEL}`
        );

        console.log(
            `[OpenRouter] Fallbacks: ${OPENROUTER_FALLBACK_MODELS.join(
                ", "
            )}`
        );

        console.log(
            `[OpenRouter] API Key: ${
                OPENROUTER_API_KEY
                    ? "CONFIGURADA"
                    : "NÃO CONFIGURADA"
            }`
        );

        console.log(
            `[Mercado Pago] ${
                MP_CONFIGURED
                    ? "CONFIGURADO"
                    : "NÃO CONFIGURADO"
            }`
        );

        console.log(
            `[Upload] Limite: ${MAX_UPLOAD_MB} MB (MP4)`
        );

        console.log(
            `[YouTube] Piped: ${PIPED_API_URLS.length} instâncias`
        );

        console.log(
            `[YouTube] Invidious: ${INVIDIOUS_API_URLS.length} instâncias`
        );

        console.log(
            `[YouTube] Timeout fonte: ${YOUTUBE_SOURCE_TIMEOUT_MS}ms`
        );

        console.log(
            `[YouTube] Timeout download: ${YOUTUBE_DOWNLOAD_TIMEOUT_MS}ms`
        );

        console.log(
            `[YouTube] Timeout metadados: ${YOUTUBE_METADATA_TIMEOUT_MS}ms`
        );

        console.log(
            `[YouTube] Fallback final: yt-dlp`
        );

        console.log(
            "===================================================="
        );

        app.listen(
            PORT,
            HOST,
            () => {
                console.log("");

                console.log(
                    `🚀 ClipForge Pro ${VERSION} online`
                );

                console.log(
                    `🌐 http://${HOST}:${PORT}`
                );

                console.log(
                    "❤️ /health"
                );

                console.log("");
            }
        );

    } catch (error) {
        console.error(
            "[Startup] FATAL ERROR:",
            error
        );

        process.exit(
            1
        );
    }
}

startServer();