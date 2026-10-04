/**
 * ============================================================
 * CLIPFORGE PRO — BACKEND V16.0.2 COMERCIAL CONSOLIDADO
 * ============================================================
 * Base: V16.0.1
 *
 * PRINCIPAIS CORREÇÕES:
 * - URL YouTube sem Markdown
 * - CORS sem Markdown
 * - Proteção de transações de pontos
 * - Commit/estorno seguro no download
 * - PIX idempotente com validação de usuário
 * - Proteção de external_reference
 * - Limpeza de uploads protegendo jobs ativos
 * - Cookies yt-dlp com permissão restrita
 * - Persistência PostgreSQL reforçada
 * - Mantida compatibilidade com frontend existente
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

/* ============================================================
   MERCADO PAGO
============================================================ */

let criarPagamentoPix = null;
let consultarPagamentoPix = null;

try {
    const mpModule = require("./mercadoPago");

    criarPagamentoPix = mpModule.criarPagamentoPix;
    consultarPagamentoPix = mpModule.consultarPagamentoPix;

    console.log("[MercadoPago] Modulo carregado.");
} catch (_) {
    console.warn(
        "[MercadoPago] Modulo ./mercadoPago nao encontrado. Operando em contingencia."
    );
}

/* ============================================================
   POSTGRESQL
============================================================ */

let pgPool = null;

const DATABASE_URL = process.env.DATABASE_URL || "";

if (DATABASE_URL) {
    try {
        const { Pool } = require("pg");

        pgPool = new Pool({
            connectionString: DATABASE_URL,
            ssl:
                process.env.NODE_ENV === "production"
                    ? { rejectUnauthorized: false }
                    : false,
            max: Number(process.env.PG_POOL_MAX || 10),
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000
        });

        console.log("[Database] Driver PostgreSQL configurado.");
    } catch (error) {
        console.warn(
            "[Database] Pacote 'pg' nao instalado ou falhou ao carregar:",
            error.message
        );
    }
}

const app = express();

/* ============================================================
   CONFIGURAÇÃO PRINCIPAL
============================================================ */

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";

const VERSION = "16.0.2-commercial-engine";

const IS_PROD =
    String(process.env.NODE_ENV || "").toLowerCase() === "production";

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 150);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;

const SESSION_TTL_MS =
    30 * 24 * 60 * 60 * 1000;

const ADMIN_SESSION_TTL_MS =
    24 * 60 * 60 * 1000;

const VIP_DURATION_MS =
    30 * 24 * 60 * 60 * 1000;

/* ============================================================
   PONTOS
============================================================ */

const FREE_POINTS = Number(
    process.env.FREE_POINTS || 200
);

const DAILY_POINTS = Number(
    process.env.DAILY_POINTS || 50
);

const ANALYSIS_COST = Number(
    process.env.ANALYSIS_COST || 20
);

const DOWNLOAD_COST = Number(
    process.env.DOWNLOAD_COST || 50
);

const VIP_PRICE = Number(
    process.env.VIP_PRICE || 19.90
);

const POINTS_PACKAGE_PRICE = Number(
    process.env.POINTS_PACKAGE_PRICE || 9.90
);

const POINTS_PACKAGE_AMOUNT = Number(
    process.env.POINTS_PACKAGE_AMOUNT || 500
);

const MAX_CLIPS = Number(
    process.env.MAX_CLIPS || 8
);

const CONCURRENT_JOBS_LIMIT = 1;

const MAX_QUEUE_LENGTH = 25;

/* ============================================================
   DIRETÓRIOS
============================================================ */

const DATA_DIR =
    process.env.DATA_DIR ||
    path.join(__dirname, "data");

const DB_FILE =
    path.join(DATA_DIR, "database.json");

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
   OPENROUTER
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

const OPENROUTER_FALLBACK_MODELS = (
    process.env.OPENROUTER_FALLBACK_MODELS ||
    [
        "google/gemini-2.5-flash",
        "google/gemini-2.5-flash-lite",
        "google/gemini-2.0-flash-exp:free"
    ].join(",")
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

const PUBLIC_BASE_URL = (
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    ""
).replace(/\/+$/, "");

const OPENROUTER_SITE_URL =
    process.env.OPENROUTER_SITE_URL ||
    "https://cortesdomnr.vercel.app";

const OPENROUTER_SITE_NAME =
    process.env.OPENROUTER_SITE_NAME ||
    "ClipForge Pro";

/* ============================================================
   MERCADO PAGO
============================================================ */

const MP_CONFIGURED = Boolean(
    (
        process.env.MP_ACCESS_TOKEN ||
        process.env.MERCADO_PAGO_ACCESS_TOKEN
    ) &&
    typeof criarPagamentoPix === "function" &&
    typeof consultarPagamentoPix === "function"
);

const MP_WEBHOOK_URL =
    process.env.MP_WEBHOOK_URL ||
    process.env.MERCADO_PAGO_WEBHOOK_URL ||
    (
        PUBLIC_BASE_URL
            ? `${PUBLIC_BASE_URL}/api/pix/webhook`
            : ""
    );

/* ============================================================
   ADMIN
============================================================ */

const ADMIN_EMAIL =
    (
        process.env.ADMIN_EMAIL ||
        "admin@clipforge.local"
    )
        .trim()
        .toLowerCase();

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD ||
    "";

/* ============================================================
   YT-DLP COOKIES
============================================================ */

let YTDLP_COOKIES_FILE =
    process.env.YTDLP_COOKIES_FILE ||
    process.env.YOUTUBE_COOKIES_FILE ||
    "";

const YTDLP_COOKIES_BASE64 =
    process.env.YTDLP_COOKIES_BASE64 ||
    "";

const YTDLP_COOKIES_URL =
    process.env.YTDLP_COOKIES_URL ||
    "";

const YTDLP_USERNAME =
    process.env.YTDLP_USERNAME ||
    "";

const YTDLP_PASSWORD =
    process.env.YTDLP_PASSWORD ||
    "";

/* ============================================================
   TIMEOUTS
============================================================ */

const YOUTUBE_SOURCE_TIMEOUT_MS = Number(
    process.env.YOUTUBE_SOURCE_TIMEOUT_MS || 15000
);

const YOUTUBE_DOWNLOAD_TIMEOUT_MS = Number(
    process.env.YOUTUBE_DOWNLOAD_TIMEOUT_MS || 300000
);

/* ============================================================
   FALLBACKS YOUTUBE
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
    .map((x) => x.trim().replace(/\/+$/, ""))
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
    .map((x) => x.trim().replace(/\/+$/, ""))
    .filter(Boolean);

/* ============================================================
   BINÁRIOS
============================================================ */

let FFMPEG_BIN = "ffmpeg";
let FFPROBE_BIN = "ffprobe";

let YTDLP_BIN =
    path.join(__dirname, "bin", "yt-dlp");

/* ============================================================
   ESTADOS
============================================================ */

const users = new Map();
const sessions = new Map();
const adminSessions = new Map();
const uploads = new Map();
const payments = new Map();
const processedWebhookEvents = new Set();
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
    revenueTotal: 0,
    openRouterRetries: 0,
    openRouterFallbacks: 0,
    errors: 0
};

/* ============================================================
   RATE LIMIT
============================================================ */

const rateLimitMap = new Map();

function checkRateLimit(
    key,
    maxRequests,
    windowMs
) {
    const current = Date.now();

    let record = rateLimitMap.get(key);

    if (
        !record ||
        current - record.startTime > windowMs
    ) {
        record = {
            count: 1,
            startTime: current
        };

        rateLimitMap.set(key, record);

        return true;
    }

    if (record.count >= maxRequests) {
        return false;
    }

    record.count++;

    return true;
}

function rateLimitMiddleware(
    limit,
    windowMs
) {
    return (req, res, next) => {
        const ip =
            req.ip ||
            req.connection?.remoteAddress ||
            "global";

        const key =
            req.path + ":" + ip;

        if (
            !checkRateLimit(
                key,
                limit,
                windowMs
            )
        ) {
            return res.status(429).json({
                ok: false,
                error:
                    "Muitas requisicoes. Aguarde um instante antes de tentar novamente."
            });
        }

        next();
    };
}

setInterval(() => {
    const current = Date.now();

    for (
        const [key, record]
        of rateLimitMap.entries()
    ) {
        if (
            current - record.startTime >
            300000
        ) {
            rateLimitMap.delete(key);
        }
    }
}, 10 * 60 * 1000).unref();

/* ============================================================
   UTILITÁRIOS
============================================================ */

const now = () => Date.now();

const sleep = (ms) =>
    new Promise((resolve) =>
        setTimeout(resolve, ms)
    );

const randomToken = (bytes = 32) =>
    crypto
        .randomBytes(bytes)
        .toString("hex");

const randomId = (prefix = "") =>
    prefix + crypto.randomUUID();

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

async function safeRemove(
    filePath
) {
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

    await fsp.mkdir(
        DATA_DIR,
        { recursive: true }
    );
}

/* ============================================================
   PROCESSOS COM TIMEOUT
============================================================ */

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
                    clearTimeout(
                        timeoutTimer
                    );
                    timeoutTimer = null;
                }

                if (killTimer) {
                    clearTimeout(
                        killTimer
                    );
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
                    stdout +=
                        chunk.toString();

                    if (
                        stdout.length >
                        250000
                    ) {
                        stdout =
                            stdout.slice(
                                -250000
                            );
                    }
                }
            );

            child.stderr?.on(
                "data",
                (chunk) => {
                    stderr +=
                        chunk.toString();

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
                (
                    code,
                    signal
                ) => {
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

                    finishResolve({
                        code,
                        signal,
                        stdout,
                        stderr
                    });
                }
            );

            if (
                Number.isFinite(
                    timeoutMs
                ) &&
                timeoutMs > 0
            ) {
                timeoutTimer =
                    setTimeout(() => {
                        if (finished) return;

                        timedOut = true;

                        try {
                            child.kill(
                                "SIGTERM"
                            );
                        } catch (_) {}

                        killTimer =
                            setTimeout(() => {
                                if (finished)
                                    return;

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

        if (installerFfmpeg?.path) {
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
   METADADOS
============================================================ */

async function getVideoMetadata(
    filePath
) {
    if (!FFPROBE_BIN) {
        throw new Error(
            "FFprobe nao disponivel."
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
            "FFprobe retornou JSON invalido."
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
            (s) =>
                s.codec_type ===
                "video"
        ) || null;

    const audioStream =
        streams.find(
            (s) =>
                s.codec_type ===
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
            "Arquivo de video nao informado."
        );
    }

    const stat =
        await fsp.stat(filePath);

    if (!stat.isFile()) {
        throw new Error(
            "O caminho nao e um arquivo."
        );
    }

    if (stat.size <= 10000) {
        throw new Error(
            "Arquivo vazio ou corrompido."
        );
    }

    if (
        stat.size >
        MAX_UPLOAD_BYTES
    ) {
        throw new Error(
            `Video excede limite de ${MAX_UPLOAD_MB} MB.`
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
            "Nao foi possivel obter a duracao do video."
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
                        "Apenas arquivos MP4 sao suportados."
                    )
                );
            }

            cb(null, true);
        }
    });

/* ============================================================
   MAPPERS
============================================================ */

function mapDbUserToInternal(
    row
) {
    if (!row) return null;

    return {
        id: String(row.id),

        points:
            Number(
                row.points || 0
            ),

        reservedPoints:
            Number(
                row.reserved_points ||
                    0
            ),

        vip:
            Boolean(row.vip),

        vipUntil:
            row.vip_until
                ? Number(
                      row.vip_until
                  )
                : null,

        createdAt:
            Number(
                row.created_at ||
                    Date.now()
            ),

        lastDailyClaim:
            row.last_daily_claim
                ? Number(
                      row.last_daily_claim
                  )
                : Date.now(),

        downloads:
            Number(
                row.downloads || 0
            ),

        analyses:
            Number(
                row.analyses || 0
            )
    };
}

function mapDbPaymentToInternal(
    row
) {
    if (!row) return null;

    return {
        id: String(row.id),

        userId:
            row.user_id
                ? String(row.user_id)
                : "",

        itemType:
            String(
                row.item_type ||
                    "vip"
            ),

        pointsAmount:
            Number(
                row.points_amount ||
                    0
            ),

        amount:
            Number(
                row.amount || 0
            ),

        status:
            String(
                row.status ||
                    "pending"
            ),

        createdAt:
            Number(
                row.created_at ||
                    Date.now()
            ),

        approvedAt:
            row.approved_at
                ? Number(
                      row.approved_at
                  )
                : null,

        externalReference:
            String(
                row.external_reference ||
                    ""
            )
    };
}

/* ============================================================
   PERSISTÊNCIA
============================================================ */

let saveDbTimeout = null;

function scheduleDatabaseSave() {
    if (saveDbTimeout) return;

    saveDbTimeout =
        setTimeout(
            async () => {
                saveDbTimeout = null;

                try {
                    const data = {
                        users:
                            Array.from(
                                users.values()
                            ),

                        payments:
                            Array.from(
                                payments.values()
                            ),

                        processedWebhooks:
                            Array.from(
                                processedWebhookEvents.values()
                            ),

                        metrics: {
                            revenueTotal:
                                metrics.revenueTotal,

                            pixApproved:
                                metrics.pixApproved
                        },

                        savedAt:
                            Date.now()
                    };

                    const tempFile =
                        DB_FILE +
                        ".tmp";

                    await fsp.writeFile(
                        tempFile,
                        JSON.stringify(
                            data,
                            null,
                            2
                        ),
                        "utf-8"
                    );

                    await fsp.rename(
                        tempFile,
                        DB_FILE
                    );
                } catch (error) {
                    console.error(
                        "[Database] Erro ao salvar database.json:",
                        error.message
                    );
                }
            },
            1000
        );
}

async function persistUserData(
    user
) {
    if (!user) return;

    if (pgPool) {
        await pgPool.query(
            `
            INSERT INTO users
            (
                id,
                points,
                reserved_points,
                vip,
                vip_until,
                created_at,
                last_daily_claim,
                downloads,
                analyses
            )
            VALUES
            (
                $1,$2,$3,$4,$5,$6,$7,$8,$9
            )
            ON CONFLICT (id)
            DO UPDATE SET
                points = EXCLUDED.points,
                reserved_points = EXCLUDED.reserved_points,
                vip = EXCLUDED.vip,
                vip_until = EXCLUDED.vip_until,
                last_daily_claim = EXCLUDED.last_daily_claim,
                downloads = EXCLUDED.downloads,
                analyses = EXCLUDED.analyses
            `,
            [
                user.id,
                user.points,
                user.reservedPoints || 0,
                Boolean(user.vip),
                user.vipUntil || null,
                user.createdAt,
                user.lastDailyClaim,
                user.downloads || 0,
                user.analyses || 0
            ]
        );

        return;
    }

    scheduleDatabaseSave();
}

async function persistPaymentData(
    payment
) {
    if (!payment) return;

    if (pgPool) {
        await pgPool.query(
            `
            INSERT INTO payments
            (
                id,
                user_id,
                item_type,
                points_amount,
                amount,
                status,
                created_at,
                approved_at,
                external_reference
            )
            VALUES
            (
                $1,$2,$3,$4,$5,$6,$7,$8,$9
            )
            ON CONFLICT (id)
            DO UPDATE SET
                user_id = EXCLUDED.user_id,
                item_type = EXCLUDED.item_type,
                points_amount = EXCLUDED.points_amount,
                amount = EXCLUDED.amount,
                status = EXCLUDED.status,
                approved_at = EXCLUDED.approved_at,
                external_reference = EXCLUDED.external_reference
            `,
            [
                payment.id,
                payment.userId,
                payment.itemType,
                payment.pointsAmount || 0,
                payment.amount,
                payment.status,
                payment.createdAt,
                payment.approvedAt || null,
                payment.externalReference ||
                    ""
            ]
        );

        return;
    }

    scheduleDatabaseSave();
}

/* ============================================================
   BANCO
============================================================ */

async function initDatabase() {
    if (pgPool) {
        try {
            await pgPool.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id VARCHAR(64) PRIMARY KEY,
                    points NUMERIC DEFAULT 200,
                    reserved_points NUMERIC DEFAULT 0,
                    vip BOOLEAN DEFAULT FALSE,
                    vip_until BIGINT,
                    created_at BIGINT,
                    last_daily_claim BIGINT,
                    downloads INT DEFAULT 0,
                    analyses INT DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS payments (
                    id VARCHAR(64) PRIMARY KEY,
                    user_id VARCHAR(64),
                    item_type VARCHAR(32),
                    points_amount INT DEFAULT 0,
                    amount NUMERIC,
                    status VARCHAR(32),
                    created_at BIGINT,
                    approved_at BIGINT,
                    external_reference TEXT
                );

                CREATE TABLE IF NOT EXISTS webhooks (
                    event_key VARCHAR(128) PRIMARY KEY,
                    created_at BIGINT
                );
            `);

            /*
             * Índice único separado.
             * Se existir banco antigo com referências duplicadas,
             * não derrubamos o servidor inteiro.
             */
            try {
                await pgPool.query(`
                    CREATE UNIQUE INDEX IF NOT EXISTS
                    payments_external_reference_uq
                    ON payments(external_reference)
                    WHERE external_reference IS NOT NULL
                    AND external_reference <> ''
                `);
            } catch (indexError) {
                console.warn(
                    "[Database] Nao foi possivel criar indice unico de external_reference:",
                    indexError.message
                );
            }

            const usersRes =
                await pgPool.query(
                    "SELECT * FROM users"
                );

            for (
                const row
                of usersRes.rows
            ) {
                const user =
                    mapDbUserToInternal(
                        row
                    );

                users.set(
                    user.id,
                    user
                );
            }

            const paymentsRes =
                await pgPool.query(
                    "SELECT * FROM payments"
                );

            for (
                const row
                of paymentsRes.rows
            ) {
                const payment =
                    mapDbPaymentToInternal(
                        row
                    );

                payments.set(
                    payment.id,
                    payment
                );
            }

            const webhooksRes =
                await pgPool.query(
                    "SELECT event_key FROM webhooks"
                );

            for (
                const row
                of webhooksRes.rows
            ) {
                processedWebhookEvents.add(
                    row.event_key
                );
            }

            const revenueRes =
                await pgPool.query(
                    `
                    SELECT
                        COUNT(*) AS approved_count,
                        COALESCE(
                            SUM(amount),
                            0
                        ) AS total_revenue
                    FROM payments
                    WHERE status = 'approved'
                    `
                );

            if (
                revenueRes.rows.length
            ) {
                metrics.pixApproved =
                    Number(
                        revenueRes.rows[0]
                            .approved_count ||
                            0
                    );

                metrics.revenueTotal =
                    Number(
                        revenueRes.rows[0]
                            .total_revenue ||
                            0
                    );
            }

            console.log(
                `[Database] PostgreSQL sincronizado: ${users.size} usuarios, ${payments.size} pagamentos, R$ ${metrics.revenueTotal.toFixed(2)} faturados.`
            );

            return;
        } catch (error) {
            console.error(
                "[Database] Erro critico ao conectar/inicializar Postgres:",
                error.message
            );

            if (IS_PROD) {
                throw new Error(
                    "Falha critica ao conectar no PostgreSQL em producao. Abortando inicializacao."
                );
            }

            pgPool = null;
        }
    }

    if (IS_PROD) {
        throw new Error(
            "DATABASE_URL obrigatoria em producao. O Render necessita de PostgreSQL para dados comerciais."
        );
    }

    try {
        await fsp.mkdir(
            DATA_DIR,
            {
                recursive: true
            }
        );

        if (
            fs.existsSync(
                DB_FILE
            )
        ) {
            const content =
                await fsp.readFile(
                    DB_FILE,
                    "utf-8"
                );

            const data =
                JSON.parse(content);

            if (
                Array.isArray(
                    data.users
                )
            ) {
                for (
                    const user
                    of data.users
                ) {
                    users.set(
                        user.id,
                        user
                    );
                }
            }

            if (
                Array.isArray(
                    data.payments
                )
            ) {
                for (
                    const payment
                    of data.payments
                ) {
                    payments.set(
                        String(
                            payment.id
                        ),
                        payment
                    );
                }
            }

            if (
                Array.isArray(
                    data.processedWebhooks
                )
            ) {
                for (
                    const event
                    of data.processedWebhooks
                ) {
                    processedWebhookEvents.add(
                        event
                    );
                }
            }

            if (
                data.metrics &&
                typeof data.metrics ===
                    "object"
            ) {
                metrics.revenueTotal =
                    Number(
                        data.metrics
                            .revenueTotal ||
                            0
                    );

                metrics.pixApproved =
                    Number(
                        data.metrics
                            .pixApproved ||
                            0
                    );
            }

            console.log(
                `[Database] Armazenamento local carregado (${users.size} usuarios, ${payments.size} pagamentos).`
            );
        }
    } catch (error) {
        console.warn(
            "[Database] Falha ao ler database.json local:",
            error.message
        );
    }
}

/* ============================================================
   PONTOS
============================================================ */

function isUserVip(user) {
    if (!user) return false;

    if (!user.vip) return false;

    if (
        user.vipUntil &&
        user.vipUntil < now()
    ) {
        user.vip = false;

        persistUserData(
            user
        ).catch(() => {});

        return false;
    }

    return true;
}

async function reservePoints(
    user,
    cost
) {
    if (!user) return 0;

    if (isUserVip(user)) {
        return 0;
    }

    if (pgPool) {
        const client =
            await pgPool.connect();

        try {
            await client.query(
                "BEGIN"
            );

            const result =
                await client.query(
                    `
                    SELECT *
                    FROM users
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [user.id]
                );

            if (
                !result.rows.length
            ) {
                await client.query(
                    "ROLLBACK"
                );

                return -1;
            }

            const dbUser =
                mapDbUserToInternal(
                    result.rows[0]
                );

            if (
                isUserVip(dbUser)
            ) {
                await client.query(
                    "COMMIT"
                );

                user.vip =
                    dbUser.vip;

                user.vipUntil =
                    dbUser.vipUntil;

                return 0;
            }

            if (
                dbUser.points <
                cost
            ) {
                await client.query(
                    "ROLLBACK"
                );

                return -1;
            }

            const newPoints =
                dbUser.points -
                cost;

            const newReserved =
                (
                    dbUser.reservedPoints ||
                    0
                ) + cost;

            await client.query(
                `
                UPDATE users
                SET
                    points = $1,
                    reserved_points = $2
                WHERE id = $3
                `,
                [
                    newPoints,
                    newReserved,
                    user.id
                ]
            );

            await client.query(
                "COMMIT"
            );

            user.points =
                newPoints;

            user.reservedPoints =
                newReserved;

            return cost;
        } catch (error) {
            try {
                await client.query(
                    "ROLLBACK"
                );
            } catch (_) {}

            console.error(
                "[Points/Tx] Erro ao reservar pontos:",
                error.message
            );

            return -1;
        } finally {
            client.release();
        }
    }

    if (
        user.points <
        cost
    ) {
        return -1;
    }

    user.points -= cost;

    user.reservedPoints =
        (
            user.reservedPoints ||
            0
        ) + cost;

    await persistUserData(
        user
    );

    return cost;
}

async function commitPoints(
    user,
    reservedAmount
) {
    if (
        !user ||
        reservedAmount <= 0
    ) {
        return;
    }

    if (pgPool) {
        const client =
            await pgPool.connect();

        try {
            await client.query(
                "BEGIN"
            );

            const result =
                await client.query(
                    `
                    SELECT *
                    FROM users
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [user.id]
                );

            if (
                !result.rows.length
            ) {
                throw new Error(
                    "Usuario nao encontrado ao consolidar pontos."
                );
            }

            const dbUser =
                mapDbUserToInternal(
                    result.rows[0]
                );

            const newReserved =
                Math.max(
                    0,
                    (
                        dbUser.reservedPoints ||
                        0
                    ) -
                        reservedAmount
                );

            await client.query(
                `
                UPDATE users
                SET reserved_points = $1
                WHERE id = $2
                `,
                [
                    newReserved,
                    user.id
                ]
            );

            await client.query(
                "COMMIT"
            );

            user.reservedPoints =
                newReserved;

            return;
        } catch (error) {
            try {
                await client.query(
                    "ROLLBACK"
                );
            } catch (_) {}

            console.error(
                "[Points/Tx] Erro no commit:",
                error.message
            );

            throw error;
        } finally {
            client.release();
        }
    }

    user.reservedPoints =
        Math.max(
            0,
            (
                user.reservedPoints ||
                0
            ) -
                reservedAmount
        );

    await persistUserData(
        user
    );
}

async function refundPoints(
    user,
    reservedAmount
) {
    if (
        !user ||
        reservedAmount <= 0
    ) {
        return;
    }

    if (pgPool) {
        const client =
            await pgPool.connect();

        try {
            await client.query(
                "BEGIN"
            );

            const result =
                await client.query(
                    `
                    SELECT *
                    FROM users
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [user.id]
                );

            if (
                !result.rows.length
            ) {
                throw new Error(
                    "Usuario nao encontrado ao estornar pontos."
                );
            }

            const dbUser =
                mapDbUserToInternal(
                    result.rows[0]
                );

            const newPoints =
                dbUser.points +
                reservedAmount;

            const newReserved =
                Math.max(
                    0,
                    (
                        dbUser.reservedPoints ||
                        0
                    ) -
                        reservedAmount
                );

            await client.query(
                `
                UPDATE users
                SET
                    points = $1,
                    reserved_points = $2
                WHERE id = $3
                `,
                [
                    newPoints,
                    newReserved,
                    user.id
                ]
            );

            await client.query(
                "COMMIT"
            );

            user.points =
                newPoints;

            user.reservedPoints =
                newReserved;

            return;
        } catch (error) {
            try {
                await client.query(
                    "ROLLBACK"
                );
            } catch (_) {}

            console.error(
                "[Points/Tx] Erro no estorno:",
                error.message
            );

            throw error;
        } finally {
            client.release();
        }
    }

    user.points +=
        reservedAmount;

    user.reservedPoints =
        Math.max(
            0,
            (
                user.reservedPoints ||
                0
            ) -
                reservedAmount
        );

    await persistUserData(
        user
    );
}

/* ============================================================
   EXPRESS / CORS
============================================================ */

app.disable(
    "x-powered-by"
);

app.set(
    "trust proxy",
    1
);

app.use(
    express.json({
        limit: "10mb"
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: "5mb"
    })
);

/*
 * CORRIGIDO:
 * Sem Markdown dentro da string JavaScript.
 */

const configuredOrigins = (
    process.env.ALLOWED_ORIGINS ||
    "https://cortesdomnr.vercel.app"
)
    .split(",")
    .map((s) =>
        s.trim().replace(
            /\/+$/,
            ""
        )
    )
    .filter(Boolean);

const defaultDevOrigins = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5500"
];

const allowedOrigins =
    IS_PROD
        ? configuredOrigins
        : [
              ...configuredOrigins,
              ...defaultDevOrigins
          ];

app.use(
    cors({
        origin: (
            origin,
            callback
        ) => {
            if (!origin) {
                return callback(
                    null,
                    true
                );
            }

            if (!IS_PROD) {
                return callback(
                    null,
                    true
                );
            }

            if (
                allowedOrigins.includes(
                    origin
                )
            ) {
                return callback(
                    null,
                    true
                );
            }

            return callback(
                new Error(
                    "Origem nao autorizada pelas politicas de CORS."
                )
            );
        },

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

app.options(
    /.*/,
    cors()
);

app.use(
    (req, res, next) => {
        metrics.requests++;

        res.setHeader(
            "X-ClipForge-Version",
            VERSION
        );

        next();
    }
);

/* ============================================================
   COOKIES YT-DLP
============================================================ */

async function setupYtdlpCookies() {
    try {
        if (
            YTDLP_COOKIES_BASE64
        ) {
            const cookiesPath =
                path.join(
                    TEMP_ROOT,
                    "ytdlp_cookies_base64.txt"
                );

            const decoded =
                Buffer.from(
                    YTDLP_COOKIES_BASE64,
                    "base64"
                ).toString(
                    "utf-8"
                );

            if (!decoded.trim()) {
                throw new Error(
                    "YTDLP_COOKIES_BASE64 resultou em arquivo vazio."
                );
            }

            await fsp.writeFile(
                cookiesPath,
                decoded,
                {
                    encoding:
                        "utf-8",
                    mode: 0o600
                }
            );

            try {
                await fsp.chmod(
                    cookiesPath,
                    0o600
                );
            } catch (_) {}

            YTDLP_COOKIES_FILE =
                cookiesPath;

            console.log(
                "[yt-dlp] Cookies carregados de YTDLP_COOKIES_BASE64."
            );

            return;
        }

        if (
            YTDLP_COOKIES_URL
        ) {
            const cookiesPath =
                path.join(
                    TEMP_ROOT,
                    "ytdlp_cookies_remote.txt"
                );

            const response =
                await fetch(
                    YTDLP_COOKIES_URL,
                    {
                        signal:
                            AbortSignal.timeout(
                                15000
                            )
                    }
                );

            if (!response.ok) {
                throw new Error(
                    `Falha ao baixar cookies: HTTP ${response.status}`
                );
            }

            const text =
                await response.text();

            if (!text.trim()) {
                throw new Error(
                    "Arquivo remoto de cookies esta vazio."
                );
            }

            await fsp.writeFile(
                cookiesPath,
                text,
                {
                    encoding:
                        "utf-8",
                    mode: 0o600
                }
            );

            try {
                await fsp.chmod(
                    cookiesPath,
                    0o600
                );
            } catch (_) {}

            YTDLP_COOKIES_FILE =
                cookiesPath;

            console.log(
                "[yt-dlp] Cookies carregados de YTDLP_COOKIES_URL."
            );

            return;
        }

        if (
            YTDLP_COOKIES_FILE &&
            fs.existsSync(
                YTDLP_COOKIES_FILE
            )
        ) {
            console.log(
                "[yt-dlp] Usando cookies do arquivo configurado."
            );
        }
    } catch (error) {
        console.warn(
            "[yt-dlp] Aviso na inicializacao de cookies:",
            error.message
        );
    }
}

/* ============================================================
   YOUTUBE ID
============================================================ */

function getYouTubeId(
    value
) {
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

        if (
            host === "youtu.be" ||
            host === "www.youtu.be"
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
            host === "youtube.com" ||
            host.endsWith(
                ".youtube.com"
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
                        ].includes(
                            part.toLowerCase()
                        )
                );

            if (
                index >= 0 &&
                parts[index + 1]
            ) {
                const id =
                    parts[
                        index + 1
                    ];

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

    if (!id) return null;

    /*
     * CORRIGIDO:
     * URL real, sem Markdown.
     */
    return (
        "https://www.youtube.com/watch?v=" +
        id
    );
}

/* ============================================================
   AUXILIARES DE STREAM YOUTUBE
============================================================ */

function normalizeQualityNumber(
    value
) {
    const text =
        safeString(value);

    const match =
        text.match(
            /(\d{3,4})/
        );

    if (!match) return 0;

    return Number(
        match[1]
    );
}

function isMp4Stream(
    stream
) {
    const mime =
        safeString(
            stream?.mimeType ||
                stream?.mime ||
                stream?.type
        ).toLowerCase();

    const url =
        safeString(
            stream?.url
        ).toLowerCase();

    return (
        mime.includes(
            "video/mp4"
        ) ||
        mime.includes(
            "video/mp4;"
        ) ||
        url.includes(
            ".mp4"
        ) ||
        url.includes(
            "mime=video%2fmp4"
        )
    );
}

async function downloadRemoteVideo(
    url,
    outputFile
) {
    const response =
        await fetch(
            url,
            {
                headers: {
                    "User-Agent":
                        "ClipForge-Pro/16.0.2",
                    Accept:
                        "video/mp4,video/*,*/*"
                },
                signal:
                    AbortSignal.timeout(
                        YOUTUBE_DOWNLOAD_TIMEOUT_MS
                    )
            }
        );

    if (!response.ok) {
        throw new Error(
            `Download remoto falhou: HTTP ${response.status}`
        );
    }

    if (!response.body) {
        throw new Error(
            "Servidor remoto nao retornou corpo de video."
        );
    }

    const fileHandle =
        await fsp.open(
            outputFile,
            "w"
        );

    try {
        const reader =
            response.body.getReader();

        const writable =
            fileHandle.createWriteStream();

        while (true) {
            const {
                done,
                value
            } =
                await reader.read();

            if (done) break;

            if (value) {
                if (
                    !writable.write(
                        Buffer.from(
                            value
                        )
                    )
                ) {
                    await new Promise(
                        (resolve) =>
                            writable.once(
                                "drain",
                                resolve
                            )
                    );
                }
            }
        }

        await new Promise(
            (resolve, reject) => {
                writable.end(
                    resolve
                );

                writable.on(
                    "error",
                    reject
                );
            }
        );
    } finally {
        await fileHandle.close();
    }
}

/* ============================================================
   YT-DLP
============================================================ */

async function downloadYouTubeWithYtDlp(
    url,
    outputDir
) {
    await fsp.mkdir(
        outputDir,
        {
            recursive: true
        }
    );

    const outputTemplate =
        path.join(
            outputDir,
            "source.%(ext)s"
        );

    const args = [
        "--no-playlist",
        "--no-warnings",
        "--no-mtime",
        "--restrict-filenames",
        "--force-ipv4",
        "--geo-bypass",
        "--extractor-args",
        "youtube:player_client=android,ios,web",
        "-f",
        "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]/best",
        "--merge-output-format",
        "mp4",
        "-o",
        outputTemplate
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

    if (
        YTDLP_USERNAME &&
        YTDLP_PASSWORD
    ) {
        args.push(
            "--username",
            YTDLP_USERNAME,
            "--password",
            YTDLP_PASSWORD
        );
    }

    args.push(url);

    const result =
        await spawnCapture(
            YTDLP_BIN,
            args,
            {
                timeoutMs:
                    YOUTUBE_DOWNLOAD_TIMEOUT_MS
            }
        );

    if (
        result.code !== 0
    ) {
        const errorOut =
            (
                result.stderr ||
                result.stdout ||
                "Erro desconhecido"
            ).slice(
                0,
                1500
            );

        throw new Error(
            errorOut
        );
    }

    const files =
        await fsp.readdir(
            outputDir
        );

    let candidate =
        files.find(
            (file) =>
                file.toLowerCase() ===
                "source.mp4"
        );

    if (!candidate) {
        candidate =
            files.find(
                (file) =>
                    /^source\.mp4$/i.test(
                        file
                    )
            );
    }

    if (!candidate) {
        candidate =
            files.find(
                (file) =>
                    /\.mp4$/i.test(
                        file
                    )
            );
    }

    if (!candidate) {
        throw new Error(
            "yt-dlp terminou sem gerar arquivo MP4 no diretorio exclusivo."
        );
    }

    const filePath =
        path.join(
            outputDir,
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
            const response =
                await fetch(
                    `${apiBase}/streams/${encodeURIComponent(
                        videoId
                    )}`,
                    {
                        headers: {
                            Accept:
                                "application/json",
                            "User-Agent":
                                "ClipForge-Pro/16.0.2"
                        },
                        signal:
                            AbortSignal.timeout(
                                YOUTUBE_SOURCE_TIMEOUT_MS
                            )
                    }
                );

            if (!response.ok) {
                continue;
            }

            const data =
                await response.json();

            const streams =
                Array.isArray(
                    data?.videoStreams
                )
                    ? data.videoStreams
                    : [];

            const candidates =
                streams
                    .filter(
                        (stream) =>
                            stream?.url &&
                            stream.videoOnly !==
                                true &&
                            isMp4Stream(
                                stream
                            )
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
                        (stream) =>
                            stream.qualityNumber >
                                0 &&
                            stream.qualityNumber <=
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
        } catch (error) {
            lastError = error;

            await safeRemove(
                outputFile
            );
        }
    }

    throw (
        lastError ||
        new Error(
            "Piped indisponivel."
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
            const response =
                await fetch(
                    `${apiBase}/api/v1/videos/${encodeURIComponent(
                        videoId
                    )}?region=BR`,
                    {
                        headers: {
                            Accept:
                                "application/json",
                            "User-Agent":
                                "ClipForge-Pro/16.0.2"
                        },
                        signal:
                            AbortSignal.timeout(
                                YOUTUBE_SOURCE_TIMEOUT_MS
                            )
                    }
                );

            if (!response.ok) {
                continue;
            }

            const data =
                await response.json();

            const streams =
                Array.isArray(
                    data?.formatStreams
                )
                    ? data.formatStreams
                    : [];

            const candidates =
                streams
                    .filter(
                        (stream) =>
                            stream?.url &&
                            isMp4Stream(
                                stream
                            )
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
                        (stream) =>
                            stream.qualityNumber >
                                0 &&
                            stream.qualityNumber <=
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
                source:
                    "invidious"
            };
        } catch (error) {
            lastError = error;

            await safeRemove(
                outputFile
            );
        }
    }

    throw (
        lastError ||
        new Error(
            "Invidious indisponivel."
        )
    );
}

/* ============================================================
   DOWNLOAD YOUTUBE
============================================================ */

async function downloadYouTubeVideo(
    url,
    targetDirectory
) {
    const videoId =
        getYouTubeId(url);

    if (!videoId) {
        throw new Error(
            "ID do YouTube invalido."
        );
    }

    console.log(
        `[YouTube] URL: ${url}`
    );

    console.log(
        `[YouTube] ID identificado: ${videoId}`
    );

    await fsp.mkdir(
        targetDirectory,
        {
            recursive: true
        }
    );

    const outputFile =
        path.join(
            targetDirectory,
            "source.mp4"
        );

    const errors = [];

    try {
        console.log(
            "[YouTube] [1/3] Tentando yt-dlp nativo..."
        );

        const result =
            await downloadYouTubeWithYtDlp(
                url,
                targetDirectory
            );

        console.log(
            `[YouTube] yt-dlp OK (${result.duration}s).`
        );

        return result;
    } catch (error) {
        console.warn(
            `[YouTube] yt-dlp falhou: ${error.message}`
        );

        errors.push(
            `yt-dlp: ${error.message}`
        );

        await safeRemove(
            outputFile
        );
    }

    try {
        console.log(
            "[YouTube] [2/3] Tentando fallback Piped..."
        );

        const result =
            await tryPipedDownload(
                videoId,
                outputFile
            );

        console.log(
            `[YouTube] Piped OK (${result.duration}s).`
        );

        return result;
    } catch (error) {
        console.warn(
            `[YouTube] Piped falhou: ${error.message}`
        );

        errors.push(
            `Piped: ${error.message}`
        );

        await safeRemove(
            outputFile
        );
    }

    try {
        console.log(
            "[YouTube] [3/3] Tentando fallback Invidious..."
        );

        const result =
            await tryInvidiousDownload(
                videoId,
                outputFile
            );

        console.log(
            `[YouTube] Invidious OK (${result.duration}s).`
        );

        return result;
    } catch (error) {
        console.warn(
            `[YouTube] Invidious falhou: ${error.message}`
        );

        errors.push(
            `Invidious: ${error.message}`
        );

        await safeRemove(
            outputFile
        );
    }

    const isBotChallenge =
        errors.some(
            (entry) => {
                const lower =
                    entry.toLowerCase();

                return (
                    lower.includes(
                        "confirm you’re not a bot"
                    ) ||
                    lower.includes(
                        "confirm you're not a bot"
                    ) ||
                    lower.includes(
                        "sign in to confirm"
                    ) ||
                    lower.includes(
                        "captcha"
                    ) ||
                    lower.includes(
                        "bot detection"
                    ) ||
                    lower.includes(
                        "http error 429"
                    ) ||
                    lower.includes(
                        "http error 403"
                    ) ||
                    lower.includes(
                        "login required"
                    ) ||
                    lower.includes(
                        "please sign in"
                    ) ||
                    lower.includes(
                        "this content isn't available"
                    ) ||
                    lower.includes(
                        "video unavailable"
                    )
                );
            }
        );

    const botAdvice =
        isBotChallenge
            ? "\n[Aviso Bot] O YouTube bloqueou a requisicao por verificacao de robo. Configure YTDLP_COOKIES_BASE64 no Render."
            : "";

    throw new Error(
        `Falha no download do YouTube:${botAdvice}\n${errors.join(
            "\n"
        )}`
    );
}

/* ============================================================
   PROMPT IA
============================================================ */

function buildClipPrompt(
    videoDuration
) {
    const duration =
        Number(
            videoDuration
        ) || 0;

    return `Voce e um editor profissional de videos virais para TikTok, YouTube Shorts e Instagram Reels.
Analise o video e encontre os melhores momentos para gerar cortes.
Duracao total do video: ${duration.toFixed(
        1
    )} segundos.

REGRAS OBRIGATORIAS:
1. Retorne ate ${MAX_CLIPS} cortes.
2. Cada corte deve ter entre 10 e 90 segundos quando o video tiver pelo menos 10 segundos.
3. Para videos menores que 10 segundos, use o maximo possivel da duracao real.
4. Nunca ultrapasse a duracao total do video.
5. Nao sobreponha cortes.
6. Priorize: ganchos fortes, momentos de retencao, emocao, surpresa e frases de impacto.
7. De uma nota de 0 a 100 para cada corte.
8. Retorne SOMENTE JSON valido.

FORMATO:
{
  "clips": [
    {
      "start": 10.5,
      "end": 55.5,
      "duration": 45,
      "title": "Gancho magnetico",
      "description": "Trecho com alto potencial de retencao",
      "score": 95
    }
  ]
}`;
}

/* ============================================================
   NORMALIZAÇÃO DE CORTES
============================================================ */

function normalizeClipsScoreFirst(
    rawArray,
    maxDuration
) {
    if (
        !Array.isArray(
            rawArray
        )
    ) {
        return [];
    }

    const total =
        Number(
            maxDuration
        ) || 0;

    if (total <= 0) {
        return [];
    }

    const cleaned =
        rawArray
            .map(
                (clip, index) => {
                    if (
                        !clip ||
                        typeof clip !==
                            "object"
                    ) {
                        return null;
                    }

                    let start =
                        parseNumber(
                            clip.start ??
                                clip.inicio ??
                                clip.startTime ??
                                clip.inicio_segundos,
                            0
                        );

                    let end =
                        parseNumber(
                            clip.end ??
                                clip.fim ??
                                clip.endTime ??
                                clip.fim_segundos,
                            0
                        );

                    let duration =
                        parseNumber(
                            clip.duration ??
                                clip.duracao ??
                                clip.length,
                            0
                        );

                    start =
                        Math.max(
                            0,
                            start
                        );

                    if (
                        start >= total
                    ) {
                        return null;
                    }

                    if (
                        end >
                            start &&
                        duration <= 0
                    ) {
                        duration =
                            end -
                            start;
                    }

                    if (
                        duration <= 0 &&
                        end > start
                    ) {
                        duration =
                            end -
                            start;
                    }

                    if (
                        duration <= 0
                    ) {
                        duration =
                            Math.min(
                                30,
                                Math.max(
                                    1,
                                    total -
                                        start
                                )
                            );
                    }

                    const maxViable =
                        total >= 10
                            ? Math.min(
                                  90,
                                  total
                              )
                            : total;

                    const minViable =
                        total >= 10
                            ? 10
                            : 1;

                    duration =
                        clamp(
                            duration,
                            minViable,
                            maxViable
                        );

                    if (
                        start +
                            duration >
                        total
                    ) {
                        start =
                            Math.max(
                                0,
                                total -
                                    duration
                            );

                        duration =
                            total -
                            start;
                    }

                    if (
                        duration <= 0
                    ) {
                        return null;
                    }

                    end =
                        start +
                        duration;

                    return {
                        start:
                            Number(
                                start.toFixed(
                                    2
                                )
                            ),

                        end:
                            Number(
                                end.toFixed(
                                    2
                                )
                            ),

                        duration:
                            Number(
                                duration.toFixed(
                                    2
                                )
                            ),

                        title:
                            safeString(
                                clip.title ??
                                    clip.titulo ??
                                    clip.name,
                                `Corte #${
                                    index +
                                    1
                                }`
                            ).trim(),

                        description:
                            safeString(
                                clip.description ??
                                    clip.descricao ??
                                    clip.reason,
                                "Momento de destaque do video"
                            ).trim(),

                        score:
                            clamp(
                                parseNumber(
                                    clip.score ??
                                        clip.pontuacao ??
                                        clip.rating ??
                                        clip.relevance,
                                    85
                                ),
                                0,
                                100
                            )
                    };
                }
            )
            .filter(Boolean);

    cleaned.sort(
        (a, b) =>
            b.score -
            a.score
    );

    const selected = [];

    for (
        const candidate
        of cleaned
    ) {
        const overlap =
            selected.some(
                (existing) => {
                    const isTooClose =
                        Math.abs(
                            candidate.start -
                                existing.start
                        ) < 2;

                    const isOverlapping =
                        candidate.start <
                            existing.end &&
                        candidate.end >
                            existing.start;

                    return (
                        isTooClose ||
                        isOverlapping
                    );
                }
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
            a.start -
            b.start
    );
}

/* ============================================================
   FALLBACK
============================================================ */

function generateFallbackClips(
    totalDuration,
    requestedCount = 5
) {
    const duration =
        Number(
            totalDuration
        ) || 0;

    if (duration <= 0) {
        return [];
    }

    if (duration < 10) {
        return [
            {
                start: 0,
                end: Number(
                    duration.toFixed(
                        2
                    )
                ),
                duration: Number(
                    duration.toFixed(
                        2
                    )
                ),
                title:
                    "Destaque do video",
                description:
                    "Trecho integral selecionado automaticamente",
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

    let clipLen =
        Math.min(
            60,
            Math.max(
                10,
                Math.min(
                    30,
                    Math.floor(
                        duration /
                            2
                    )
                )
            )
        );

    if (
        duration < 30
    ) {
        clipLen =
            Math.max(
                10,
                Math.floor(
                    duration *
                        0.75
                )
            );
    }

    let count =
        Math.floor(
            duration /
                clipLen
        );

    if (count < 1) {
        count = 1;
    }

    count =
        Math.min(
            maxClips,
            count
        );

    const clips = [];

    if (count === 1) {
        const end =
            Math.min(
                duration,
                clipLen
            );

        clips.push({
            start: 0,
            end: Number(
                end.toFixed(
                    2
                )
            ),
            duration: Number(
                end.toFixed(
                    2
                )
            ),
            title:
                "Melhor momento",
            description:
                "Trecho automatico selecionado pelo ClipForge",
            score: 85
        });

        return clips;
    }

    const step =
        (
            duration -
            clipLen
        ) /
        (count - 1);

    for (
        let i = 0;
        i < count;
        i++
    ) {
        const start =
            Number(
                (
                    i *
                    step
                ).toFixed(
                    2
                )
            );

        const end =
            Number(
                Math.min(
                    duration,
                    start +
                        clipLen
                ).toFixed(
                    2
                )
            );

        const d =
            Number(
                (
                    end -
                    start
                ).toFixed(
                    2
                )
            );

        if (d >= 5) {
            clips.push({
                start,
                end,
                duration: d,
                title:
                    `Destaque #${
                        i + 1
                    }`,
                description:
                    `Momento selecionado automaticamente pelo ClipForge (${start}s - ${end}s)`,
                score:
                    Math.max(
                        70,
                        90 -
                            i * 3
                    )
            });
        }
    }

    return clips;
}

function completeClipsWithFallback(
    clips,
    totalDuration
) {
    const duration =
        Number(
            totalDuration
        ) || 0;

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
                (existing) => {
                    const tooClose =
                        Math.abs(
                            candidate.start -
                                existing.start
                        ) < 2;

                    const overlapping =
                        candidate.start <
                            existing.end &&
                        candidate.end >
                            existing.start;

                    return (
                        tooClose ||
                        overlapping
                    );
                }
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

        const response =
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
                                role:
                                    "user",
                                content
                            }
                        ],

                        response_format: {
                            type:
                                "json_object"
                        }
                    }),

                    signal:
                        controller.signal
                }
            );

        const text =
            await response.text();

        if (!response.ok) {
            const error =
                new Error(
                    `OpenRouter HTTP ${response.status}: ${text.slice(
                        0,
                        500
                    )}`
                );

            error.status =
                response.status;

            throw error;
        }

        try {
            return JSON.parse(
                text
            );
        } catch (_) {
            throw new Error(
                "OpenRouter retornou JSON invalido."
            );
        }
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
            "OPENROUTER_API_KEY nao configurada."
        );
    }

    let lastError =
        null;

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
                `[IA] Consultando modelo: ${model}`
            );

            const data =
                await requestOpenRouter(
                    model,
                    promptText,
                    videoUrl
                );

            const message =
                data
                    ?.choices?.[0]
                    ?.message
                    ?.content;

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
                "IA nao retornou cortes validos."
            );
        } catch (error) {
            lastError =
                error;

            if (
                error.status ===
                    401 ||
                error.status ===
                    402 ||
                error.status ===
                    403
            ) {
                console.warn(
                    `[IA] Falha terminal de credito/autenticacao (${error.status}).`
                );

                throw error;
            }

            if (
                i <
                OPENROUTER_MODELS.length -
                    1
            ) {
                metrics.openRouterRetries++;

                metrics.openRouterFallbacks++;

                console.warn(
                    `[IA] Fallback apos falha em ${model}: ${error.message}`
                );
            } else {
                console.warn(
                    `[IA] Todos os modelos OpenRouter falharam: ${error.message}`
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
   FFMPEG
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
            "FFmpeg nao disponivel."
        );
    }

    let vf = "";

    if (
        format === "9:16"
    ) {
        vf =
            "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black";
    } else if (
        format === "1:1"
    ) {
        vf =
            "scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=black";
    } else if (
        format === "16:9"
    ) {
        vf =
            "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black";
    } else {
        throw new Error(
            `Formato '${format}' invalido. Escolha entre 9:16, 1:1 ou 16:9.`
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

    const result =
        await spawnCapture(
            FFMPEG_BIN,
            args,
            {
                timeoutMs:
                    180000
            }
        );

    if (
        result.code !== 0
    ) {
        throw new Error(
            `FFmpeg falhou: ${
                result.stderr ||
                result.stdout
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
            "Renderizacao nao produziu MP4 valido."
        );
    }

    return stat;
}

/* ============================================================
   FILA
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
            .then(
                (result) => {
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
                }
            )
            .catch(
                (error) => {
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
                }
            )
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
        (resolve, reject) => {
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
   WORKER
============================================================ */

async function runAnalysisWorker(
    jobId,
    payload
) {
    const job =
        jobs.get(jobId);

    if (!job) {
        throw new Error(
            "Job nao encontrado."
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
            "Obtendo video original...",
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
                    workDir
                );

            sourceFile =
                dl.filePath;

            duration =
                dl.duration;

            title =
                dl.title ||
                "Video do YouTube";
        } else {
            sourceFile =
                payload.filePath;

            duration =
                payload.duration;

            title =
                payload.originalName ||
                "Video MP4";

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
                "Nao foi possivel determinar a duracao do video."
            );
        }

        setStage(
            "analyzing",
            "IA analisando momentos de retencao...",
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
                    15 *
                        60 *
                        1000
            }
        );

        const proxy =
            PUBLIC_BASE_URL
                ? `${PUBLIC_BASE_URL}/api/ai-video/${aiToken}`
                : "";

        let aiModel =
            "fallback";

        let aiUsed =
            false;

        let fallbackReason =
            null;

        let clips = [];

        try {
            if (!proxy) {
                throw new Error(
                    "PUBLIC_BASE_URL nao configurada no ambiente."
                );
            }

            const aiResult =
                await analyzeWithOpenRouterFallback(
                    buildClipPrompt(
                        duration
                    ) +
                        `\nTitulo: ${title}`,
                    proxy,
                    duration
                );

            aiModel =
                aiResult.model;

            clips =
                aiResult.clips ||
                [];

            aiUsed =
                true;

            console.log(
                `[IA] ${aiModel} retornou ${clips.length} corte(s).`
            );
        } catch (aiError) {
            fallbackReason =
                aiError.message;

            console.warn(
                `[IA] Falha semantica: ${aiError.message}`
            );

            console.log(
                "[IA] Ativando fallback algoritmico local..."
            );

            clips = [];

            aiModel =
                "automatic-fallback";

            aiUsed =
                false;
        }

        clips =
            completeClipsWithFallback(
                clips,
                duration
            );

        if (!clips.length) {
            throw new Error(
                "Nao foi possivel gerar cortes para este video."
            );
        }

        if (
            job.reservedPoints >
            0
        ) {
            await commitPoints(
                user,
                job.reservedPoints
            );

            job.reservedPoints =
                0;
        }

        job.status =
            "completed";

        job.stageMessage =
            "Analise concluida com sucesso.";

        job.progress =
            100;

        job.updatedAt =
            now();

        job.result = {
            model:
                aiModel,

            aiUsed,

            fallbackReason,

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
                (
                    user.analyses ||
                    0
                ) + 1;

            await persistUserData(
                user
            );
        }

        metrics.successfulAnalyses++;

        console.log(
            `[Worker] Job ${jobId} concluido com ${clips.length} corte(s).`
        );

        return job.result;
    } catch (error) {
        console.error(
            `[Worker] Falha ${jobId}: ${error.message}`
        );

        job.status =
            "failed";

        job.stageMessage =
            `Falha no processamento: ${error.message}`;

        job.error =
            error.message;

        job.progress =
            0;

        job.updatedAt =
            now();

        if (
            job.reservedPoints >
            0
        ) {
            try {
                await refundPoints(
                    user,
                    job.reservedPoints
                );

                job.reservedPoints =
                    0;
            } catch (
                refundError
            ) {
                console.error(
                    "[Worker] Falha critica ao estornar pontos:",
                    refundError.message
                );
            }
        }

        metrics.failedAnalyses++;

        throw error;
    } finally {
        if (aiToken) {
            setTimeout(
                () => {
                    aiVideoTokens.delete(
                        aiToken
                    );
                },
                60000
            ).unref();
        }

        if (workDir) {
            setTimeout(
                async () => {
                    await safeRemove(
                        workDir
                    );
                },
                60000
            ).unref();
        }
    }
}

/* ============================================================
   USUÁRIOS
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
        users.get(
            userId
        );

    if (!user) {
        user = {
            id: userId,

            points:
                FREE_POINTS,

            reservedPoints:
                0,

            vip:
                false,

            vipUntil:
                null,

            createdAt:
                now(),

            lastDailyClaim:
                now(),

            downloads:
                0,

            analyses:
                0
        };

        users.set(
            userId,
            user
        );

        persistUserData(
            user
        ).catch(() => {});
    }

    isUserVip(user);

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

        persistUserData(
            user
        ).catch(() => {});
    }

    return user;
}

function publicUser(
    user
) {
    const vipActive =
        isUserVip(user);

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

        vip:
            vipActive,

        isVip:
            vipActive,

        vipUntil:
            user.vipUntil ||
            null
    };
}

function getBearerToken(
    req
) {
    const header =
        safeString(
            req.headers
                .authorization
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

    if (
        !user &&
        !IS_PROD
    ) {
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
            "Sessao invalida ou nao autenticada."
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
            "Sessao administrativa expirada ou invalida."
        );
    }

    next();
}

/* ============================================================
   LOGIN
============================================================ */

app.post(
    "/api/auth/login",
    (req, res) => {
        const requestedId =
            safeString(
                req.body?.userId
            ).trim();

        const existingToken =
            getBearerToken(
                req
            );

        let user = null;

        if (existingToken) {
            const session =
                sessions.get(
                    existingToken
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

        if (
            requestedId &&
            users.has(
                requestedId
            )
        ) {
            if (
                !user ||
                user.id !==
                    requestedId
            ) {
                return jsonError(
                    res,
                    403,
                    "Nao e permitido assumir um identificador existente sem sessao valida."
                );
            }
        }

        if (!user) {
            user =
                ensureUser(
                    requestedId ||
                        randomId(
                            "user_"
                        )
                );
        }

        const token =
            randomToken(
                48
            );

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
                    "Nenhum video enviado."
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
                    req.file
                        .originalname,

                mimeType:
                    req.file
                        .mimetype,

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
        } catch (error) {
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

/* ============================================================
   ANALISAR
============================================================ */

app.post(
    "/api/analisar",
    requireUser,
    rateLimitMiddleware(
        5,
        60000
    ),
    async (
        req,
        res
    ) => {
        metrics.analyses++;

        const {
            url,
            uploadId
        } =
            req.body || {};

        const reserved =
            await reservePoints(
                req.user,
                ANALYSIS_COST
            );

        if (
            reserved === -1
        ) {
            return jsonError(
                res,
                402,
                `Pontos insuficientes (Necessario: ${ANALYSIS_COST}, Disponivel: ${req.user.points}).`
            );
        }

        let payload;

        try {
            if (uploadId) {
                const upload =
                    uploads.get(
                        uploadId
                    );

                if (
                    !upload ||
                    upload.userId !==
                        req.user.id
                ) {
                    throw new Error(
                        "Upload nao encontrado."
                    );
                }

                payload = {
                    type:
                        "upload",

                    uploadId,

                    filePath:
                        upload.filePath,

                    duration:
                        upload
                            .metadata
                            .duration,

                    originalName:
                        upload
                            .originalName
                };
            } else if (url) {
                const normalized =
                    normalizeYouTubeUrl(
                        url
                    );

                if (!normalized) {
                    throw new Error(
                        "URL do YouTube invalida."
                    );
                }

                payload = {
                    type:
                        "youtube",

                    url:
                        normalized
                };
            } else {
                throw new Error(
                    "Informe url ou uploadId."
                );
            }
        } catch (error) {
            try {
                await refundPoints(
                    req.user,
                    reserved
                );
            } catch (_) {}

            return jsonError(
                res,
                400,
                error.message
            );
        }

        if (
            jobQueue.length >=
            MAX_QUEUE_LENGTH
        ) {
            try {
                await refundPoints(
                    req.user,
                    reserved
                );
            } catch (_) {}

            return jsonError(
                res,
                429,
                "Fila cheia. Tente novamente em alguns instantes."
            );
        }

        const jobId =
            randomId(
                "job_"
            );

        jobs.set(
            jobId,
            {
                id:
                    jobId,

                userId:
                    req.user.id,

                status:
                    "queued",

                stageMessage:
                    "Aguardando processamento...",

                progress:
                    5,

                reservedPoints:
                    reserved,

                createdAt:
                    now(),

                updatedAt:
                    now(),

                payload: {
                    ...payload
                }
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

                aiUsed:
                    result.aiUsed !==
                    undefined
                        ? result.aiUsed
                        : true,

                fallbackReason:
                    result.fallbackReason ||
                    null,

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
        } catch (error) {
            const job =
                jobs.get(
                    jobId
                );

            if (
                job &&
                job.reservedPoints >
                    0
            ) {
                try {
                    await refundPoints(
                        req.user,
                        job.reservedPoints
                    );

                    job.reservedPoints =
                        0;
                } catch (_) {}
            }

            metrics.errors++;

            return jsonError(
                res,
                500,
                error.message ||
                    "Erro durante a analise."
            );
        }
    }
);

/* ============================================================
   DOWNLOAD
============================================================ */

app.post(
    "/api/download",
    requireUser,
    rateLimitMiddleware(
        5,
        60000
    ),
    async (
        req,
        res
    ) => {
        let temporarySource =
            null;

        let outputFile =
            null;

        const {
            start,
            duration,
            format =
                "9:16",
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
                "Intervalo ou duracao invalidos."
            );
        }

        const reserved =
            await reservePoints(
                req.user,
                DOWNLOAD_COST
            );

        if (
            reserved === -1
        ) {
            return jsonError(
                res,
                402,
                `Pontos insuficientes para download (Necessario: ${DOWNLOAD_COST}).`
            );
        }

        try {
            let sourceFile =
                null;

            let sourceDuration =
                0;

            if (uploadId) {
                const upload =
                    uploads.get(
                        uploadId
                    );

                if (
                    !upload ||
                    upload.userId !==
                        req.user.id
                ) {
                    throw new Error(
                        "Upload nao encontrado."
                    );
                }

                sourceFile =
                    upload.filePath;

                sourceDuration =
                    upload
                        .metadata
                        .duration;
            } else if (url) {
                const normalized =
                    normalizeYouTubeUrl(
                        url
                    );

                if (!normalized) {
                    throw new Error(
                        "URL do YouTube invalida."
                    );
                }

                const workDir =
                    await fsp.mkdtemp(
                        path.join(
                            TEMP_ROOT,
                            "render_yt_"
                        )
                    );

                const download =
                    await downloadYouTubeVideo(
                        normalized,
                        workDir
                    );

                sourceFile =
                    download.filePath;

                sourceDuration =
                    download.duration;

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
                const metadata =
                    await getVideoMetadata(
                        sourceFile
                    );

                sourceDuration =
                    metadata.duration;
            }

            if (
                nStart >=
                sourceDuration
            ) {
                throw new Error(
                    "O ponto de inicio ultrapassa a duracao total do video."
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

            if (
                nDuration <=
                0
            ) {
                throw new Error(
                    "Duracao final do corte invalida."
                );
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

            let finalized =
                false;

            let cleanupDone =
                false;

            const cleanup =
                async () => {
                    if (
                        cleanupDone
                    ) {
                        return;
                    }

                    cleanupDone =
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

            res.on(
                "finish",
                async () => {
                    if (
                        finalized
                    ) {
                        return;
                    }

                    try {
                        await commitPoints(
                            req.user,
                            reserved
                        );

                        req.user.downloads =
                            (
                                req.user
                                    .downloads ||
                                0
                            ) + 1;

                        metrics.downloads++;

                        await persistUserData(
                            req.user
                        );

                        finalized =
                            true;

                        console.log(
                            "[Download] Stream concluido e pontos consolidados."
                        );
                    } catch (
                        commitError
                    ) {
                        console.error(
                            "[Download] Erro ao consolidar pontos:",
                            commitError.message
                        );

                        /*
                         * Se o commit falhar, tenta
                         * devolver os pontos para o usuário.
                         */
                        try {
                            await refundPoints(
                                req.user,
                                reserved
                            );

                            console.warn(
                                "[Download] Pontos estornados apos falha no commit."
                            );
                        } catch (
                            refundError
                        ) {
                            console.error(
                                "[Download] Falha critica no estorno:",
                                refundError.message
                            );
                        }

                        finalized =
                            true;
                    }

                    await cleanup();
                }
            );

            res.on(
                "close",
                async () => {
                    if (
                        !res.writableEnded &&
                        !finalized
                    ) {
                        finalized =
                            true;

                        try {
                            await refundPoints(
                                req.user,
                                reserved
                            );

                            console.warn(
                                "[Download] Cliente abortou o download. Pontos estornados."
                            );
                        } catch (
                            refundError
                        ) {
                            console.error(
                                "[Download] Falha ao estornar download abortado:",
                                refundError.message
                            );
                        }
                    }

                    await cleanup();
                }
            );

            stream.on(
                "error",
                async () => {
                    if (
                        !finalized
                    ) {
                        finalized =
                            true;

                        try {
                            await refundPoints(
                                req.user,
                                reserved
                            );
                        } catch (
                            refundError
                        ) {
                            console.error(
                                "[Download] Falha ao estornar apos erro de stream:",
                                refundError.message
                            );
                        }
                    }

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
        } catch (error) {
            try {
                await refundPoints(
                    req.user,
                    reserved
                );
            } catch (
                refundError
            ) {
                console.error(
                    "[Download] Falha ao estornar pontos:",
                    refundError.message
                );
            }

            if (
                outputFile
            ) {
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

            if (
                !res.headersSent
            ) {
                return jsonError(
                    res,
                    500,
                    error.message ||
                        "Erro durante o processamento do corte."
                );
            }
        }
    }
);

/* ============================================================
   PIX — AUXILIARES
============================================================ */

function isValidUserId(
    value
) {
    return /^[A-Za-z0-9_-]{1,64}$/.test(
        safeString(value)
    );
}

function parseClipForgeExternalReference(
    externalReference
) {
    const extRef =
        safeString(
            externalReference
        ).trim();

    if (!extRef) {
        return null;
    }

    const parts =
        extRef.split("::");

    if (
        parts.length !== 4 ||
        parts[0] !==
            "clipforge" ||
        ![
            "vip",
            "points"
        ].includes(
            parts[2]
        ) ||
        !isValidUserId(
            parts[1]
        ) ||
        !/^[a-f0-9-]{36}$/i.test(
            parts[3]
        )
    ) {
        return null;
    }

    return {
        userId:
            parts[1],

        itemType:
            parts[2],

        transactionId:
            parts[3]
    };
}

/* ============================================================
   PIX — APROVAÇÃO IDEMPOTENTE
============================================================ */

async function aprovarPagamentoIdempotente(
    paymentId,
    externalPaymentData
) {
    const pId =
        String(
            paymentId
        );

    if (!pId) {
        throw new Error(
            "ID do pagamento invalido."
        );
    }

    let localPayment =
        payments.get(
            pId
        );

    const extRef =
        safeString(
            externalPaymentData
                ?.external_reference ||
                localPayment
                    ?.externalReference ||
                ""
        ).trim();

    let userId =
        localPayment?.userId ||
        "";

    let itemType =
        localPayment?.itemType ||
        "";

    /*
     * Se o pagamento local não possui
     * vínculo, tenta recuperar pelo
     * external_reference.
     */
    if (
        !userId ||
        !itemType
    ) {
        const parsed =
            parseClipForgeExternalReference(
                extRef
            );

        if (parsed) {
            userId =
                parsed.userId;

            itemType =
                parsed.itemType;
        }
    }

    if (
        !userId ||
        !isValidUserId(
            userId
        )
    ) {
        throw new Error(
            "Pagamento sem usuário associado."
        );
    }

    if (
        ![
            "vip",
            "points"
        ].includes(
            itemType
        )
    ) {
        throw new Error(
            "Tipo de pagamento invalido."
        );
    }

    if (!localPayment) {
        localPayment = {
            id:
                pId,

            userId,

            itemType,

            pointsAmount:
                itemType ===
                "points"
                    ? POINTS_PACKAGE_AMOUNT
                    : 0,

            amount:
                Number(
                    externalPaymentData
                        ?.transaction_amount
                ) ||
                (
                    itemType ===
                    "points"
                        ? POINTS_PACKAGE_PRICE
                        : VIP_PRICE
                ),

            status:
                "pending",

            createdAt:
                now(),

            externalReference:
                extRef
        };

        payments.set(
            pId,
            localPayment
        );
    } else {
        /*
         * Não deixa o webhook trocar
         * silenciosamente o dono/tipo
         * de um pagamento local.
         */
        if (
            localPayment.userId &&
            localPayment.userId !==
                userId
        ) {
            throw new Error(
                "Usuario do pagamento nao confere com o registro local."
            );
        }

        if (
            localPayment.itemType &&
            localPayment.itemType !==
                itemType
        ) {
            throw new Error(
                "Tipo do pagamento nao confere com o registro local."
            );
        }
    }

    if (pgPool) {
        const client =
            await pgPool.connect();

        try {
            await client.query(
                "BEGIN"
            );

            const payRes =
                await client.query(
                    `
                    SELECT *
                    FROM payments
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [pId]
                );

            if (
                payRes.rows.length &&
                payRes.rows[0]
                    .status ===
                    "approved"
            ) {
                await client.query(
                    "COMMIT"
                );

                localPayment.status =
                    "approved";

                localPayment.approvedAt =
                    payRes.rows[0]
                        .approved_at
                        ? Number(
                              payRes
                                  .rows[0]
                                  .approved_at
                          )
                        : localPayment
                              .approvedAt;

                return false;
            }

            const userRes =
                await client.query(
                    `
                    SELECT *
                    FROM users
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [userId]
                );

            if (
                !userRes.rows.length
            ) {
                throw new Error(
                    "Usuário do pagamento não encontrado."
                );
            }

            const dbUser =
                mapDbUserToInternal(
                    userRes.rows[0]
                );

            if (
                itemType ===
                "points"
            ) {
                const amount =
                    localPayment
                        .pointsAmount ||
                    POINTS_PACKAGE_AMOUNT;

                dbUser.points +=
                    amount;
            } else {
                dbUser.vip =
                    true;

                const baseTime =
                    dbUser.vipUntil &&
                    dbUser.vipUntil >
                        now()
                        ? dbUser.vipUntil
                        : now();

                dbUser.vipUntil =
                    baseTime +
                    VIP_DURATION_MS;
            }

            await client.query(
                `
                UPDATE users
                SET
                    points = $1,
                    vip = $2,
                    vip_until = $3
                WHERE id = $4
                `,
                [
                    dbUser.points,
                    Boolean(
                        dbUser.vip
                    ),
                    dbUser.vipUntil,
                    dbUser.id
                ]
            );

            const approvedAt =
                now();

            const paymentAmount =
                Number(
                    localPayment.amount
                ) ||
                Number(
                    externalPaymentData
                        ?.transaction_amount
                ) ||
                (
                    itemType ===
                    "points"
                        ? POINTS_PACKAGE_PRICE
                        : VIP_PRICE
                );

            await client.query(
                `
                INSERT INTO payments
                (
                    id,
                    user_id,
                    item_type,
                    points_amount,
                    amount,
                    status,
                    created_at,
                    approved_at,
                    external_reference
                )
                VALUES
                (
                    $1,$2,$3,$4,$5,
                    'approved',
                    $6,$7,$8
                )
                ON CONFLICT (id)
                DO UPDATE SET
                    status = 'approved',
                    approved_at = $7
                `,
                [
                    pId,
                    userId,
                    itemType,
                    localPayment
                        .pointsAmount ||
                        0,
                    paymentAmount,
                    localPayment
                        .createdAt ||
                        approvedAt,
                    approvedAt,
                    extRef
                ]
            );

            await client.query(
                "COMMIT"
            );

            users.set(
                dbUser.id,
                dbUser
            );

            localPayment.userId =
                userId;

            localPayment.itemType =
                itemType;

            localPayment.amount =
                paymentAmount;

            localPayment.externalReference =
                extRef;

            localPayment.status =
                "approved";

            localPayment.approvedAt =
                approvedAt;

            metrics.pixApproved++;

            metrics.revenueTotal +=
                paymentAmount;

            return true;
        } catch (error) {
            try {
                await client.query(
                    "ROLLBACK"
                );
            } catch (_) {}

            console.error(
                "[Pix/Tx] Erro ao consolidar pagamento no PostgreSQL:",
                error.message
            );

            throw error;
        } finally {
            client.release();
        }
    }

    if (
        !localPayment
    ) {
        return false;
    }

    if (
        localPayment.status ===
        "approved"
    ) {
        return false;
    }

    const user =
        users.get(
            userId
        );

    if (!user) {
        throw new Error(
            "Usuário do pagamento não encontrado."
        );
    }

    if (
        itemType ===
        "points"
    ) {
        const amount =
            localPayment
                .pointsAmount ||
            POINTS_PACKAGE_AMOUNT;

        user.points +=
            amount;
    } else {
        user.vip =
            true;

        const baseTime =
            user.vipUntil &&
            user.vipUntil >
                now()
                ? user.vipUntil
                : now();

        user.vipUntil =
            baseTime +
            VIP_DURATION_MS;
    }

    localPayment.status =
        "approved";

    localPayment.approvedAt =
        now();

    await persistUserData(
        user
    );

    await persistPaymentData(
        localPayment
    );

    metrics.pixApproved++;

    metrics.revenueTotal +=
        Number(
            localPayment.amount ||
                0
        );

    return true;
}

/* ============================================================
   PIX CRIAR
============================================================ */

app.post(
    "/api/pix/criar",
    requireUser,
    rateLimitMiddleware(
        5,
        60000
    ),
    async (
        req,
        res
    ) => {
        if (
            !MP_CONFIGURED
        ) {
            return jsonError(
                res,
                503,
                "Mercado Pago nao configurado."
            );
        }

        try {
            const itemType =
                req.body?.itemType ===
                "points"
                    ? "points"
                    : "vip";

            const amount =
                itemType ===
                "points"
                    ? Number(
                          POINTS_PACKAGE_PRICE.toFixed(
                              2
                          )
                      )
                    : Number(
                          VIP_PRICE.toFixed(
                              2
                          )
                      );

            const description =
                itemType ===
                "points"
                    ? `ClipForge Pro - Pacote ${POINTS_PACKAGE_AMOUNT} Pontos`
                    : "ClipForge Pro - VIP Mensal (30 Dias)";

            const reference =
                [
                    "clipforge",
                    req.user.id,
                    itemType,
                    crypto.randomUUID()
                ].join(
                    "::"
                );

            const payerEmail =
                process.env
                    .MP_PAYER_EMAIL ||
                `cliente-${req.user.id}@clipforge.local`;

            const payment =
                await criarPagamentoPix(
                    {
                        amount,

                        description,

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

            const paymentRecord =
                {
                    id:
                        paymentId,

                    userId:
                        req.user.id,

                    itemType,

                    pointsAmount:
                        itemType ===
                        "points"
                            ? POINTS_PACKAGE_AMOUNT
                            : 0,

                    amount,

                    status:
                        payment.status,

                    createdAt:
                        now(),

                    externalReference:
                        reference
                };

            payments.set(
                paymentId,
                paymentRecord
            );

            await persistPaymentData(
                paymentRecord
            );

            metrics.pixCreated++;

            return res.json({
                ok: true,

                id:
                    paymentId,

                itemType,

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

            return jsonError(
                res,
                502,
                error.message
            );
        }
    }
);

/* ============================================================
   PIX STATUS
============================================================ */

app.get(
    "/api/pix/status/:id",
    requireUser,
    async (
        req,
        res
    ) => {
        if (
            !MP_CONFIGURED
        ) {
            return jsonError(
                res,
                503,
                "Mercado Pago nao configurado no servidor."
            );
        }

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
                    "Pagamento nao pertence a este usuario."
                );
            }

            const payment =
                await consultarPagamentoPix(
                    paymentId
                );

            const isApproved =
                payment.status ===
                "approved";

            if (isApproved) {
                await aprovarPagamentoIdempotente(
                    paymentId,
                    payment
                );
            } else if (
                localPayment
            ) {
                localPayment.status =
                    payment.status;

                await persistPaymentData(
                    localPayment
                );
            }

            const finalStatus =
                payments.get(
                    paymentId
                )?.status ||
                payment.status;

            return res.json({
                ok: true,

                id:
                    paymentId,

                status:
                    finalStatus,

                approved:
                    finalStatus ===
                    "approved",

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
   WEBHOOK PIX
============================================================ */

app.post(
    "/api/pix/webhook",
    async (
        req,
        res
    ) => {
        try {
            const query =
                req.query ||
                {};

            const body =
                req.body ||
                {};

            const topic =
                query.topic ||
                query.type ||
                body.type ||
                body.action;

            const resourceId =
                query["data.id"] ||
                query.id ||
                body?.data?.id ||
                body?.id;

            if (
                !resourceId
            ) {
                return res
                    .status(200)
                    .send(
                        "No resource ID"
                    );
            }

            const eventKey =
                `${topic || "payment"}::${resourceId}`;

            if (pgPool) {
                const checkRes =
                    await pgPool.query(
                        `
                        SELECT event_key
                        FROM webhooks
                        WHERE event_key = $1
                        `,
                        [
                            eventKey
                        ]
                    );

                if (
                    checkRes.rows
                        .length >
                    0
                ) {
                    return res
                        .status(
                            200
                        )
                        .send(
                            "Already processed"
                        );
                }
            } else {
                if (
                    processedWebhookEvents.has(
                        eventKey
                    )
                ) {
                    return res
                        .status(
                            200
                        )
                        .send(
                            "Already processed"
                        );
                }
            }

            if (
                topic ===
                    "payment" ||
                topic ===
                    "payment.updated" ||
                !topic
            ) {
                if (
                    typeof consultarPagamentoPix ===
                    "function"
                ) {
                    const payment =
                        await consultarPagamentoPix(
                            String(
                                resourceId
                            )
                        );

                    if (
                        payment &&
                        payment.status ===
                            "approved"
                    ) {
                        /*
                         * Só marcamos webhook como processado
                         * depois da aprovação realmente consolidada.
                         */
                        await aprovarPagamentoIdempotente(
                            String(
                                resourceId
                            ),
                            payment
                        );

                        if (pgPool) {
                            await pgPool.query(
                                `
                                INSERT INTO webhooks
                                (
                                    event_key,
                                    created_at
                                )
                                VALUES
                                ($1,$2)
                                ON CONFLICT DO NOTHING
                                `,
                                [
                                    eventKey,
                                    Date.now()
                                ]
                            );
                        } else {
                            processedWebhookEvents.add(
                                eventKey
                            );

                            scheduleDatabaseSave();
                        }
                    }
                }
            }

            return res
                .status(200)
                .send("OK");
        } catch (error) {
            console.error(
                "[MercadoPago/Webhook] Falha ao processar webhook:",
                error.message
            );

            /*
             * Retornar 500 permite que o provedor
             * tente novamente quando a consolidação
             * realmente falhou.
             */
            return res
                .status(500)
                .send(
                    "Internal Server Error"
                );
        }
    }
);

/* ============================================================
   ADMIN
============================================================ */

app.post(
    "/api/admin/login",
    rateLimitMiddleware(
        5,
        60000
    ),
    (
        req,
        res
    ) => {
        if (
            !ADMIN_PASSWORD
        ) {
            return jsonError(
                res,
                503,
                "ADMIN_PASSWORD nao configurada."
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
            email &&
            email ===
                ADMIN_EMAIL;

        if (
            !validEmail ||
            password !==
                ADMIN_PASSWORD
        ) {
            return jsonError(
                res,
                401,
                "Credenciais administrativas invalidas."
            );
        }

        const token =
            randomToken(
                48
            );

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

app.get(
    "/api/admin/dashboard",
    requireAdmin,
    (
        req,
        res
    ) => {
        let vipUsers = 0;

        let totalPoints =
            0;

        for (
            const user
            of users.values()
        ) {
            if (
                isUserVip(
                    user
                )
            ) {
                vipUsers++;
            }

            totalPoints +=
                Math.max(
                    0,
                    user.points
                );
        }

        return res.json({
            ok: true,

            version:
                VERSION,

            metrics: {
                ...metrics,

                users:
                    users.size,

                vipUsers,

                totalPoints,

                revenueTotal:
                    Number(
                        metrics.revenueTotal.toFixed(
                            2
                        )
                    )
            },

            uptime:
                process.uptime()
        });
    }
);

/* ============================================================
   HTTP RANGE
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

    if (
        !rangeValue ||
        rangeValue.includes(
            ","
        )
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

        start =
            Math.max(
                0,
                fileSize -
                    suffixLength
            );

        end =
            fileSize - 1;
    } else if (
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
    } else {
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
   STREAM DA IA
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
                    "Video temporario expirado ou indisponivel."
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

            const range =
                parseSingleRange(
                    rangeHeader,
                    fileSize
                );

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
        } catch (error) {
            console.error(
                "[AI Video] Erro no streaming:",
                error.message
            );

            if (
                !res.headersSent
            ) {
                return res
                    .status(500)
                    .send(
                        "Erro ao ler arquivo de video."
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
   HEALTH
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

            database: {
                driver:
                    pgPool
                        ? "postgresql"
                        : "local-file",

                connected:
                    Boolean(
                        pgPool ||
                        fs.existsSync(
                            DB_FILE
                        )
                    )
            },

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

            cookies: {
                configured:
                    Boolean(
                        YTDLP_COOKIES_FILE ||
                        YTDLP_COOKIES_BASE64 ||
                        YTDLP_COOKIES_URL
                    )
            },

            persistence: {
                usersLoaded:
                    users.size,

                paymentsLoaded:
                    payments.size,

                revenueTotal:
                    Number(
                        metrics.revenueTotal.toFixed(
                            2
                        )
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
                        (job) =>
                            job.status ===
                            "queued"
                    ).length,

                running:
                    Array.from(
                        jobs.values()
                    ).filter(
                        (job) =>
                            [
                                "downloading",
                                "analyzing",
                                "rendering"
                            ].includes(
                                job.status
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
         * Protege uploads que estejam
         * sendo utilizados por jobs.
         */
        const activeUploadIds =
            new Set();

        for (
            const job
            of jobs.values()
        ) {
            if (
                [
                    "queued",
                    "downloading",
                    "analyzing",
                    "rendering"
                ].includes(
                    job.status
                )
            ) {
                const uploadId =
                    job.payload
                        ?.uploadId;

                if (
                    uploadId
                ) {
                    activeUploadIds.add(
                        uploadId
                    );
                }

                if (
                    job.result
                        ?.uploadId
                ) {
                    activeUploadIds.add(
                        job.result
                            .uploadId
                    );
                }
            }
        }

        for (
            const [
                id,
                upload
            ] of uploads.entries()
        ) {
            if (
                upload.createdAt <
                    expiration &&
                !activeUploadIds.has(
                    id
                )
            ) {
                await safeRemove(
                    upload.filePath
                );

                uploads.delete(
                    id
                );
            }
        }

        const current =
            now();

        for (
            const [
                token,
                session
            ] of sessions.entries()
        ) {
            if (
                session.expiresAt <
                current
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
            ] of adminSessions.entries()
        ) {
            if (
                session.expiresAt <
                current
            ) {
                adminSessions.delete(
                    token
                );
            }
        }

        for (
            const [
                token,
                video
            ] of aiVideoTokens.entries()
        ) {
            if (
                video.expiresAt <
                current
            ) {
                aiVideoTokens.delete(
                    token
                );
            }
        }

        for (
            const [
                id,
                job
            ] of jobs.entries()
        ) {
            if (
                now() -
                    job.createdAt >
                3 *
                    60 *
                    60 *
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
   LIMPEZA RATE LIMIT
============================================================ */

setInterval(
    () => {
        const current =
            now();

        for (
            const [
                key,
                record
            ] of rateLimitMap.entries()
        ) {
            if (
                current -
                    record.startTime >
                15 * 60 * 1000
            ) {
                rateLimitMap.delete(
                    key
                );
            }
        }
    },
    15 * 60 * 1000
).unref();

/* ============================================================
   TRATAMENTO DE ERRO MULTER
============================================================ */

app.use(
    (
        error,
        req,
        res,
        next
    ) => {
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
                    `Video excede o limite de ${MAX_UPLOAD_MB} MB.`
                );
            }

            return jsonError(
                res,
                400,
                error.message
            );
        }

        if (
            error &&
            error.message ===
                "Apenas arquivos MP4 sao suportados."
        ) {
            return jsonError(
                res,
                400,
                error.message
            );
        }

        if (
            error &&
            error.message ===
                "Origem nao autorizada pelas politicas de CORS."
        ) {
            return jsonError(
                res,
                403,
                error.message
            );
        }

        console.error(
            "[Express] Erro nao tratado:",
            error?.message ||
                error
        );

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
            "Erro interno do servidor."
        );
    }
);

/* ============================================================
   INICIALIZAÇÃO
============================================================ */

async function startServer() {
    try {
        if (IS_PROD) {
            if (
                !PUBLIC_BASE_URL ||
                !PUBLIC_BASE_URL.startsWith(
                    "https://"
                )
            ) {
                throw new Error(
                    "PUBLIC_BASE_URL obrigatoria com HTTPS em producao para que a IA consiga inspecionar os videos."
                );
            }
        }

        await ensureDirectories();

        await initDatabase();

        await resolveBinaries();

        await setupYtdlpCookies();

        if (
            IS_PROD &&
            !pgPool
        ) {
            throw new Error(
                "PostgreSQL nao esta conectado em producao."
            );
        }

        app.listen(
            PORT,
            HOST,
            () => {
                console.log(
                    "===================================================="
                );

                console.log(
                    `  CLIPFORGE PRO — BACKEND ${VERSION} ONLINE`
                );

                console.log(
                    `  http://${HOST}:${PORT}`
                );

                console.log(
                    `  Modelo Primario: ${OPENROUTER_MODEL}`
                );

                console.log(
                    `  Armazenamento: ${
                        pgPool
                            ? "PostgreSQL (Producao)"
                            : "Arquivo Local (Dev)"
                    }`
                );

                console.log(
                    `  Public URL: ${
                        PUBLIC_BASE_URL ||
                        "nao configurada"
                    }`
                );

                console.log(
                    "===================================================="
                );
            }
        );
    } catch (error) {
        console.error(
            "[Startup] FATAL ERROR:",
            error.message
        );

        process.exit(1);
    }
}

startServer();