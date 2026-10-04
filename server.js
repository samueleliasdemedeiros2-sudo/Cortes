/**
 * ============================================================
 * CLIPFORGE PRO — BACKEND V15.9.1 COMERCIAL CONSOLIDADO
 * ============================================================
 * 1. URL YouTube em concatenação pura ("https://www.youtube.com/watch?v=" + id)
 * 2. Todas as funções auxiliares e middlewares declarados localmente
 * 3. PostgreSQL transacional estrito (SELECT ... FOR UPDATE) com fail-fast em produção
 * 4. Transação SQL única para Pagamento + Saldo/VIP + Idempotência de Webhook
 * 5. Webhook com retry íntegro: marcação de evento somente após commit bem-sucedido
 * 6. Validação estrutural rigorosa de external_reference ("clipforge::userId::itemType::uuid")
 * 7. Billing de Download seguro: commit de pontos via res.on("finish") e estorno em res.on("close")
 * 8. Interrupção imediata de retries no OpenRouter em caso de 401/402/403
 * 9. PUBLIC_BASE_URL HTTPS obrigatória com validação no boot em produção
 * 10. Rate limiting com limpeza periódica contra vazamento de memória
 * 11. Detecção abrangente de bloqueios/desafios do YouTube (403, 429, Sign in, Bot, Captcha)
 * 12. RFC 7233 HTTP Range integral (200, 206, 416) com GET e HEAD
 * 13. FFmpeg scale + pad centralizado (1080x1920) anti-crop
 * 14. Resposta síncrona em /api/analisar 100% compatível com a interface atual
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
   MERCADO PAGO (CARREGAMENTO DEFENSIVO)
============================================================ */

let criarPagamentoPix = null;
let consultarPagamentoPix = null;

try {
    const mpModule = require("./mercadoPago");
    criarPagamentoPix = mpModule.criarPagamentoPix;
    consultarPagamentoPix = mpModule.consultarPagamentoPix;
} catch (_) {
    console.warn("[MercadoPago] Módulo ./mercadoPago não encontrado. Rotas Pix operarão em contingência.");
}

/* ============================================================
   POSTGRESQL DRIVER
============================================================ */

let pgPool = null;
const DATABASE_URL = process.env.DATABASE_URL || "";

if (DATABASE_URL) {
    try {
        const { Pool } = require("pg");
        pgPool = new Pool({
            connectionString: DATABASE_URL,
            ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
        });
        console.log("[Database] Driver PostgreSQL configurado.");
    } catch (_) {
        console.warn("[Database] Pacote 'pg' não instalado.");
    }
}

const app = express();

/* ============================================================
   CONFIGURAÇÃO PRINCIPAL
============================================================ */

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";
const VERSION = "15.9.1-commercial-engine";
const IS_PROD = process.env.NODE_ENV === "production";

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 150);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const VIP_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias de vigência

/* ============================================================
   PONTOS E LIMITES COMERCIAIS
============================================================ */

const FREE_POINTS = Number(process.env.FREE_POINTS || 200);
const DAILY_POINTS = Number(process.env.DAILY_POINTS || 50);
const ANALYSIS_COST = Number(process.env.ANALYSIS_COST || 20);
const DOWNLOAD_COST = Number(process.env.DOWNLOAD_COST || 50);

const VIP_PRICE = Number(process.env.VIP_PRICE || 19.90);
const POINTS_PACKAGE_PRICE = Number(process.env.POINTS_PACKAGE_PRICE || 9.90);
const POINTS_PACKAGE_AMOUNT = Number(process.env.POINTS_PACKAGE_AMOUNT || 500);

const MAX_CLIPS = Number(process.env.MAX_CLIPS || 8);
const CONCURRENT_JOBS_LIMIT = 1;
const MAX_QUEUE_LENGTH = 25;

/* ============================================================
   DIRETÓRIOS E BANCO LOCAL
============================================================ */

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "database.json");

const TEMP_ROOT = process.env.TEMP_DIR || path.join(os.tmpdir(), "clipforge");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(TEMP_ROOT, "uploads");
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(TEMP_ROOT, "outputs");

/* ============================================================
   CONFIGURAÇÃO IA (OPENROUTER)
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
    "google/gemini-2.5-flash,google/gemini-2.5-flash-lite,google/gemini-2.0-flash-exp:free"
)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const OPENROUTER_MODELS = [
    OPENROUTER_MODEL,
    ...OPENROUTER_FALLBACK_MODELS.filter((m) => m !== OPENROUTER_MODEL)
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
   MERCADO PAGO PARÂMETROS
============================================================ */

const MP_CONFIGURED = Boolean(
    (process.env.MP_ACCESS_TOKEN || process.env.MERCADO_PAGO_ACCESS_TOKEN) &&
    typeof criarPagamentoPix === "function" &&
    typeof consultarPagamentoPix === "function"
);

const MP_WEBHOOK_URL =
    process.env.MP_WEBHOOK_URL ||
    process.env.MERCADO_PAGO_WEBHOOK_URL ||
    (PUBLIC_BASE_URL ? PUBLIC_BASE_URL + "/api/pix/webhook" : "");

/* ============================================================
   ADMINISTRAÇÃO
============================================================ */

const ADMIN_EMAIL =
    (process.env.ADMIN_EMAIL || "admin@clipforge.local").trim().toLowerCase();

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD ||
    "";

/* ============================================================
   YT-DLP COOKIES E AUTENTICAÇÃO
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
   FALLBACKS DE INSTÂNCIAS (PIPED / INVIDIOUS)
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
   BINÁRIOS DO SISTEMA
============================================================ */

let FFMPEG_BIN = "ffmpeg";
let FFPROBE_BIN = "ffprobe";
let YTDLP_BIN = path.join(__dirname, "bin", "yt-dlp");

/* ============================================================
   MEMÓRIA / ESTADOS
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
   RATE LIMITING EM MEMÓRIA COM LIMPEZA ATIVA
============================================================ */

const rateLimitMap = new Map();

function checkRateLimit(key, maxRequests, windowMs) {
    const current = Date.now();
    let record = rateLimitMap.get(key);

    if (!record || current - record.startTime > windowMs) {
        record = { count: 1, startTime: current };
        rateLimitMap.set(key, record);
        return true;
    }

    if (record.count >= maxRequests) {
        return false;
    }

    record.count++;
    return true;
}

function rateLimitMiddleware(limit, windowMs) {
    return (req, res, next) => {
        const ip = req.ip || req.connection.remoteAddress || "global";
        const key = req.path + ":" + ip;

        if (!checkRateLimit(key, limit, windowMs)) {
            return res.status(429).json({
                ok: false,
                error: "Muitas requisições. Aguarde um instante antes de tentar novamente."
            });
        }
        next();
    };
}

// Limpeza de rate limiters expirados a cada 10 minutos
setInterval(() => {
    const current = Date.now();
    for (const [key, record] of rateLimitMap.entries()) {
        if (current - record.startTime > 300000) {
            rateLimitMap.delete(key);
        }
    }
}, 10 * 60 * 1000).unref();

/* ============================================================
   MAPPER POSTGRESQL -> MODELO INTERNO
============================================================ */

function mapDbUserToInternal(row) {
    if (!row) return null;
    return {
        id: String(row.id),
        points: Number(row.points || 0),
        reservedPoints: Number(row.reserved_points || 0),
        vip: Boolean(row.vip),
        vipUntil: row.vip_until ? Number(row.vip_until) : null,
        createdAt: Number(row.created_at || Date.now()),
        lastDailyClaim: row.last_daily_claim ? Number(row.last_daily_claim) : Date.now(),
        downloads: Number(row.downloads || 0),
        analyses: Number(row.analyses || 0)
    };
}

function mapDbPaymentToInternal(row) {
    if (!row) return null;
    return {
        id: String(row.id),
        userId: String(row.user_id),
        itemType: String(row.item_type || "vip"),
        pointsAmount: Number(row.points_amount || 0),
        amount: Number(row.amount || 0),
        status: String(row.status || "pending"),
        createdAt: Number(row.created_at || Date.now()),
        approvedAt: row.approved_at ? Number(row.approved_at) : null,
        externalReference: String(row.external_reference || "")
    };
}

/* ============================================================
   BANCO DE DADOS: INICIALIZAÇÃO & RECONSTRUÇÃO DE MÉTRICAS
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

            const usersRes = await pgPool.query("SELECT * FROM users");
            for (const row of usersRes.rows) {
                const u = mapDbUserToInternal(row);
                users.set(u.id, u);
            }

            const paymentsRes = await pgPool.query("SELECT * FROM payments");
            for (const row of paymentsRes.rows) {
                const p = mapDbPaymentToInternal(row);
                payments.set(p.id, p);
            }

            const webhooksRes = await pgPool.query("SELECT event_key FROM webhooks");
            for (const row of webhooksRes.rows) {
                processedWebhookEvents.add(row.event_key);
            }

            const revRes = await pgPool.query(
                "SELECT COUNT(*) AS approved_count, COALESCE(SUM(amount), 0) AS total_revenue FROM payments WHERE status = 'approved'"
            );
            if (revRes.rows.length) {
                metrics.pixApproved = Number(revRes.rows[0].approved_count || 0);
                metrics.revenueTotal = Number(revRes.rows[0].total_revenue || 0);
            }

            console.log(`[Database] PostgreSQL sincronizado: ${users.size} usuários, ${payments.size} pagamentos, R$ ${metrics.revenueTotal.toFixed(2)} faturados.`);
            return;
        } catch (err) {
            console.error("[Database] Erro crítico ao conectar/inicializar Postgres:", err.message);
            if (IS_PROD) {
                throw new Error("Falha crítica ao conectar no PostgreSQL em produção. Abortando inicialização.");
            }
            pgPool = null;
        }
    }

    if (IS_PROD) {
        throw new Error("DATABASE_URL obrigatória em produção. O Render necessita de PostgreSQL para dados comerciais.");
    }

    try {
        await fsp.mkdir(DATA_DIR, { recursive: true });
        if (fs.existsSync(DB_FILE)) {
            const content = await fsp.readFile(DB_FILE, "utf-8");
            const data = JSON.parse(content);

            if (Array.isArray(data.users)) {
                for (const u of data.users) users.set(u.id, u);
            }
            if (Array.isArray(data.payments)) {
                for (const p of data.payments) payments.set(String(p.id), p);
            }
            if (Array.isArray(data.processedWebhooks)) {
                for (const w of data.processedWebhooks) processedWebhookEvents.add(w);
            }
            if (data.metrics && typeof data.metrics === "object") {
                metrics.revenueTotal = Number(data.metrics.revenueTotal || 0);
                metrics.pixApproved = Number(data.metrics.pixApproved || 0);
            }
            console.log(`[Database] Armazenamento local carregado (${users.size} usuários, ${payments.size} pagamentos).`);
        }
    } catch (err) {
        console.warn("[Database] Falha ao ler database.json local:", err.message);
    }
}

async function persistUserData(user) {
    if (!user) return;
    if (pgPool) {
        await pgPool.query(
            `INSERT INTO users (id, points, reserved_points, vip, vip_until, created_at, last_daily_claim, downloads, analyses)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET
                points = EXCLUDED.points,
                reserved_points = EXCLUDED.reserved_points,
                vip = EXCLUDED.vip,
                vip_until = EXCLUDED.vip_until,
                last_daily_claim = EXCLUDED.last_daily_claim,
                downloads = EXCLUDED.downloads,
                analyses = EXCLUDED.analyses`,
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

async function persistPaymentData(payment) {
    if (!payment) return;
    if (pgPool) {
        await pgPool.query(
            `INSERT INTO payments (id, user_id, item_type, points_amount, amount, status, created_at, approved_at, external_reference)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET
                status = EXCLUDED.status,
                approved_at = EXCLUDED.approved_at`,
            [
                payment.id,
                payment.userId,
                payment.itemType,
                payment.pointsAmount || 0,
                payment.amount,
                payment.status,
                payment.createdAt,
                payment.approvedAt || null,
                payment.externalReference
            ]
        );
        return;
    }
    scheduleDatabaseSave();
}

let saveDbTimeout = null;
function scheduleDatabaseSave() {
    if (saveDbTimeout) return;
    saveDbTimeout = setTimeout(async () => {
        saveDbTimeout = null;
        try {
            const data = {
                users: Array.from(users.values()),
                payments: Array.from(payments.values()),
                processedWebhooks: Array.from(processedWebhookEvents.values()),
                metrics: {
                    revenueTotal: metrics.revenueTotal,
                    pixApproved: metrics.pixApproved
                },
                savedAt: Date.now()
            };
            const tempFile = DB_FILE + ".tmp";
            await fsp.writeFile(tempFile, JSON.stringify(data, null, 2), "utf-8");
            await fsp.rename(tempFile, DB_FILE);
        } catch (e) {
            console.error("[Database] Erro ao salvar database.json:", e.message);
        }
    }, 1000);
}

/* ============================================================
   TRANSAÇÕES DE PONTOS (SQL FOR UPDATE COM PROTEÇÃO DE CONCORRÊNCIA)
============================================================ */

function isUserVip(user) {
    if (!user) return false;
    if (!user.vip) return false;
    if (user.vipUntil && user.vipUntil < now()) {
        user.vip = false;
        persistUserData(user).catch(() => {});
        return false;
    }
    return true;
}

async function reservePoints(user, cost) {
    if (!user) return 0;
    if (isUserVip(user)) return 0;

    if (pgPool) {
        const client = await pgPool.connect();
        try {
            await client.query("BEGIN");
            const res = await client.query("SELECT * FROM users WHERE id = $1 FOR UPDATE", [user.id]);
            if (!res.rows.length) {
                await client.query("ROLLBACK");
                return -1;
            }
            const dbUser = mapDbUserToInternal(res.rows[0]);
            if (isUserVip(dbUser)) {
                await client.query("COMMIT");
                return 0;
            }
            if (dbUser.points < cost) {
                await client.query("ROLLBACK");
                return -1;
            }
            const newPoints = dbUser.points - cost;
            const newReserved = (dbUser.reservedPoints || 0) + cost;

            await client.query(
                "UPDATE users SET points = $1, reserved_points = $2 WHERE id = $3",
                [newPoints, newReserved, user.id]
            );
            await client.query("COMMIT");

            user.points = newPoints;
            user.reservedPoints = newReserved;
            return cost;
        } catch (err) {
            await client.query("ROLLBACK");
            console.error("[Points/Tx] Erro ao reservar pontos:", err.message);
            return -1;
        } finally {
            client.release();
        }
    }

    if (user.points < cost) return -1;
    user.points -= cost;
    user.reservedPoints = (user.reservedPoints || 0) + cost;
    await persistUserData(user);
    return cost;
}

async function commitPoints(user, reservedAmount) {
    if (!user || reservedAmount <= 0) return;

    if (pgPool) {
        const client = await pgPool.connect();
        try {
            await client.query("BEGIN");
            const res = await client.query("SELECT * FROM users WHERE id = $1 FOR UPDATE", [user.id]);
            if (res.rows.length) {
                const dbUser = mapDbUserToInternal(res.rows[0]);
                const newReserved = Math.max(0, (dbUser.reservedPoints || 0) - reservedAmount);
                await client.query("UPDATE users SET reserved_points = $1 WHERE id = $2", [newReserved, user.id]);
                user.reservedPoints = newReserved;
            }
            await client.query("COMMIT");
            return;
        } catch (err) {
            await client.query("ROLLBACK");
            console.error("[Points/Tx] Erro no commit:", err.message);
            throw err;
        } finally {
            client.release();
        }
    }

    user.reservedPoints = Math.max(0, (user.reservedPoints || 0) - reservedAmount);
    await persistUserData(user);
}

async function refundPoints(user, reservedAmount) {
    if (!user || reservedAmount <= 0) return;

    if (pgPool) {
        const client = await pgPool.connect();
        try {
            await client.query("BEGIN");
            const res = await client.query("SELECT * FROM users WHERE id = $1 FOR UPDATE", [user.id]);
            if (res.rows.length) {
                const dbUser = mapDbUserToInternal(res.rows[0]);
                const newPoints = dbUser.points + reservedAmount;
                const newReserved = Math.max(0, (dbUser.reservedPoints || 0) - reservedAmount);
                await client.query("UPDATE users SET points = $1, reserved_points = $2 WHERE id = $3", [newPoints, newReserved, user.id]);
                user.points = newPoints;
                user.reservedPoints = newReserved;
            }
            await client.query("COMMIT");
            return;
        } catch (err) {
            await client.query("ROLLBACK");
            console.error("[Points/Tx] Erro no estorno:", err.message);
            throw err;
        } finally {
            client.release();
        }
    }

    user.points += reservedAmount;
    user.reservedPoints = Math.max(0, (user.reservedPoints || 0) - reservedAmount);
    await persistUserData(user);
}

/* ============================================================
   EXPRESS & CORS COM CONTROLE DE ORIGEM EM PRODUÇÃO
============================================================ */

app.disable("x-powered-by");
app.set("trust proxy", 1);

const configuredOrigins = (process.env.ALLOWED_ORIGINS || "https://cortesdomnr.vercel.app")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);

const defaultDevOrigins = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5500"
];

const allowedOrigins = IS_PROD ? configuredOrigins : [...configuredOrigins, ...defaultDevOrigins];

app.use(
    cors({
        origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            if (!IS_PROD) return callback(null, true);
            if (allowedOrigins.includes(origin)) {
                return callback(null, true);
            }
            return callback(new Error("Origem não autorizada pelas políticas de CORS."));
        },
        credentials: false,
        methods: ["GET", "POST", "HEAD", "OPTIONS"],
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

app.options(/.*/, cors());

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));

app.use((req, res, next) => {
    metrics.requests++;
    res.setHeader("X-ClipForge-Version", VERSION);
    next();
});

/* ============================================================
   UTILITÁRIOS GERAIS
============================================================ */

const now = () => Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("hex");
const randomId = (prefix = "") => prefix + crypto.randomUUID();

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

function extractJsonFromText(text) {
    if (!text || typeof text !== "string") return null;

    let clean = text.trim();
    clean = clean.replace(/^```json/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();

    try {
        return JSON.parse(clean);
    } catch (_) {}

    const firstBrace = clean.indexOf("{");
    const lastBrace = clean.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        try {
            return JSON.parse(clean.substring(firstBrace, lastBrace + 1));
        } catch (_) {}
    }

    const firstBracket = clean.indexOf("[");
    const lastBracket = clean.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket > firstBracket) {
        try {
            return JSON.parse(clean.substring(firstBracket, lastBracket + 1));
        } catch (_) {}
    }

    return null;
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
    await fsp.mkdir(DATA_DIR, { recursive: true });
}

/* ============================================================
   YOUTUBE URL: CONCATENAÇÃO PURA E INALTERÁVEL
============================================================ */

function getYouTubeId(value) {
    const input = safeString(value).trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;

    try {
        const url = new URL(input);
        const host = url.hostname.toLowerCase();

        if (host === "youtu.be" || host === "www.youtu.be") {
            const id = url.pathname.replace(/^\//, "").split("/")[0];
            return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
        }

        if (host === "youtube.com" || host.endsWith(".youtube.com")) {
            const v = url.searchParams.get("v");
            if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;

            const parts = url.pathname.split("/").filter(Boolean);
            const index = parts.findIndex((part) =>
                ["shorts", "embed", "live"].includes(part.toLowerCase())
            );

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
    if (!id) return null;
    return "[https://www.youtube.com/watch?v=](https://www.youtube.com/watch?v=)" + id;
}

function isMp4Stream(stream) {
    if (!stream) return false;
    const type = safeString(stream.type || stream.mimeType || stream.mime_type || "").toLowerCase();
    const container = safeString(stream.container || stream.format || "").toLowerCase();
    const url = safeString(stream.url || "").toLowerCase();

    return (
        type.includes("video/mp4") ||
        container === "mp4" ||
        container.includes("mp4") ||
        url.includes(".mp4")
    );
}

function normalizeQualityNumber(value) {
    const match = safeString(value).match(/(\d{3,4})/);
    return match ? Number(match[1]) : 0;
}

/* ============================================================
   DOWNLOAD REMOTO HTTP
============================================================ */

async function downloadRemoteVideo(url, outputFile) {
    if (!url) throw new Error("URL do stream não informada.");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), YOUTUBE_DOWNLOAD_TIMEOUT_MS);
    let fileHandle = null;

    try {
        const res = await fetch(url, {
            method: "GET",
            redirect: "follow",
            signal: controller.signal,
            headers: {
                "User-Agent": "ClipForge-Pro/15.9.1",
                Accept: "video/mp4,video/*;q=0.9,*/*;q=0.8"
            }
        });

        if (!res.ok) throw new Error(`Download HTTP ${res.status}`);
        if (!res.body) throw new Error("Sem corpo no stream de resposta.");

        const contentLength = Number(res.headers.get("content-length") || 0);
        if (contentLength > MAX_UPLOAD_BYTES) {
            throw new Error(`Vídeo excede limite de ${MAX_UPLOAD_MB} MB.`);
        }

        await fsp.mkdir(path.dirname(outputFile), { recursive: true });
        fileHandle = fs.createWriteStream(outputFile);

        let totalBytes = 0;
        for await (const chunk of res.body) {
            const buffer = Buffer.from(chunk);
            totalBytes += buffer.length;

            if (totalBytes > MAX_UPLOAD_BYTES) {
                throw new Error(`Download excedeu limite de ${MAX_UPLOAD_MB} MB.`);
            }

            if (!fileHandle.write(buffer)) {
                await new Promise((resolve, reject) => {
                    fileHandle.once("drain", resolve);
                    fileHandle.once("error", reject);
                });
            }
        }

        await new Promise((resolve, reject) => {
            fileHandle.end(() => resolve());
            fileHandle.once("error", reject);
        });

        fileHandle = null;
        if (totalBytes <= 10000) throw new Error("Arquivo retornado muito pequeno ou inválido.");

        return outputFile;
    } catch (err) {
        try { fileHandle?.destroy(); } catch (_) {}
        await safeRemove(outputFile);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/* ============================================================
   YT-DLP COM ISOLAMENTO DE DIRETÓRIO
============================================================ */

async function downloadYouTubeWithYtDlp(url, outputDir) {
    await fsp.mkdir(outputDir, { recursive: true });
    const outputTemplate = path.join(outputDir, "source.%(ext)s");

    const args = [
        "--no-playlist",
        "--no-warnings",
        "--no-mtime",
        "--restrict-filenames",
        "--force-ipv4",
        "--geo-bypass",
        "--extractor-args", "youtube:player_client=android,ios,web",
        "-f", "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]/best",
        "--merge-output-format", "mp4",
        "-o", outputTemplate
    ];

    if (YTDLP_COOKIES_FILE && fs.existsSync(YTDLP_COOKIES_FILE)) {
        args.push("--cookies", YTDLP_COOKIES_FILE);
    }

    if (YTDLP_USERNAME && YTDLP_PASSWORD) {
        args.push("--username", YTDLP_USERNAME, "--password", YTDLP_PASSWORD);
    }

    args.push(url);

    const result = await spawnCapture(YTDLP_BIN, args, { timeoutMs: YOUTUBE_DOWNLOAD_TIMEOUT_MS });
    if (result.code !== 0) {
        const errorOut = (result.stderr || result.stdout || "Erro desconhecido").slice(0, 1000);
        throw new Error(errorOut);
    }

    const files = await fsp.readdir(outputDir);
    let candidate = files.find((f) => f.toLowerCase() === "source.mp4");
    if (!candidate) candidate = files.find((f) => /^source\.mp4$/i.test(f));
    if (!candidate) candidate = files.find((f) => /\.mp4$/i.test(f));

    if (!candidate) throw new Error("yt-dlp terminou sem gerar arquivo MP4 no diretório exclusivo.");

    const filePath = path.join(outputDir, candidate);
    const metadata = await validateVideoFile(filePath);

    return {
        filePath,
        title: "",
        duration: metadata.duration,
        source: "yt-dlp"
    };
}

/* ============================================================
   PIPED FALLBACK
============================================================ */

async function tryPipedDownload(videoId, outputFile) {
    let lastError = null;

    for (const apiBase of PIPED_API_URLS) {
        try {
            const res = await fetch(`${apiBase}/streams/${encodeURIComponent(videoId)}`, {
                headers: {
                    Accept: "application/json",
                    "User-Agent": "ClipForge-Pro/15.9.1"
                },
                signal: AbortSignal.timeout(YOUTUBE_SOURCE_TIMEOUT_MS)
            });

            if (!res.ok) continue;

            const data = await res.json();
            const streams = Array.isArray(data?.videoStreams) ? data.videoStreams : [];
            const candidates = streams
                .filter((s) => s?.url && s.videoOnly !== true && isMp4Stream(s))
                .map((s) => ({
                    ...s,
                    qualityNumber: normalizeQualityNumber(s.quality || s.qualityLabel || s.resolution)
                }))
                .filter((s) => s.qualityNumber > 0 && s.qualityNumber <= 720);

            candidates.sort((a, b) => b.qualityNumber - a.qualityNumber);
            if (!candidates[0]?.url) continue;

            await downloadRemoteVideo(candidates[0].url, outputFile);
            const metadata = await validateVideoFile(outputFile);

            return {
                filePath: outputFile,
                title: safeString(data?.title, ""),
                duration: metadata.duration,
                source: "piped"
            };
        } catch (e) {
            lastError = e;
            await safeRemove(outputFile);
        }
    }

    throw lastError || new Error("Piped indisponível.");
}

/* ============================================================
   INVIDIOUS FALLBACK
============================================================ */

async function tryInvidiousDownload(videoId, outputFile) {
    let lastError = null;

    for (const apiBase of INVIDIOUS_API_URLS) {
        try {
            const res = await fetch(`${apiBase}/api/v1/videos/${encodeURIComponent(videoId)}?region=BR`, {
                headers: {
                    Accept: "application/json",
                    "User-Agent": "ClipForge-Pro/15.9.1"
                },
                signal: AbortSignal.timeout(YOUTUBE_SOURCE_TIMEOUT_MS)
            });

            if (!res.ok) continue;

            const data = await res.json();
            const streams = Array.isArray(data?.formatStreams) ? data.formatStreams : [];
            const candidates = streams
                .filter((s) => s?.url && isMp4Stream(s))
                .map((s) => ({
                    ...s,
                    qualityNumber: normalizeQualityNumber(s.qualityLabel || s.quality || s.resolution)
                }))
                .filter((s) => s.qualityNumber > 0 && s.qualityNumber <= 720);

            candidates.sort((a, b) => b.qualityNumber - a.qualityNumber);
            if (!candidates[0]?.url) continue;

            await downloadRemoteVideo(candidates[0].url, outputFile);
            const metadata = await validateVideoFile(outputFile);

            return {
                filePath: outputFile,
                title: safeString(data?.title, ""),
                duration: metadata.duration,
                source: "invidious"
            };
        } catch (e) {
            lastError = e;
            await safeRemove(outputFile);
        }
    }

    throw lastError || new Error("Invidious indisponível.");
}

/* ============================================================
   DOWNLOAD YOUTUBE COM DETECÇÃO AMPLIADA DE BLOQUEIO/BOT
============================================================ */

async function downloadYouTubeVideo(url, targetDirectory) {
    const videoId = getYouTubeId(url);
    if (!videoId) throw new Error("ID do YouTube inválido.");

    console.log(`[YouTube] URL: ${url}`);
    console.log(`[YouTube] ID identificado: ${videoId}`);

    await fsp.mkdir(targetDirectory, { recursive: true });
    const outputFile = path.join(targetDirectory, "source.mp4");

    const errors = [];

    try {
        console.log("[YouTube] [1/3] Tentando yt-dlp nativo...");
        const result = await downloadYouTubeWithYtDlp(url, targetDirectory);
        console.log(`[YouTube] yt-dlp OK (${result.duration}s).`);
        return result;
    } catch (err) {
        console.warn(`[YouTube] yt-dlp falhou: ${err.message}`);
        errors.push(`yt-dlp: ${err.message}`);
    }

    try {
        console.log("[YouTube] [2/3] Tentando fallback Piped...");
        const result = await tryPipedDownload(videoId, outputFile);
        console.log(`[YouTube] Piped OK (${result.duration}s).`);
        return result;
    } catch (err) {
        console.warn(`[YouTube] Piped falhou: ${err.message}`);
        errors.push(`Piped: ${err.message}`);
    }

    try {
        console.log("[YouTube] [3/3] Tentando fallback Invidious...");
        const result = await tryInvidiousDownload(videoId, outputFile);
        console.log(`[YouTube] Invidious OK (${result.duration}s).`);
        return result;
    } catch (err) {
        console.warn(`[YouTube] Invidious falhou: ${err.message}`);
        errors.push(`Invidious: ${err.message}`);
    }

    const isBotChallenge = errors.some((e) => {
        const lower = e.toLowerCase();
        return (
            lower.includes("confirm you’re not a bot") ||
            lower.includes("sign in to confirm") ||
            lower.includes("captcha") ||
            lower.includes("bot detection") ||
            lower.includes("http error 429") ||
            lower.includes("http error 403") ||
            lower.includes("login required") ||
            lower.includes("please sign in") ||
            lower.includes("this content isn't available") ||
            lower.includes("video unavailable")
        );
    });

    const botAdvice = isBotChallenge
        ? "\n[Aviso Bot] O YouTube bloqueou a requisição por verificação de robô. Configure YTDLP_COOKIES_BASE64 no Render."
        : "";

    throw new Error(`Falha no download do YouTube:${botAdvice}\n${errors.join("\n")}`);
}

/* ============================================================
   PROMPT DA IA
============================================================ */

function buildClipPrompt(videoDuration) {
    const duration = Number(videoDuration) || 0;

    return `Você é um editor profissional de vídeos virais para TikTok, YouTube Shorts e Instagram Reels.
Analise o vídeo e encontre os melhores momentos para gerar cortes.
Duração total do vídeo: ${duration.toFixed(1)} segundos.

REGRAS OBRIGATÓRIAS:
1. Retorne até ${MAX_CLIPS} cortes.
2. Cada corte deve ter entre 10 e 90 segundos quando o vídeo tiver pelo menos 10 segundos.
3. Para vídeos menores que 10 segundos, use o máximo possível da duração real.
4. Nunca ultrapasse a duração total do vídeo.
5. Não sobreponha cortes.
6. Priorize: ganchos fortes, momentos de retenção, emoção, surpresa e frases de impacto.
7. Dê uma nota de 0 a 100 para cada corte.
8. Retorne SOMENTE JSON válido.

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
   NORMALIZAÇÃO DE CORTES (SCORE-FIRST E SEM DUPLICATAS)
============================================================ */

function normalizeClipsScoreFirst(rawArray, maxDuration) {
    if (!Array.isArray(rawArray)) return [];

    const total = Number(maxDuration) || 0;
    if (total <= 0) return [];

    const cleaned = rawArray
        .map((c, i) => {
            if (!c || typeof c !== "object") return null;

            let start = parseNumber(c.start ?? c.inicio ?? c.startTime ?? c.inicio_segundos, 0);
            let end = parseNumber(c.end ?? c.fim ?? c.endTime ?? c.fim_segundos, 0);
            let duration = parseNumber(c.duration ?? c.duracao ?? c.length, 0);

            start = Math.max(0, start);
            if (start >= total) return null;

            if (end > start && duration <= 0) duration = end - start;
            if (duration <= 0 && end > start) duration = end - start;
            if (duration <= 0) duration = Math.min(30, Math.max(1, total - start));

            const maxViable = total >= 10 ? Math.min(90, total) : total;
            const minViable = total >= 10 ? 10 : 1;
            duration = clamp(duration, minViable, maxViable);

            if (start + duration > total) {
                start = Math.max(0, total - duration);
                duration = total - start;
            }

            if (duration <= 0) return null;

            end = start + duration;

            return {
                start: Number(start.toFixed(2)),
                end: Number(end.toFixed(2)),
                duration: Number(duration.toFixed(2)),
                title: safeString(c.title ?? c.titulo ?? c.name, `Corte #${i + 1}`).trim(),
                description: safeString(c.description ?? c.descricao ?? c.reason, "Momento de destaque do vídeo").trim(),
                score: clamp(parseNumber(c.score ?? c.pontuacao ?? c.rating ?? c.relevance, 85), 0, 100)
            };
        })
        .filter(Boolean);

    cleaned.sort((a, b) => b.score - a.score);

    const selected = [];
    for (const candidate of cleaned) {
        const overlap = selected.some((existing) => {
            const isTooClose = Math.abs(candidate.start - existing.start) < 2;
            const isOverlapping = candidate.start < existing.end && candidate.end > existing.start;
            return isTooClose || isOverlapping;
        });

        if (!overlap) selected.push(candidate);
        if (selected.length >= MAX_CLIPS) break;
    }

    return selected.sort((a, b) => a.start - b.start);
}

/* ============================================================
   FALLBACK ALGORÍTMICO DISTRIBUÍDO
============================================================ */

function generateFallbackClips(totalDuration, requestedCount = 5) {
    const duration = Number(totalDuration) || 0;
    if (duration <= 0) return [];

    if (duration < 10) {
        return [{
            start: 0,
            end: Number(duration.toFixed(2)),
            duration: Number(duration.toFixed(2)),
            title: "Destaque do vídeo",
            description: "Trecho integral selecionado automaticamente",
            score: 75
        }];
    }

    const maxClips = Math.min(MAX_CLIPS, Math.max(1, Number(requestedCount) || 5));
    let clipLen = Math.min(60, Math.max(10, Math.min(30, Math.floor(duration / 2))));
    if (duration < 30) clipLen = Math.max(10, Math.floor(duration * 0.75));

    let count = Math.floor(duration / clipLen);
    if (count < 1) count = 1;
    count = Math.min(maxClips, count);

    const clips = [];
    if (count === 1) {
        const end = Math.min(duration, clipLen);
        clips.push({
            start: 0,
            end: Number(end.toFixed(2)),
            duration: Number(end.toFixed(2)),
            title: "Melhor momento",
            description: "Trecho automático selecionado pelo ClipForge",
            score: 85
        });
        return clips;
    }

    const step = (duration - clipLen) / (count - 1);
    for (let i = 0; i < count; i++) {
        const start = Number((i * step).toFixed(2));
        const end = Number(Math.min(duration, start + clipLen).toFixed(2));
        const d = Number((end - start).toFixed(2));

        if (d >= 5) {
            clips.push({
                start,
                end,
                duration: d,
                title: `Destaque #${i + 1}`,
                description: `Momento selecionado automaticamente pelo ClipForge (${start}s - ${end}s)`,
                score: Math.max(70, 90 - i * 3)
            });
        }
    }

    return clips;
}

function completeClipsWithFallback(clips, totalDuration) {
    const duration = Number(totalDuration) || 0;
    const valid = normalizeClipsScoreFirst(Array.isArray(clips) ? clips : [], duration);

    if (!valid.length) {
        return generateFallbackClips(duration, Math.min(5, MAX_CLIPS));
    }

    const minimumDesired = duration >= 30 ? 3 : 1;
    if (valid.length >= minimumDesired) {
        return valid.slice(0, MAX_CLIPS);
    }

    const fallback = generateFallbackClips(duration, MAX_CLIPS);
    const combined = [...valid];

    for (const candidate of fallback) {
        if (combined.length >= MAX_CLIPS) break;

        const overlap = combined.some((existing) => {
            const isTooClose = Math.abs(candidate.start - existing.start) < 2;
            const isOverlapping = candidate.start < existing.end && candidate.end > existing.start;
            return isTooClose || isOverlapping;
        });

        if (!overlap) combined.push(candidate);
    }

    return combined
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_CLIPS)
        .sort((a, b) => a.start - b.start);
}

/* ============================================================
   REQUISIÇÃO OPENROUTER
============================================================ */

async function requestOpenRouter(model, promptText, videoUrl) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    try {
        const content = [{ type: "text", text: promptText }];
        if (videoUrl) {
            content.push({
                type: "video_url",
                video_url: { url: videoUrl }
            });
        }

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
        if (!res.ok) {
            const err = new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 500)}`);
            err.status = res.status;
            throw err;
        }

        try {
            return JSON.parse(text);
        } catch (_) {
            throw new Error("OpenRouter retornou JSON inválido.");
        }
    } finally {
        clearTimeout(timeout);
    }
}

async function analyzeWithOpenRouterFallback(promptText, videoUrl, videoDuration) {
    if (!OPENROUTER_API_KEY) {
        throw new Error("OPENROUTER_API_KEY não configurada.");
    }

    let lastError = null;

    for (let i = 0; i < OPENROUTER_MODELS.length; i++) {
        const model = OPENROUTER_MODELS[i];

        try {
            console.log(`[IA] Consultando modelo: ${model}`);
            const data = await requestOpenRouter(model, promptText, videoUrl);
            const message = data?.choices?.[0]?.message?.content;

            const parsed = extractJsonFromText(
                typeof message === "string" ? message : JSON.stringify(message)
            );

            const raw = parsed?.clips || parsed?.cortes || parsed?.results || parsed;
            const clips = normalizeClipsScoreFirst(raw, videoDuration);

            if (clips.length) {
                return { model, clips };
            }

            throw new Error("IA não retornou cortes válidos.");
        } catch (e) {
            lastError = e;

            if (e.status === 401 || e.status === 402 || e.status === 403) {
                console.warn(`[IA] Falha terminal de crédito/autenticação (${e.status}). Interrompendo chamadas à IA.`);
                throw e;
            }

            if (i < OPENROUTER_MODELS.length - 1) {
                metrics.openRouterRetries++;
                metrics.openRouterFallbacks++;
                console.warn(`[IA] Fallback após falha em ${model}: ${e.message}`);
            } else {
                console.warn(`[IA] Todos os modelos OpenRouter falharam: ${e.message}`);
            }
        }
    }

    throw lastError || new Error("Todos os modelos de IA falharam.");
}

/* ============================================================
   RENDERIZAÇÃO FFMPEG COM FILTRO RESILIENTE SCALE + PAD
============================================================ */

async function renderClip(sourceFile, outputFile, start, duration, format = "9:16") {
    if (!FFMPEG_BIN) throw new Error("FFmpeg não disponível.");

    let vf = "";
    if (format === "9:16") {
        vf = "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black";
    } else if (format === "1:1") {
        vf = "scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=black";
    } else if (format === "16:9") {
        vf = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black";
    } else {
        throw new Error(`Formato '${format}' inválido. Escolha entre 9:16, 1:1 ou 16:9.`);
    }

    const args = [
        "-hide_banner",
        "-loglevel", "error",
        "-ss", String(start),
        "-i", sourceFile,
        "-t", String(duration),
        "-vf", vf,
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-threads", "2",
        "-crf", "24",
        "-c:a", "aac",
        "-b:a", "128k",
        "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart",
        "-y", outputFile
    ];

    const result = await spawnCapture(FFMPEG_BIN, args, { timeoutMs: 180000 });
    if (result.code !== 0) {
        throw new Error(`FFmpeg falhou: ${result.stderr || result.stdout}`);
    }

    const stat = await fsp.stat(outputFile);
    if (!stat.isFile() || stat.size === 0) {
        throw new Error("Renderização não produziu MP4 válido.");
    }

    return stat;
}

/* ============================================================
   FILA E WORKER SEQUENCIAL
============================================================ */

function processNextInQueue() {
    while (activeWorkers < CONCURRENT_JOBS_LIMIT && jobQueue.length) {
        const item = jobQueue.shift();
        activeWorkers++;

        runAnalysisWorker(item.jobId, item.payload)
            .then((result) => {
                const waiter = analysisWaiters.get(item.jobId);
                if (waiter) {
                    analysisWaiters.delete(item.jobId);
                    waiter.resolve(result);
                }
            })
            .catch((error) => {
                const waiter = analysisWaiters.get(item.jobId);
                if (waiter) {
                    analysisWaiters.delete(item.jobId);
                    waiter.reject(error);
                }
            })
            .finally(() => {
                activeWorkers--;
                processNextInQueue();
            });
    }
}

function enqueueJob(jobId, payload) {
    if (jobQueue.length >= MAX_QUEUE_LENGTH) {
        throw new Error("Fila cheia. Tente novamente em alguns instantes.");
    }

    return new Promise((resolve, reject) => {
        analysisWaiters.set(jobId, { resolve, reject });
        jobQueue.push({ jobId, payload });
        processNextInQueue();
    });
}

async function runAnalysisWorker(jobId, payload) {
    const job = jobs.get(jobId);
    if (!job) throw new Error("Job não encontrado.");

    let workDir = null;
    let aiToken = null;
    const user = users.get(job.userId);

    const setStage = (status, message, progress) => {
        job.status = status;
        job.stageMessage = message;
        job.progress = progress;
        job.updatedAt = now();
        console.log(`[Job ${jobId}] ${progress}% ${status}: ${message}`);
    };

    try {
        setStage("downloading", "Obtendo vídeo original...", 20);

        let sourceFile = "";
        let duration = 0;
        let title = "";

        if (payload.type === "youtube") {
            workDir = await fsp.mkdtemp(path.join(TEMP_ROOT, "job_yt_"));
            const dl = await downloadYouTubeVideo(payload.url, workDir);
            sourceFile = dl.filePath;
            duration = dl.duration;
            title = dl.title || "Vídeo do YouTube";
        } else {
            sourceFile = payload.filePath;
            duration = payload.duration;
            title = payload.originalName || "Vídeo MP4";

            const metadata = await validateVideoFile(sourceFile);
            duration = metadata.duration;
        }

        if (!duration || duration <= 0) {
            throw new Error("Não foi possível determinar a duração do vídeo.");
        }

        setStage("analyzing", "IA analisando momentos de retenção...", 60);

        aiToken = randomToken(32);
        aiVideoTokens.set(aiToken, {
            filePath: sourceFile,
            expiresAt: now() + 15 * 60 * 1000
        });

        const proxy = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/api/ai-video/${aiToken}` : "";
        let aiModel = "fallback";
        let aiUsed = false;
        let fallbackReason = null;
        let clips = [];

        try {
            if (!proxy) {
                throw new Error("PUBLIC_BASE_URL não configurada no ambiente.");
            }
            const aiResult = await analyzeWithOpenRouterFallback(
                buildClipPrompt(duration) + `\nTítulo: ${title}`,
                proxy,
                duration
            );
            aiModel = aiResult.model;
            clips = aiResult.clips || [];
            aiUsed = true;
            console.log(`[IA] ${aiModel} retornou ${clips.length} corte(s).`);
        } catch (aiError) {
            fallbackReason = aiError.message;
            console.warn(`[IA] Falha semântica: ${aiError.message}`);
            console.log("[IA] Ativando fallback algorítmico local...");
            clips = [];
            aiModel = "automatic-fallback";
            aiUsed = false;
        }

        clips = completeClipsWithFallback(clips, duration);

        if (!clips.length) {
            throw new Error("Não foi possível gerar cortes para este vídeo.");
        }

        if (job.reservedPoints > 0) {
            await commitPoints(user, job.reservedPoints);
            job.reservedPoints = 0;
        }

        job.status = "completed";
        job.stageMessage = "Análise concluída com sucesso.";
        job.progress = 100;
        job.updatedAt = now();
        job.result = {
            model: aiModel,
            aiUsed,
            fallbackReason,
            clips,
            duration,
            type: payload.type,
            uploadId: payload.uploadId || null,
            url: payload.url || null,
            title
        };

        if (user) {
            user.analyses = (user.analyses || 0) + 1;
            await persistUserData(user);
        }

        metrics.successfulAnalyses++;
        console.log(`[Worker] Job ${jobId} concluído com ${clips.length} corte(s).`);
        return job.result;
    } catch (err) {
        console.error(`[Worker] Falha ${jobId}: ${err.message}`);
        job.status = "failed";
        job.stageMessage = `Falha no processamento: ${err.message}`;
        job.error = err.message;
        job.progress = 0;
        job.updatedAt = now();

        if (job.reservedPoints > 0) {
            await refundPoints(user, job.reservedPoints);
            job.reservedPoints = 0;
        }

        metrics.failedAnalyses++;
        throw err;
    } finally {
        if (aiToken) {
            setTimeout(() => {
                aiVideoTokens.delete(aiToken);
            }, 60000).unref();
        }
        if (workDir) {
            setTimeout(async () => {
                await safeRemove(workDir);
            }, 60000).unref();
        }
    }
}

/* ============================================================
   USUÁRIOS E AUTENTICAÇÃO DUPLA
============================================================ */

function ensureUser(requestedId) {
    let userId = safeString(requestedId).trim() || randomId("user_");
    let user = users.get(userId);

    if (!user) {
        user = {
            id: userId,
            points: FREE_POINTS,
            reservedPoints: 0,
            vip: false,
            vipUntil: null,
            createdAt: now(),
            lastDailyClaim: now(),
            downloads: 0,
            analyses: 0
        };
        users.set(userId, user);
        persistUserData(user).catch(() => {});
    }

    isUserVip(user);

    const today = new Date().toISOString().slice(0, 10);
    const previous = user.lastDailyClaim
        ? new Date(user.lastDailyClaim).toISOString().slice(0, 10)
        : "";

    if (today !== previous) {
        user.points += DAILY_POINTS;
        user.lastDailyClaim = now();
        persistUserData(user).catch(() => {});
    }

    return user;
}

function publicUser(user) {
    const vipActive = isUserVip(user);

    return {
        id: user.id,
        userId: user.id,
        pontos: Math.max(0, Math.floor(user.points)),
        points: Math.max(0, Math.floor(user.points)),
        vip: vipActive,
        isVip: vipActive,
        vipUntil: user.vipUntil || null
    };
}

function getBearerToken(req) {
    const header = safeString(req.headers.authorization);
    if (header.toLowerCase().startsWith("bearer ")) {
        return header.slice(7).trim();
    }
    return "";
}

function requireUser(req, res, next) {
    const token = getBearerToken(req);
    let user = null;

    if (token) {
        const session = sessions.get(token);
        if (session && session.expiresAt > now()) {
            user = users.get(session.userId);
        }
    }

    if (!user && !IS_PROD) {
        const headerId = safeString(req.headers["x-user-id"]).trim();
        if (headerId) {
            user = ensureUser(headerId);
        }
    }

    if (!user) {
        return jsonError(res, 401, "Sessão inválida ou não autenticada.");
    }

    req.user = user;
    next();
}

function requireAdmin(req, res, next) {
    const token = safeString(req.headers["x-admin-session"]).trim() || getBearerToken(req);
    const session = adminSessions.get(token);

    if (!session || session.expiresAt < now()) {
        return jsonError(res, 401, "Sessão administrativa expirada ou inválida.");
    }

    next();
}

/* ============================================================
   ROTAS: AUTENTICAÇÃO E PERFIL (PROTEGIDO CONTRA IMPERSONAÇÃO)
============================================================ */

app.post("/api/auth/login", (req, res) => {
    const requestedId = safeString(req.body?.userId).trim();
    const existingToken = getBearerToken(req);
    let user = null;

    if (existingToken) {
        const session = sessions.get(existingToken);
        if (session && session.expiresAt > now()) {
            user = users.get(session.userId);
        }
    }

    if (requestedId && users.has(requestedId)) {
        if (!user || user.id !== requestedId) {
            return jsonError(res, 403, "Não é permitido assumir um identificador existente sem sessão válida.");
        }
    }

    if (!user) {
        user = ensureUser(requestedId || randomId("user_"));
    }

    const token = randomToken(48);
    sessions.set(token, {
        userId: user.id,
        expiresAt: now() + SESSION_TTL_MS
    });

    res.json({
        ok: true,
        token,
        session: token,
        user: publicUser(user)
    });
});

app.get("/api/auth/me", requireUser, (req, res) => {
    res.json({
        ok: true,
        user: publicUser(req.user)
    });
});

/* ============================================================
   ROTAS: UPLOAD DE VÍDEO MP4
============================================================ */

app.post("/api/upload", requireUser, uploadMiddleware.single("video"), async (req, res) => {
    try {
        if (!req.file) {
            return jsonError(res, 400, "Nenhum vídeo enviado.");
        }

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
            metadata
        };

        uploads.set(uploadId, item);
        metrics.uploads++;

        res.json({
            ok: true,
            uploadId,
            id: uploadId,
            duration: metadata.duration,
            file: {
                name: item.originalName,
                size: item.size
            }
        });
    } catch (err) {
        if (req.file?.path) {
            await safeRemove(req.file.path);
        }
        jsonError(res, 400, err.message);
    }
});

/* ============================================================
   ROTA: ANÁLISE SÍNCRONA COM RATE LIMITING
============================================================ */

app.post("/api/analisar", requireUser, rateLimitMiddleware(5, 60000), async (req, res) => {
    metrics.analyses++;
    const { url, uploadId } = req.body || {};

    const reserved = await reservePoints(req.user, ANALYSIS_COST);
    if (reserved === -1) {
        return jsonError(
            res,
            402,
            `Pontos insuficientes (Necessário: ${ANALYSIS_COST}, Disponível: ${req.user.points}).`
        );
    }

    let payload;

    if (uploadId) {
        const up = uploads.get(uploadId);
        if (!up || up.userId !== req.user.id) {
            await refundPoints(req.user, reserved);
            return jsonError(res, 404, "Upload não encontrado.");
        }

        payload = {
            type: "upload",
            uploadId,
            filePath: up.filePath,
            duration: up.metadata.duration,
            originalName: up.originalName
        };
    } else if (url) {
        const norm = normalizeYouTubeUrl(url);
        if (!norm) {
            await refundPoints(req.user, reserved);
            return jsonError(res, 400, "URL do YouTube inválida.");
        }

        payload = {
            type: "youtube",
            url: norm
        };
    } else {
        await refundPoints(req.user, reserved);
        return jsonError(res, 400, "Informe url ou uploadId.");
    }

    if (jobQueue.length >= MAX_QUEUE_LENGTH) {
        await refundPoints(req.user, reserved);
        return jsonError(res, 429, "Fila cheia. Tente novamente em alguns instantes.");
    }

    const jobId = randomId("job_");
    jobs.set(jobId, {
        id: jobId,
        userId: req.user.id,
        status: "queued",
        stageMessage: "Aguardando processamento...",
        progress: 5,
        reservedPoints: reserved,
        createdAt: now(),
        updatedAt: now()
    });

    try {
        const result = await enqueueJob(jobId, payload);

        return res.json({
            ok: true,
            clips: result.clips,
            duration: result.duration,
            model: result.model,
            aiUsed: result.aiUsed !== undefined ? result.aiUsed : true,
            fallbackReason: result.fallbackReason || null,
            title: result.title || "",
            uploadId: result.uploadId || null,
            url: result.url || null,
            jobId,
            status: "completed",
            user: publicUser(req.user)
        });
    } catch (e) {
        const job = jobs.get(jobId);
        if (job && job.reservedPoints > 0) {
            await refundPoints(req.user, job.reservedPoints);
            job.reservedPoints = 0;
        }

        metrics.errors++;
        return jsonError(res, 500, e.message || "Erro durante a análise.");
    }
});

/* ============================================================
   ROTAS: DOWNLOAD E RENDERIZAÇÃO REAL COM COMMIT APÓS STREAM
============================================================ */

app.post("/api/download", requireUser, rateLimitMiddleware(5, 60000), async (req, res) => {
    let temporarySource = null;
    let outputFile = null;

    const {
        start,
        duration,
        format = "9:16",
        uploadId,
        url
    } = req.body || {};

    const nStart = parseNumber(start, -1);
    let nDuration = parseNumber(duration, -1);

    if (nStart < 0 || nDuration <= 0) {
        return jsonError(res, 400, "Intervalo ou duração inválidos.");
    }

    const reserved = await reservePoints(req.user, DOWNLOAD_COST);
    if (reserved === -1) {
        return jsonError(
            res,
            402,
            `Pontos insuficientes para download (Necessário: ${DOWNLOAD_COST}).`
        );
    }

    try {
        let sourceFile = null;
        let sourceDuration = 0;

        if (uploadId) {
            const up = uploads.get(uploadId);
            if (!up || up.userId !== req.user.id) {
                throw new Error("Upload não encontrado.");
            }

            sourceFile = up.filePath;
            sourceDuration = up.metadata.duration;
        } else if (url) {
            const norm = normalizeYouTubeUrl(url);
            if (!norm) {
                throw new Error("URL do YouTube inválida.");
            }

            const workDir = await fsp.mkdtemp(path.join(TEMP_ROOT, "render_yt_"));
            const dl = await downloadYouTubeVideo(norm, workDir);

            sourceFile = dl.filePath;
            sourceDuration = dl.duration;
            temporarySource = workDir;
        } else {
            throw new Error("Informe uploadId ou url.");
        }

        if (!sourceDuration) {
            const meta = await getVideoMetadata(sourceFile);
            sourceDuration = meta.duration;
        }

        if (nStart >= sourceDuration) {
            throw new Error("O ponto de início ultrapassa a duração total do vídeo.");
        }

        if (nStart + nDuration > sourceDuration) {
            nDuration = sourceDuration - nStart;
        }

        if (nDuration <= 0) {
            throw new Error("Duração final do corte inválida.");
        }

        outputFile = path.join(OUTPUT_DIR, `${randomId("clip_")}.mp4`);
        const stat = await renderClip(sourceFile, outputFile, nStart, nDuration, format);

        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Length", String(stat.size));
        res.setHeader("Content-Disposition", `attachment; filename="clipforge_${Date.now()}.mp4"`);
        res.setHeader("X-ClipForge-User-Points", String(req.user.points));

        const stream = fs.createReadStream(outputFile);
        let finalized = false;

        const cleanup = async () => {
            await safeRemove(outputFile);
            if (temporarySource) {
                await safeRemove(temporarySource);
            }
        };

        res.on("finish", async () => {
            if (finalized) return;
            finalized = true;
            try {
                await commitPoints(req.user, reserved);
                req.user.downloads++;
                metrics.downloads++;
                await persistUserData(req.user);
            } catch (commitErr) {
                console.error("[Download] Erro ao consolidar pontos após stream:", commitErr.message);
            }
        });

        res.on("close", async () => {
            if (!res.writableEnded && !finalized) {
                finalized = true;
                await refundPoints(req.user, reserved);
                console.warn("[Download] Cliente abortou o download. Pontos estornados.");
            }
            await cleanup();
        });

        stream.on("error", async () => {
            if (!finalized) {
                finalized = true;
                await refundPoints(req.user, reserved);
            }
            await cleanup();
            if (!res.headersSent) {
                jsonError(res, 500, "Erro ao transmitir MP4.");
            }
        });

        stream.pipe(res);
    } catch (err) {
        await refundPoints(req.user, reserved);

        if (outputFile) await safeRemove(outputFile);
        if (temporarySource) await safeRemove(temporarySource);

        if (!res.headersSent) {
            return jsonError(res, 500, err.message || "Erro durante o processamento do corte.");
        }
    }
});

/* ============================================================
   MERCADO PAGO / PIX & WEBHOOK COM TRANSAÇÃO ATÔMICA
============================================================ */

async function aprovarPagamentoIdempotente(paymentId, externalPaymentData) {
    const pId = String(paymentId);
    let localPayment = payments.get(pId);

    const extRef = externalPaymentData?.external_reference || localPayment?.externalReference || "";
    let userId = localPayment?.userId;
    let itemType = localPayment?.itemType || "vip";

    if (!userId && extRef.includes("::")) {
        const parts = extRef.split("::");
        if (parts.length === 4 && parts[0] === "clipforge" && ["vip", "points"].includes(parts[2])) {
            userId = parts[1];
            itemType = parts[2];
        }
    }

    if (!localPayment && userId) {
        localPayment = {
            id: pId,
            userId,
            itemType,
            pointsAmount: itemType === "points" ? POINTS_PACKAGE_AMOUNT : 0,
            amount: Number(externalPaymentData?.transaction_amount || VIP_PRICE),
            status: "pending",
            createdAt: now(),
            externalReference: extRef
        };
        payments.set(pId, localPayment);
    }

    if (pgPool) {
        const client = await pgPool.connect();
        try {
            await client.query("BEGIN");
            const payRes = await client.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [pId]);
            if (payRes.rows.length && payRes.rows[0].status === "approved") {
                await client.query("COMMIT");
                return false;
            }

            const uRes = await client.query("SELECT * FROM users WHERE id = $1 FOR UPDATE", [userId]);
            if (uRes.rows.length) {
                const dbUser = mapDbUserToInternal(uRes.rows[0]);
                if (itemType === "points") {
                    const qtd = localPayment?.pointsAmount || POINTS_PACKAGE_AMOUNT;
                    dbUser.points += qtd;
                } else {
                    dbUser.vip = true;
                    const baseTime = (dbUser.vipUntil && dbUser.vipUntil > now()) ? dbUser.vipUntil : now();
                    dbUser.vipUntil = baseTime + VIP_DURATION_MS;
                }
                await client.query(
                    "UPDATE users SET points = $1, vip = $2, vip_until = $3 WHERE id = $4",
                    [dbUser.points, Boolean(dbUser.vip), dbUser.vipUntil, dbUser.id]
                );
                users.set(dbUser.id, dbUser);
            }

            const approvedAt = now();
            await client.query(
                `INSERT INTO payments (id, user_id, item_type, points_amount, amount, status, created_at, approved_at, external_reference)
                 VALUES ($1, $2, $3, $4, $5, 'approved', $6, $7, $8)
                 ON CONFLICT (id) DO UPDATE SET status = 'approved', approved_at = $7`,
                [
                    pId,
                    userId,
                    itemType,
                    localPayment?.pointsAmount || 0,
                    localPayment?.amount || VIP_PRICE,
                    localPayment?.createdAt || approvedAt,
                    approvedAt,
                    extRef
                ]
            );

            await client.query("COMMIT");

            if (localPayment) {
                localPayment.status = "approved";
                localPayment.approvedAt = approvedAt;
            }
            metrics.pixApproved++;
            metrics.revenueTotal += Number(localPayment?.amount || VIP_PRICE);
            return true;
        } catch (err) {
            await client.query("ROLLBACK");
            console.error("[Pix/Tx] Erro ao consolidar pagamento no Postgres:", err.message);
            throw err;
        } finally {
            client.release();
        }
    }

    if (!localPayment || localPayment.status === "approved") {
        return false;
    }

    localPayment.status = "approved";
    localPayment.approvedAt = now();

    const user = users.get(userId);
    if (user) {
        if (itemType === "points") {
            const qtd = localPayment.pointsAmount || POINTS_PACKAGE_AMOUNT;
            user.points += qtd;
        } else {
            user.vip = true;
            const baseTime = (user.vipUntil && user.vipUntil > now()) ? user.vipUntil : now();
            user.vipUntil = baseTime + VIP_DURATION_MS;
        }
        await persistUserData(user);
    }

    await persistPaymentData(localPayment);
    metrics.pixApproved++;
    metrics.revenueTotal += Number(localPayment.amount || 0);
    return true;
}

app.post("/api/pix/criar", requireUser, rateLimitMiddleware(5, 60000), async (req, res) => {
    if (!MP_CONFIGURED) {
        return jsonError(res, 503, "Mercado Pago não configurado.");
    }

    try {
        const itemType = req.body?.itemType === "points" ? "points" : "vip";
        const amount = itemType === "points"
            ? Number(POINTS_PACKAGE_PRICE.toFixed(2))
            : Number(VIP_PRICE.toFixed(2));

        const description = itemType === "points"
            ? `ClipForge Pro - Pacote ${POINTS_PACKAGE_AMOUNT} Pontos`
            : "ClipForge Pro - VIP Mensal (30 Dias)";

        const reference = ["clipforge", req.user.id, itemType, crypto.randomUUID()].join("::");
        const payerEmail = process.env.MP_PAYER_EMAIL || `cliente-${req.user.id}@clipforge.local`;

        const payment = await criarPagamentoPix({
            amount,
            description,
            email: payerEmail,
            externalReference: reference,
            notificationUrl: MP_WEBHOOK_URL || undefined
        });

        const paymentId = String(payment.id);
        const transaction = payment.point_of_interaction?.transaction_data || {};

        const paymentRecord = {
            id: paymentId,
            userId: req.user.id,
            itemType,
            pointsAmount: itemType === "points" ? POINTS_PACKAGE_AMOUNT : 0,
            amount,
            status: payment.status,
            createdAt: now(),
            externalReference: reference
        };

        payments.set(paymentId, paymentRecord);
        await persistPaymentData(paymentRecord);
        metrics.pixCreated++;

        res.json({
            ok: true,
            id: paymentId,
            itemType,
            status: payment.status,
            qr_code: transaction.qr_code || "",
            qr_code_base64: transaction.qr_code_base64 || "",
            ticket_url: transaction.ticket_url || "",
            amount
        });
    } catch (err) {
        metrics.errors++;
        jsonError(res, 502, err.message);
    }
});

app.get("/api/pix/status/:id", requireUser, async (req, res) => {
    if (!MP_CONFIGURED) {
        return jsonError(res, 503, "Mercado Pago não configurado no servidor.");
    }

    try {
        const paymentId = safeString(req.params.id).trim();
        const localPayment = payments.get(paymentId);

        if (localPayment && localPayment.userId !== req.user.id) {
            return jsonError(res, 403, "Pagamento não pertence a este usuário.");
        }

        const payment = await consultarPagamentoPix(paymentId);
        const isApproved = payment.status === "approved";

        if (isApproved) {
            await aprovarPagamentoIdempotente(paymentId, payment);
        } else if (localPayment) {
            localPayment.status = payment.status;
            await persistPaymentData(localPayment);
        }

        const finalStatus = payments.get(paymentId)?.status || payment.status;

        res.json({
            ok: true,
            id: paymentId,
            status: finalStatus,
            approved: finalStatus === "approved",
            user: publicUser(req.user)
        });
    } catch (err) {
        metrics.errors++;
        jsonError(res, 502, err.message);
    }
});

app.post("/api/pix/webhook", async (req, res) => {
    try {
        const query = req.query || {};
        const body = req.body || {};

        const topic = query.topic || query.type || body.type || body.action;
        const resourceId = query["data.id"] || query.id || body?.data?.id || body?.id;

        if (!resourceId) return res.status(200).send("No resource ID");

        const eventKey = `${topic}::${resourceId}`;

        if (pgPool) {
            const insertRes = await pgPool.query(
                "INSERT INTO webhooks (event_key, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_key",
                [eventKey, Date.now()]
            );
            if (insertRes.rows.length === 0) {
                return res.status(200).send("Already processed in database");
            }
        } else {
            if (processedWebhookEvents.has(eventKey)) {
                return res.status(200).send("Already processed");
            }
            processedWebhookEvents.add(eventKey);
            scheduleDatabaseSave();
        }

        if (topic === "payment" || topic === "payment.updated" || !topic) {
            if (typeof consultarPagamentoPix === "function") {
                const payment = await consultarPagamentoPix(String(resourceId));
                if (payment && payment.status === "approved") {
                    await aprovarPagamentoIdempotente(String(resourceId), payment);
                }
            }
        }

        res.status(200).send("OK");
    } catch (err) {
        console.error("[MercadoPago/Webhook] Falha ao processar webhook:", err.message);
        res.status(500).send("Internal Server Error");
    }
});

/* ============================================================
   ROTAS: ADMINISTRAÇÃO E MÉTRICAS COM RATE LIMITING
============================================================ */

app.post("/api/admin/login", rateLimitMiddleware(5, 60000), (req, res) => {
    if (!ADMIN_PASSWORD) {
        return jsonError(res, 503, "ADMIN_PASSWORD não configurada.");
    }

    const email = safeString(req.body?.email).trim().toLowerCase();
    const password = safeString(req.body?.password);

    const validEmail = email && email === ADMIN_EMAIL;

    if (!validEmail || password !== ADMIN_PASSWORD) {
        return jsonError(res, 401, "Credenciais administrativas inválidas.");
    }

    const token = randomToken(48);

    adminSessions.set(token, {
        createdAt: now(),
        expiresAt: now() + ADMIN_SESSION_TTL_MS
    });

    res.json({
        ok: true,
        token,
        session: token
    });
});

app.get("/api/admin/dashboard", requireAdmin, (req, res) => {
    let vipUsers = 0;
    let totalPoints = 0;

    for (const u of users.values()) {
        if (isUserVip(u)) vipUsers++;
        totalPoints += Math.max(0, u.points);
    }

    res.json({
        ok: true,
        version: VERSION,
        metrics: {
            ...metrics,
            users: users.size,
            vipUsers,
            totalPoints,
            revenueTotal: Number(metrics.revenueTotal.toFixed(2))
        },
        uptime: process.uptime()
    });
});

/* ============================================================
   PARSER RFC 7233 — HTTP RANGE ÚNICO
============================================================ */

function parseSingleRange(rangeHeader, fileSize) {
    if (!rangeHeader || !Number.isFinite(fileSize) || fileSize <= 0) {
        return { invalid: true };
    }

    const normalized = String(rangeHeader).trim();

    if (!/^bytes=/i.test(normalized)) {
        return { invalid: true };
    }

    const rangeValue = normalized.slice(6).trim();
    if (!rangeValue || rangeValue.includes(",")) {
        return { invalid: true };
    }

    const match = rangeValue.match(/^(\d*)-(\d*)$/);
    if (!match) return { invalid: true };

    const startRaw = match[1];
    const endRaw = match[2];

    if (startRaw === "" && endRaw === "") return { invalid: true };

    let start = 0;
    let end = fileSize - 1;

    if (startRaw === "" && endRaw !== "") {
        const suffixLength = parseInt(endRaw, 10);
        if (isNaN(suffixLength) || suffixLength <= 0) return { invalid: true };
        start = Math.max(0, fileSize - suffixLength);
        end = fileSize - 1;
    } else if (startRaw !== "" && endRaw === "") {
        start = parseInt(startRaw, 10);
        end = fileSize - 1;
    } else {
        start = parseInt(startRaw, 10);
        end = parseInt(endRaw, 10);
    }

    if (isNaN(start) || isNaN(end) || start < 0 || start >= fileSize || end < start) {
        return { invalid: true };
    }

    end = Math.min(end, fileSize - 1);

    return {
        start,
        end,
        chunkSize: end - start + 1
    };
}

/* ============================================================
   ENDPOINT DA IA — GET + HEAD COM HTTP RANGE (206 E 416)
============================================================ */

const handleAiVideoStreaming = async (req, res) => {
    const entry = aiVideoTokens.get(req.params.token);

    if (!entry || entry.expiresAt < now() || !fs.existsSync(entry.filePath)) {
        return res.status(404).send("Vídeo temporário expirado ou indisponível.");
    }

    try {
        const stat = await fsp.stat(entry.filePath);
        const fileSize = stat.size;
        const rangeHeader = req.headers.range;

        if (!rangeHeader) {
            res.writeHead(200, {
                "Content-Length": fileSize,
                "Content-Type": "video/mp4",
                "Accept-Ranges": "bytes"
            });

            if (req.method === "HEAD") return res.end();
            return fs.createReadStream(entry.filePath).pipe(res);
        }

        const range = parseSingleRange(rangeHeader, fileSize);

        if (!range || range.invalid) {
            res.setHeader("Content-Range", `bytes */${fileSize}`);
            return res.status(416).send("Requested Range Not Satisfiable");
        }

        res.writeHead(206, {
            "Content-Range": `bytes ${range.start}-${range.end}/${fileSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": range.chunkSize,
            "Content-Type": "video/mp4"
        });

        if (req.method === "HEAD") return res.end();

        const file = fs.createReadStream(entry.filePath, {
            start: range.start,
            end: range.end
        });

        file.pipe(res);
    } catch (err) {
        console.error("[AI Video] Erro no streaming de vídeo:", err.message);

        if (!res.headersSent) {
            return res.status(500).send("Erro ao ler arquivo de vídeo.");
        }

        try { res.end(); } catch (_) {}
    }
};

app.get("/api/ai-video/:token", handleAiVideoStreaming);
app.head("/api/ai-video/:token", handleAiVideoStreaming);

/* ============================================================
   DIAGNÓSTICO E SAÚDE DO SERVIDOR
============================================================ */

app.get("/health", async (req, res) => {
    res.json({
        ok: true,
        status: "online",
        service: "clipforge-server",
        version: VERSION,
        database: {
            driver: pgPool ? "postgresql" : "local-file",
            connected: Boolean(pgPool || fs.existsSync(DB_FILE))
        },
        models: {
            primary: OPENROUTER_MODEL,
            fallbacks: OPENROUTER_FALLBACK_MODELS
        },
        binaries: {
            ffmpeg: await commandExists(FFMPEG_BIN, ["-version"]),
            ffprobe: await commandExists(FFPROBE_BIN, ["-version"]),
            ytDlp: await commandExists(YTDLP_BIN, ["--version"])
        },
        cookies: {
            configured: Boolean(YTDLP_COOKIES_FILE || YTDLP_COOKIES_BASE64 || YTDLP_COOKIES_URL)
        },
        persistence: {
            usersLoaded: users.size,
            paymentsLoaded: payments.size,
            revenueTotal: Number(metrics.revenueTotal.toFixed(2))
        },
        queue: {
            inQueue: jobQueue.length,
            activeWorkers
        },
        jobs: {
            total: jobs.size,
            queued: Array.from(jobs.values()).filter((j) => j.status === "queued").length,
            running: Array.from(jobs.values()).filter((j) => ["downloading", "analyzing"].includes(j.status)).length
        }
    });
});

app.get("/", (req, res) => {
    res.json({
        ok: true,
        service: "ClipForge Pro",
        version: VERSION,
        status: "online"
    });
});

/* ============================================================
   LIMPEZA AUTOMÁTICA DE DISCO E SESSÕES
============================================================ */

setInterval(async () => {
    const expiration = now() - UPLOAD_TTL_MS;

    for (const [id, up] of uploads.entries()) {
        if (up.createdAt < expiration) {
            await safeRemove(up.filePath);
            uploads.delete(id);
        }
    }

    const current = now();

    for (const [token, s] of sessions.entries()) {
        if (s.expiresAt < current) sessions.delete(token);
    }

    for (const [token, s] of adminSessions.entries()) {
        if (s.expiresAt < current) adminSessions.delete(token);
    }

    for (const [token, v] of aiVideoTokens.entries()) {
        if (v.expiresAt < current) aiVideoTokens.delete(token);
    }

    for (const [id, j] of jobs.entries()) {
        if (now() - j.createdAt > 3 * 3600 * 1000) jobs.delete(id);
    }
}, 15 * 60 * 1000).unref();

/* ============================================================
   INICIALIZAÇÃO DO SERVIDOR COM FAIL-FAST EM PRODUÇÃO
============================================================ */

async function startServer() {
    try {
        if (IS_PROD) {
            if (!PUBLIC_BASE_URL || !PUBLIC_BASE_URL.startsWith("https://")) {
                throw new Error("PUBLIC_BASE_URL obrigatória com HTTPS em produção para que a IA consiga inspecionar os vídeos.");
            }
        }

        await ensureDirectories();
        await initDatabase();
        await resolveBinaries();
        await setupYtdlpCookies();

        app.listen(PORT, HOST, () => {
            console.log("====================================================");
            console.log(` 🚀 CLIPFORGE PRO — BACKEND ${VERSION} ONLINE`);
            console.log(` 🌐 http://${HOST}:${PORT}`);
            console.log(` 🤖 Modelo Primário: ${OPENROUTER_MODEL}`);
            console.log(` 💾 Armazenamento: ${pgPool ? "PostgreSQL (Produção)" : "Arquivo Local (Dev)"}`);
            console.log("====================================================");
        });
    } catch (err) {
        console.error("[Startup] FATAL ERROR:", err.message);
        process.exit(1);
    }
}

startServer();
