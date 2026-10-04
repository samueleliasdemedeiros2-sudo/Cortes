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

/*
 * Modelo principal.
 *
 * Gemini continua sendo o "cérebro", mas agora passa pelo
 * OpenRouter. Portanto NÃO usamos mais a API direta do Google.
 */
const OPENROUTER_MODEL =
    process.env.OPENROUTER_MODEL ||
    "google/gemini-3.5-flash";

const OPENROUTER_FALLBACK_MODELS = (
    process.env.OPENROUTER_FALLBACK_MODELS ||
    "google/gemini-2.5-flash,bytedance-seed/seed-2.0-lite"
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

/*
 * URL pública do backend.
 *
 * No Render, RECOMENDADO:
 *
 * PUBLIC_BASE_URL=https://clipforge-server-ikai.onrender.com
 *
 * Se não configurar, tentamos montar automaticamente usando
 * RENDER_EXTERNAL_URL.
 */
const PUBLIC_BASE_URL =
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    "";

const OPENROUTER_SITE_URL =
    process.env.OPENROUTER_SITE_URL ||
    "https://clipforge.netlify.app";

const OPENROUTER_SITE_NAME =
    process.env.OPENROUTER_SITE_NAME ||
    "ClipForge Pro";

/*
 * Tokens temporários usados para permitir que o OpenRouter
 * leia um vídeo que está armazenado localmente no Render.
 */
const aiVideoTokens = new Map();

const AI_VIDEO_TOKEN_TTL_MS = 15 * 60 * 1000;