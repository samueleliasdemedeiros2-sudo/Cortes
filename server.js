/**
 * ============================================================
 * CLIPFORGE PRO
 * Backend 13.0.6
 * ============================================================
 *
 * Node.js + Express
 *
 * PRINCIPAIS RECURSOS:
 * - Gemini Interactions API oficial
 * - Gemini 3.8 Flash
 * - Análise multimodal direta de URLs públicas do YouTube
 * - Saída estruturada JSON via response_format + schema
 * - Pipeline de download:
 *      Downloader Externo -> RapidAPI -> yt-dlp
 * - FFmpeg H.264 + AAC + yuv420p + faststart
 * - Autenticação por sessão
 * - Sistema de pontos
 * - Integração Mercado Pago Pix
 * - Dashboard administrativo
 * - Limpeza automática de arquivos temporários
 *
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

/* ============================================================
   CONFIGURAÇÃO GERAL
   ============================================================ */

const APP_VERSION = "13.0.6";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || "0.0.0.0";
const NODE_ENV = process.env.NODE_ENV || "production";

/* ============================================================
   GEMINI
   ============================================================ */

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  "";

const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.8-flash";

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

/* ============================================================
   DOWNLOAD
   ============================================================ */

const RAPIDAPI_KEY =
  process.env.RAPIDAPI_KEY ||
  process.env.X_RAPIDAPI_KEY ||
  "";

const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST ||
  "youtube-media-downloader.p.rapidapi.com";

const EXTERNAL_DOWNLOAD_URL =
  process.env.EXTERNAL_DOWNLOAD_URL ||
  "";

const EXTERNAL_DOWNLOAD_TOKEN =
  process.env.EXTERNAL_DOWNLOAD_TOKEN ||
  "";

const YTDLP_PATH =
  process.env.YTDLP_PATH ||
  path.join(process.cwd(), "bin", "yt-dlp");

const FFMPEG_PATH =
  process.env.FFMPEG_PATH ||
  "ffmpeg";

const FFPROBE_PATH =
  process.env.FFPROBE_PATH ||
  "ffprobe";

const YTDLP_COOKIES_FILE =
  process.env.YTDLP_COOKIES_FILE ||
  "";

/* ============================================================
   MERCADO PAGO
   ============================================================ */

const MP_ACCESS_TOKEN =
  process.env.MP_ACCESS_TOKEN ||
  process.env.MERCADOPAGO_ACCESS_TOKEN ||
  "";

/* ============================================================
   ADMIN
   ============================================================ */

const ADMIN_USER =
  process.env.ADMIN_USER ||
  "admin";

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ||
  "";

/* ============================================================
   CORS
   ============================================================ */

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  "";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://clipforge.netlify.app",
  "https://clipforge-pro.netlify.app",
  "https://clipforgepro.netlify.app",
];

const ALLOWED_ORIGINS = [
  ...new Set(
    [
      ...DEFAULT_ALLOWED_ORIGINS,
      FRONTEND_URL,
      ...(process.env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ].filter(Boolean)
  ),
];

/* ============================================================
   DIRETÓRIOS
   ============================================================ */

const TEMP_ROOT =
  path.join(os.tmpdir(), "clipforge-pro");

const DOWNLOAD_DIR =
  path.join(TEMP_ROOT, "downloads");

const OUTPUT_DIR =
  path.join(TEMP_ROOT, "outputs");

/* ============================================================
   MEMÓRIA
   ============================================================ */

const users = new Map();
const sessions = new Map();
const adminSessions = new Map();
const payments = new Map();

/* ============================================================
   MÉTRICAS
   ============================================================ */

const metrics = {
  startedAt: new Date().toISOString(),

  requests: 0,

  analyses: 0,
  analysisSuccess: 0,
  analysisFailures: 0,

  geminiRequests: 0,
  geminiSuccess: 0,
  geminiFailures: 0,

  downloads: 0,
  downloadSuccess: 0,
  downloadFailures: 0,

  externalDownloadAttempts: 0,
  rapidApiAttempts: 0,
  ytdlpAttempts: 0,

  pixCreated: 0,
  pixApproved: 0,
  pixRejected: 0,

  errors: 0,
};

/* ============================================================
   UTILITÁRIOS
   ============================================================ */

function now() {
  return Date.now();
}

function randomId(prefix = "") {
  return prefix + crypto.randomBytes(12).toString("hex");
}

function safeString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }

  return String(value);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(
    max,
    Math.max(min, number)
  );
}

/* ============================================================
   YOUTUBE
   ============================================================ */

function extractYouTubeVideoId(input) {
  if (!input) {
    return null;
  }

  const value = String(input).trim();

  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) {
    return value;
  }

  try {
    const url = new URL(value);

    const host =
      url.hostname.toLowerCase();

    if (
      host.includes("youtube.com")
    ) {
      const queryId =
        url.searchParams.get("v");

      if (
        queryId &&
        /^[a-zA-Z0-9_-]{11}$/.test(queryId)
      ) {
        return queryId;
      }

      const match =
        url.pathname.match(
          /\/(shorts|embed|live)\/([a-zA-Z0-9_-]{11})/
        );

      if (match) {
        return match[2];
      }
    }

    if (
      host === "youtu.be" ||
      host === "www.youtu.be"
    ) {
      const id =
        url.pathname
          .replace(/^\/+/, "")
          .split("/")[0];

      if (
        /^[a-zA-Z0-9_-]{11}$/.test(id)
      ) {
        return id;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeYouTubeUrl(input) {
  const videoId =
    extractYouTubeVideoId(input);

  if (!videoId) {
    return null;
  }

  return {
    videoId,
    url:
      `https://www.youtube.com/watch?v=${videoId}`,
  };
}

/* ============================================================
   ARQUIVOS
   ============================================================ */

async function ensureDirectories() {
  await fsp.mkdir(
    DOWNLOAD_DIR,
    { recursive: true }
  );

  await fsp.mkdir(
    OUTPUT_DIR,
    { recursive: true }
  );
}

async function safeRemove(file) {
  if (!file) {
    return;
  }

  try {
    await fsp.rm(
      file,
      {
        recursive: true,
        force: true,
      }
    );
  } catch {}
}

async function cleanupOldFiles() {
  const directories = [
    DOWNLOAD_DIR,
    OUTPUT_DIR,
  ];

  const cutoff =
    Date.now() -
    60 * 60 * 1000;

  for (const dir of directories) {
    try {
      const entries =
        await fsp.readdir(
          dir,
          {
            withFileTypes: true,
          }
        );

      for (const entry of entries) {
        const fullPath =
          path.join(
            dir,
            entry.name
          );

        try {
          const stat =
            await fsp.stat(fullPath);

          if (
            stat.mtimeMs < cutoff
          ) {
            await safeRemove(
              fullPath
            );
          }
        } catch {}
      }
    } catch {}
  }
}

/* ============================================================
   USUÁRIOS
   ============================================================ */

function getOrCreateUser(userId) {
  const id =
    userId ||
    randomId("user_");

  let user =
    users.get(id);

  if (!user) {
    user = {
      id,

      createdAt:
        new Date().toISOString(),

      analyses: 0,
      downloads: 0,

      points: 200,

      vip: false,

      lastAnalysisAt: null,
      lastDownloadAt: null,
    };

    users.set(
      id,
      user
    );
  }

  return user;
}

/* ============================================================
   SESSÕES
   ============================================================ */

function createSession(userId) {
  const token =
    randomId("sess_");

  sessions.set(
    token,
    {
      userId,

      createdAt:
        now(),

      expiresAt:
        now() +
        30 *
          24 *
          60 *
          60 *
          1000,
    }
  );

  return token;
}

function getSessionUser(req) {
  const authorization =
    req.headers.authorization ||
    "";

  if (
    !authorization.startsWith(
      "Bearer "
    )
  ) {
    return null;
  }

  const token =
    authorization
      .slice(7)
      .trim();

  if (!token) {
    return null;
  }

  const session =
    sessions.get(token);

  if (!session) {
    return null;
  }

  if (
    session.expiresAt <
    now()
  ) {
    sessions.delete(token);
    return null;
  }

  return getOrCreateUser(
    session.userId
  );
}

function resolveRequestUser(req) {
  const sessionUser =
    getSessionUser(req);

  if (sessionUser) {
    return sessionUser;
  }

  const userId =
    req.headers["x-user-id"] ||
    (
      req.body &&
      (
        req.body.userId ||
        req.body.user_id
      )
    );

  if (userId) {
    return getOrCreateUser(
      safeString(userId)
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
    getSessionUser(req);

  if (!user) {
    return res.status(401).json({
      ok: false,
      error:
        "Sessão inválida ou expirada.",
      code:
        "UNAUTHORIZED",
    });
  }

  req.user = user;

  next();
}

/* ============================================================
   ADMIN
   ============================================================ */

function createAdminSession() {
  const token =
    randomId("admin_");

  adminSessions.set(
    token,
    {
      createdAt:
        now(),

      expiresAt:
        now() +
        12 *
          60 *
          60 *
          1000,
    }
  );

  return token;
}

function requireAdmin(
  req,
  res,
  next
) {
  const authorization =
    req.headers.authorization ||
    "";

  if (
    !authorization.startsWith(
      "Bearer "
    )
  ) {
    return res.status(401).json({
      ok: false,
      error:
        "Acesso administrativo não autorizado.",
    });
  }

  const token =
    authorization
      .slice(7)
      .trim();

  const session =
    adminSessions.get(token);

  if (
    !session ||
    session.expiresAt < now()
  ) {
    if (session) {
      adminSessions.delete(token);
    }

    return res.status(401).json({
      ok: false,
      error:
        "Sessão administrativa expirada ou inválida.",
    });
  }

  req.admin = true;

  next();
}

/* ============================================================
   CORS / MIDDLEWARE
   ============================================================ */

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(
        null,
        true
      );
    }

    if (
      NODE_ENV !== "production" &&
      (
        origin.startsWith(
          "http://localhost:"
        ) ||
        origin.startsWith(
          "http://127.0.0.1:"
        )
      )
    ) {
      return callback(
        null,
        true
      );
    }

    if (
      ALLOWED_ORIGINS.includes(
        origin
      ) ||
      origin.endsWith(
        ".netlify.app"
      ) ||
      origin.endsWith(
        ".vercel.app"
      )
    ) {
      return callback(
        null,
        true
      );
    }

    /*
     * Mantido permissivo durante
     * a fase de testes do ClipForge.
     */
    return callback(
      null,
      true
    );
  },

  methods: [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-User-Id",
    "X-Requested-With",
  ],

  credentials: true,

  maxAge: 86400,
};

app.disable(
  "x-powered-by"
);

app.use(
  cors(corsOptions)
);

app.options(
  /.*/,
  cors(corsOptions)
);

app.use(
  express.json({
    limit: "2mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "2mb",
  })
);

app.use(
  (req, res, next) => {
    metrics.requests++;

    res.setHeader(
      "X-ClipForge-Version",
      APP_VERSION
    );

    next();
  }
);

/* ============================================================
   GEMINI SCHEMA
   ============================================================ */

const geminiSchema = {
  type: "object",

  properties: {
    title: {
      type: "string",
    },

    summary: {
      type: "string",
    },

    clips: {
      type: "array",

      items: {
        type: "object",

        properties: {
          start: {
            type: "number",
          },

          end: {
            type: "number",
          },

          title: {
            type: "string",
          },

          description: {
            type: "string",
          },

          score: {
            type: "number",
          },

          reason: {
            type: "string",
          },
        },

        required: [
          "start",
          "end",
          "title",
          "description",
          "score",
          "reason",
        ],
      },
    },
  },

  required: [
    "title",
    "summary",
    "clips",
  ],
};

/* ============================================================
   PROMPT
   ============================================================ */

function buildGeminiPrompt({
  videoId,
  maxClips = 5,
  minDuration = 20,
  maxDuration = 60,
}) {
  return `
Você é o motor de cortes com IA do ClipForge Pro.

Analise o vídeo do YouTube fornecido integralmente.

Seu objetivo é encontrar os melhores momentos para cortes
verticais para YouTube Shorts, TikTok e Instagram Reels.

ID DO VÍDEO:
${videoId}

QUANTIDADE:
Retorne no máximo ${maxClips} cortes.

DURAÇÃO:
Cada corte deve ter entre ${minDuration} e ${maxDuration} segundos.

CRITÉRIOS:

1. Priorize momentos com alto potencial de retenção.
2. Procure ganchos fortes.
3. Procure frases impactantes.
4. Procure histórias completas.
5. Procure humor.
6. Procure revelações.
7. Procure opiniões fortes ou interessantes.
8. Procure momentos emocionais.
9. Evite trechos sem contexto.
10. Evite pausas longas.
11. Evite cortes que começam ou terminam no meio de uma frase.
12. Sempre que possível, preserve o contexto necessário para entender o momento.
13. Os timestamps devem corresponder ao vídeo real.
14. O score deve variar de 0 a 100.
15. Não invente timestamps.

IMPORTANTE:

Retorne somente os dados solicitados pelo schema.

Não escreva explicações fora do JSON.

Cada objeto de clip deve conter:
- start
- end
- title
- description
- score
- reason
`.trim();
}

/* ============================================================
   EXTRAÇÃO DA RESPOSTA GEMINI
   ============================================================ */

function extractGeminiOutputText(data) {
  if (!data) {
    return "";
  }

  if (
    typeof data.output_text === "string" &&
    data.output_text.trim()
  ) {
    return data.output_text.trim();
  }

  if (
    typeof data.outputText === "string" &&
    data.outputText.trim()
  ) {
    return data.outputText.trim();
  }

  /*
   * Interactions API atual:
   *
   * steps:
   * [
   *   {
   *     type: "model_output",
   *     content: [
   *       {
   *         type: "text",
   *         text: "..."
   *       }
   *     ]
   *   }
   * ]
   */

  if (
    Array.isArray(data.steps)
  ) {
    for (
      const step of data.steps
    ) {
      if (!step) continue;

      if (
        typeof step.text === "string" &&
        step.text.trim()
      ) {
        return step.text.trim();
      }

      if (
        Array.isArray(
          step.content
        )
      ) {
        for (
          const content
            of step.content
        ) {
          if (
            typeof content?.text ===
              "string" &&
            content.text.trim()
          ) {
            return content.text.trim();
          }
        }
      }
    }
  }

  if (
    Array.isArray(data.outputs)
  ) {
    for (
      const output
        of data.outputs
    ) {
      if (!output) continue;

      if (
        typeof output.text === "string" &&
        output.text.trim()
      ) {
        return output.text.trim();
      }

      if (
        Array.isArray(
          output.content
        )
      ) {
        for (
          const content
            of output.content
        ) {
          if (
            typeof content?.text ===
              "string" &&
            content.text.trim()
          ) {
            return content.text.trim();
          }
        }
      }
    }
  }

  /*
   * Compatibilidade com respostas
   * antigas/alternativas.
   */

  if (
    Array.isArray(
      data.candidates
    )
  ) {
    const candidate =
      data.candidates[0];

    if (
      candidate?.content?.parts
    ) {
      return candidate.content.parts
        .map(
          (part) =>
            part?.text || ""
        )
        .join("")
        .trim();
    }
  }

  return "";
}

/* ============================================================
   JSON
   ============================================================ */

function extractJsonFromText(text) {
  if (!text) {
    return null;
  }

  let value =
    String(text).trim();

  value =
    value
      .replace(
        /^```json\s*/i,
        ""
      )
      .replace(
        /^```\s*/i,
        ""
      )
      .replace(
        /\s*```$/i,
        ""
      )
      .trim();

  try {
    return JSON.parse(
      value
    );
  } catch {}

  const first =
    value.indexOf("{");

  const last =
    value.lastIndexOf("}");

  if (
    first !== -1 &&
    last > first
  ) {
    try {
      return JSON.parse(
        value.slice(
          first,
          last + 1
        )
      );
    } catch {}
  }

  return null;
}

/* ============================================================
   NORMALIZAÇÃO DOS CORTES
   ============================================================ */

function normalizarClips(
  clips,
  options = {}
) {
  if (
    !Array.isArray(clips)
  ) {
    return [];
  }

  const requestedMin =
    Number(
      options.minDuration || 20
    );

  const requestedMax =
    Number(
      options.maxDuration || 60
    );

  const minDuration =
    Math.min(
      requestedMin,
      requestedMax
    );

  const maxDuration =
    Math.max(
      requestedMin,
      requestedMax
    );

  const maxClips =
    Number(
      options.maxClips || 5
    );

  const normalized = [];

  for (
    const clip of clips
  ) {
    if (!clip) {
      continue;
    }

    let start =
      Number(
        clip.start ??
        clip.inicio ??
        0
      );

    let end =
      Number(
        clip.end ??
        clip.fim ??
        (start + 50)
      );

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end)
    ) {
      continue;
    }

    start =
      Math.max(
        0,
        start
      );

    end =
      Math.max(
        start,
        end
      );

    let duration =
      end - start;

    if (
      duration < minDuration
    ) {
      end =
        start +
        minDuration;

      duration =
        minDuration;
    }

    if (
      duration > maxDuration
    ) {
      end =
        start +
        maxDuration;

      duration =
        maxDuration;
    }

    normalized.push({
      start:
        Number(
          start.toFixed(2)
        ),

      end:
        Number(
          end.toFixed(2)
        ),

      duration:
        Number(
          duration.toFixed(2)
        ),

      title:
        safeString(
          clip.title ||
          "Corte selecionado"
        ).slice(
          0,
          140
        ),

      description:
        safeString(
          clip.description ||
          ""
        ).slice(
          0,
          500
        ),

      score:
        clampNumber(
          clip.score,
          0,
          100,
          80
        ),

      reason:
        safeString(
          clip.reason ||
          "Destaque selecionado por IA"
        ).slice(
          0,
          500
        ),
    });
  }

  normalized.sort(
    (a, b) =>
      b.score - a.score
  );

  const result = [];

  for (
    const clip of normalized
  ) {
    const overlap =
      result.some(
        (existing) => {
          const overlapStart =
            Math.max(
              existing.start,
              clip.start
            );

          const overlapEnd =
            Math.min(
              existing.end,
              clip.end
            );

          return (
            overlapEnd >
            overlapStart
          );
        }
      );

    if (!overlap) {
      result.push(
        clip
      );
    }

    if (
      result.length >=
      maxClips
    ) {
      break;
    }
  }

  result.sort(
    (a, b) =>
      a.start - b.start
  );

  return result;
}

/* ============================================================
   GEMINI
   ============================================================ */

async function analisarComGemini({
  youtubeUrl,
  videoId,
  maxClips,
  minDuration,
  maxDuration,
}) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY não configurada no servidor."
    );
  }

  metrics.geminiRequests++;

  const prompt =
    buildGeminiPrompt({
      videoId,
      maxClips,
      minDuration,
      maxDuration,
    });

  /*
   * A documentação atual do Gemini confirma:
   *
   * model:
   * gemini-3.8-flash
   *
   * input:
   * [
   *   { type: "text", text: "..." },
   *   {
   *     type: "video",
   *     uri: "https://www.youtube.com/watch?v=..."
   *   }
   * ]
   *
   * A URL pública do YouTube é suportada
   * diretamente pela Interactions API.
   */

  const body = {
    model:
      GEMINI_MODEL,

    input: [
      {
        type: "text",
        text: prompt,
      },

      {
        type: "video",
        uri: youtubeUrl,
      },
    ],

    /*
     * Structured Output.
     *
     * O Gemini retorna o JSON como texto,
     * mas obedecendo ao schema.
     */

    response_format: {
      type: "text",

      mime_type:
        "application/json",

      schema:
        geminiSchema,
    },
  };

  console.log(
    `[Gemini] Modelo: ${GEMINI_MODEL}`
  );

  console.log(
    `[Gemini] Endpoint: ${GEMINI_ENDPOINT}`
  );

  console.log(
    `[Gemini] Enviando URL pública do YouTube para análise...`
  );

  let response;

  try {
    response =
      await fetch(
        GEMINI_ENDPOINT,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            "x-goog-api-key":
              GEMINI_API_KEY,
          },

          body:
            JSON.stringify(body),

          signal:
            AbortSignal.timeout(
              180000
            ),
        }
      );
  } catch (error) {
    metrics.geminiFailures++;

    throw new Error(
      `Falha de conexão com Gemini: ${error.message}`
    );
  }

  const rawText =
    await response.text();

  let data = null;

  try {
    data =
      rawText
        ? JSON.parse(rawText)
        : null;
  } catch {}

  if (!response.ok) {
    metrics.geminiFailures++;

    let safeError =
      rawText || "";

    if (GEMINI_API_KEY) {
      safeError =
        safeError.replace(
          new RegExp(
            GEMINI_API_KEY.replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&"
            ),
            "g"
          ),
          "[REDACTED]"
        );
    }

    throw new Error(
      `Gemini HTTP ${response.status}: ${safeError.slice(0, 1000)}`
    );
  }

  const outputText =
    extractGeminiOutputText(
      data
    );

  if (!outputText) {
    metrics.geminiFailures++;

    throw new Error(
      "Gemini não retornou texto estruturado válido."
    );
  }

  const parsed =
    extractJsonFromText(
      outputText
    );

  if (!parsed) {
    metrics.geminiFailures++;

    throw new Error(
      "Não foi possível extrair o JSON dos cortes da resposta do Gemini."
    );
  }

  const clips =
    normalizarClips(
      parsed.clips,
      {
        maxClips,
        minDuration,
        maxDuration,
      }
    );

  metrics.geminiSuccess++;

  return {
    title:
      safeString(
        parsed.title ||
        "Vídeo analisado"
      ),

    summary:
      safeString(
        parsed.summary ||
        ""
      ),

    clips,
  };
}

/* ============================================================
   EXECUÇÃO DE PROCESSOS
   ============================================================ */

function runCommand(
  command,
  args,
  options = {}
) {
  return new Promise(
    (resolve, reject) => {
      const child =
        spawn(
          command,
          args,
          {
            cwd:
              options.cwd ||
              process.cwd(),

            env: {
              ...process.env,
              ...(options.env || {}),
            },

            windowsHide: true,
          }
        );

      let stdout = "";
      let stderr = "";

      child.stdout.on(
        "data",
        (chunk) => {
          stdout +=
            chunk.toString();
        }
      );

      child.stderr.on(
        "data",
        (chunk) => {
          stderr +=
            chunk.toString();
        }
      );

      const timeout =
        setTimeout(
          () => {
            try {
              child.kill(
                "SIGKILL"
              );
            } catch {}

            reject(
              new Error(
                "Processo excedeu o tempo limite."
              )
            );
          },
          options.timeout ||
            300000
        );

      child.on(
        "error",
        (error) => {
          clearTimeout(
            timeout
          );

          reject(error);
        }
      );

      child.on(
        "close",
        (code) => {
          clearTimeout(
            timeout
          );

          resolve({
            code,
            stdout,
            stderr,
          });
        }
      );
    }
  );
}

/* ============================================================
   FFPROBE
   ============================================================ */

async function probeVideo(
  inputPath
) {
  const result =
    await runCommand(
      FFPROBE_PATH,
      [
        "-v",
        "error",

        "-show_entries",
        "format=duration",

        "-of",
        "default=noprint_wrappers=1:nokey=1",

        inputPath,
      ],
      {
        timeout: 60000,
      }
    );

  if (
    result.code !== 0
  ) {
    return {
      duration: null,
    };
  }

  const duration =
    Number(
      result.stdout.trim()
    );

  return {
    duration:
      Number.isFinite(
        duration
      )
        ? duration
        : null,
  };
}

/* ============================================================
   FFMPEG
   ============================================================ */

async function renderClip({
  inputPath,
  outputPath,
  start,
  duration,
}) {
  const safeStart =
    Math.max(
      0,
      Number(start) || 0
    );

  const safeDuration =
    Math.max(
      1,
      Number(duration) || 1
    );

  const result =
    await runCommand(
      FFMPEG_PATH,
      [
        "-y",

        "-ss",
        safeStart.toFixed(3),

        "-i",
        inputPath,

        "-t",
        safeDuration.toFixed(3),

        "-map",
        "0:v:0",

        "-map",
        "0:a:0?",

        "-c:v",
        "libx264",

        "-preset",
        "veryfast",

        "-crf",
        "23",

        "-pix_fmt",
        "yuv420p",

        "-c:a",
        "aac",

        "-b:a",
        "128k",

        "-ar",
        "44100",

        "-movflags",
        "+faststart",

        "-avoid_negative_ts",
        "make_zero",

        outputPath,
      ],
      {
        timeout: 300000,
      }
    );

  if (
    result.code !== 0
  ) {
    throw new Error(
      `FFmpeg falhou: ${result.stderr.slice(-1500)}`
    );
  }

  const stat =
    await fsp.stat(
      outputPath
    );

  if (
    stat.size < 10000
  ) {
    throw new Error(
      "FFmpeg finalizou, mas gerou um arquivo corrompido ou vazio."
    );
  }

  return outputPath;
}

/* ============================================================
   DOWNLOAD EXTERNO
   ============================================================ */

async function downloadWithExternalService({
  youtubeUrl,
  videoId,
  outputPath,
}) {
  if (
    !EXTERNAL_DOWNLOAD_URL
  ) {
    throw new Error(
      "Downloader externo não configurado."
    );
  }

  metrics.externalDownloadAttempts++;

  const response =
    await fetch(
      EXTERNAL_DOWNLOAD_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Accept:
            "application/json, video/mp4, video/*",

          ...(EXTERNAL_DOWNLOAD_TOKEN
            ? {
                Authorization:
                  `Bearer ${EXTERNAL_DOWNLOAD_TOKEN}`,
              }
            : {}),
        },

        body:
          JSON.stringify({
            url: youtubeUrl,
            videoId,
            output: "mp4",
          }),

        signal:
          AbortSignal.timeout(
            180000
          ),
      }
    );

  if (
    !response.ok
  ) {
    throw new Error(
      `Downloader externo HTTP ${response.status}`
    );
  }

  const contentType =
    (
      response.headers.get(
        "content-type"
      ) || ""
    ).toLowerCase();

  if (
    contentType.includes(
      "video/"
    ) ||
    contentType.includes(
      "application/octet-stream"
    )
  ) {
    if (!response.body) {
      throw new Error(
        "Downloader externo retornou resposta sem corpo."
      );
    }

    await pipeline(
      Readable.fromWeb(
        response.body
      ),
      fs.createWriteStream(
        outputPath
      )
    );

    return outputPath;
  }

  const data =
    await response.json();

  const downloadUrl =
    data.url ||
    data.downloadUrl ||
    data.result?.url;

  if (!downloadUrl) {
    throw new Error(
      "Downloader externo não retornou URL de download."
    );
  }

  const downloadResponse =
    await fetch(
      downloadUrl,
      {
        signal:
          AbortSignal.timeout(
            180000
          ),
      }
    );

  if (
    !downloadResponse.ok
  ) {
    throw new Error(
      `Stream externo HTTP ${downloadResponse.status}`
    );
  }

  if (!downloadResponse.body) {
    throw new Error(
      "Stream externo retornou resposta sem corpo."
    );
  }

  await pipeline(
    Readable.fromWeb(
      downloadResponse.body
    ),
    fs.createWriteStream(
      outputPath
    )
  );

  return outputPath;
}

/* ============================================================
   RAPIDAPI
   ============================================================ */

async function downloadWithRapidApi({
  videoId,
  outputPath,
}) {
  if (!RAPIDAPI_KEY) {
    throw new Error(
      "RapidAPI não configurada."
    );
  }

  metrics.rapidApiAttempts++;

  const endpoint =
    `https://${RAPIDAPI_HOST}/dl?id=${encodeURIComponent(videoId)}&cgeo=BR`;

  const response =
    await fetch(
      endpoint,
      {
        method: "GET",

        headers: {
          "x-rapidapi-key":
            RAPIDAPI_KEY,

          "x-rapidapi-host":
            RAPIDAPI_HOST,
        },

        signal:
          AbortSignal.timeout(
            60000
          ),
      }
    );

  if (
    !response.ok
  ) {
    throw new Error(
      `RapidAPI HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  let targetUrl = null;

  const findUrl =
    (object) => {
      if (
        !object ||
        typeof object !==
          "object" ||
        targetUrl
      ) {
        return;
      }

      if (
        typeof object.url ===
          "string" &&
        object.url.startsWith(
          "http"
        ) &&
        object.hasAudio !==
          false
      ) {
        targetUrl =
          object.url;

        return;
      }

      for (
        const key of
          Object.keys(object)
      ) {
        findUrl(
          object[key]
        );

        if (targetUrl) {
          return;
        }
      }
    };

  findUrl(data);

  if (!targetUrl) {
    throw new Error(
      "RapidAPI não forneceu uma URL de mídia acessível."
    );
  }

  const streamResponse =
    await fetch(
      targetUrl,
      {
        signal:
          AbortSignal.timeout(
            120000
          ),
      }
    );

  if (
    !streamResponse.ok
  ) {
    throw new Error(
      `Stream RapidAPI HTTP ${streamResponse.status}`
    );
  }

  if (!streamResponse.body) {
    throw new Error(
      "Stream RapidAPI sem corpo."
    );
  }

  await pipeline(
    Readable.fromWeb(
      streamResponse.body
    ),
    fs.createWriteStream(
      outputPath
    )
  );

  return outputPath;
}

/* ============================================================
   YT-DLP
   ============================================================ */

async function downloadWithYtDlp({
  youtubeUrl,
  outputPath,
}) {
  metrics.ytdlpAttempts++;

  if (
    !fs.existsSync(
      YTDLP_PATH
    )
  ) {
    throw new Error(
      `yt-dlp não encontrado em ${YTDLP_PATH}`
    );
  }

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--restrict-filenames",

    "-f",
    "bv*+ba/b",

    "--merge-output-format",
    "mp4",

    "-o",
    outputPath,

    youtubeUrl,
  ];

  if (
    YTDLP_COOKIES_FILE &&
    fs.existsSync(
      YTDLP_COOKIES_FILE
    )
  ) {
    args.splice(
      1,
      0,
      "--cookies",
      YTDLP_COOKIES_FILE
    );
  }

  const result =
    await runCommand(
      YTDLP_PATH,
      args,
      {
        timeout: 300000,
      }
    );

  if (
    result.code !== 0
  ) {
    if (
      /sign in to confirm|not a bot|login_required/i.test(
        result.stderr
      )
    ) {
      throw new Error(
        "Bloqueio anti-bot do YouTube detectado no servidor."
      );
    }

    if (
      /\b403\b/.test(
        result.stderr
      )
    ) {
      throw new Error(
        "O YouTube retornou HTTP 403 ao yt-dlp."
      );
    }

    throw new Error(
      `yt-dlp código ${result.code}: ${result.stderr.slice(-1000)}`
    );
  }

  if (
    !fs.existsSync(
      outputPath
    )
  ) {
    throw new Error(
      "yt-dlp terminou sem gerar o arquivo MP4."
    );
  }

  const stat =
    await fsp.stat(
      outputPath
    );

  if (
    stat.size < 10000
  ) {
    throw new Error(
      "yt-dlp gerou arquivo vazio ou inválido."
    );
  }

  return outputPath;
}

/* ============================================================
   PIPELINE COMPLETO DE DOWNLOAD
   ============================================================ */

async function downloadOriginalVideo({
  youtubeUrl,
  videoId,
}) {
  const outputPath =
    path.join(
      DOWNLOAD_DIR,
      `${videoId}-${Date.now()}.mp4`
    );

  /*
   * 1. Downloader externo
   */

  if (
    EXTERNAL_DOWNLOAD_URL
  ) {
    try {
      await downloadWithExternalService({
        youtubeUrl,
        videoId,
        outputPath,
      });

      return {
        path: outputPath,
        method: "external",
      };
    } catch (error) {
      console.log(
        `[Download] Downloader externo falhou: ${error.message}`
      );

      await safeRemove(
        outputPath
      );
    }
  }

  /*
   * 2. RapidAPI
   */

  if (RAPIDAPI_KEY) {
    try {
      await downloadWithRapidApi({
        videoId,
        outputPath,
      });

      return {
        path: outputPath,
        method: "rapidapi",
      };
    } catch (error) {
      console.log(
        `[Download] RapidAPI falhou: ${error.message}`
      );

      await safeRemove(
        outputPath
      );
    }
  }

  /*
   * 3. yt-dlp
   */

  try {
    await downloadWithYtDlp({
      youtubeUrl,
      outputPath,
    });

    return {
      path: outputPath,
      method: "yt-dlp",
    };
  } catch (error) {
    await safeRemove(
      outputPath
    );

    throw new Error(
      `Todos os métodos de download falharam. ${error.message}`
    );
  }
}

/* ============================================================
   ROTA PRINCIPAL
   ============================================================ */

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,

      name:
        "ClipForge Pro API",

      version:
        APP_VERSION,

      status:
        "online",

      timestamp:
        new Date().toISOString(),
    });
  }
);

/* ============================================================
   STATUS
   ============================================================ */

app.get(
  "/api/status",
  (req, res) => {
    res.json({
      ok: true,

      service:
        "ClipForge Pro",

      version:
        APP_VERSION,

      node:
        process.version,

      gemini: {
        configured:
          Boolean(
            GEMINI_API_KEY
          ),

        model:
          GEMINI_MODEL,

        endpoint:
          GEMINI_ENDPOINT,

        api:
          "Interactions API",
      },

      downloaders: {
        external:
          Boolean(
            EXTERNAL_DOWNLOAD_URL
          ),

        rapidapi:
          Boolean(
            RAPIDAPI_KEY
          ),

        ytdlp:
          fs.existsSync(
            YTDLP_PATH
          ),
      },

      metrics,
    });
  }
);

/* ============================================================
   LOGIN
   ============================================================ */

app.post(
  "/api/auth/login",
  (req, res) => {
    const userId =
      safeString(
        req.body?.userId ||
        randomId("user_")
      );

    const user =
      getOrCreateUser(
        userId
      );

    const token =
      createSession(
        user.id
      );

    res.json({
      ok: true,

      token,

      user: {
        id:
          user.id,

        vip:
          user.vip,

        points:
          user.points,

        analyses:
          user.analyses,

        downloads:
          user.downloads,
      },
    });
  }
);

/* ============================================================
   ME
   ============================================================ */

app.get(
  "/api/auth/me",
  requireUser,
  (req, res) => {
    res.json({
      ok: true,
      user:
        req.user,
    });
  }
);

/* ============================================================
   ANALISAR
   ============================================================ */

app.post(
  "/api/analisar",
  async (req, res) => {
    metrics.analyses++;

    const user =
      resolveRequestUser(req) ||
      getOrCreateUser(
        randomId("user_")
      );

    const rawUrl =
      req.body?.url ||
      req.body?.youtubeUrl ||
      req.body?.videoUrl;

    const normalized =
      normalizeYouTubeUrl(
        rawUrl
      );

    if (!normalized) {
      metrics.analysisFailures++;

      return res.status(400).json({
        ok: false,

        error:
          "URL do YouTube inválida.",

        code:
          "INVALID_YOUTUBE_URL",
      });
    }

    const maxClips =
      clampNumber(
        req.body?.maxClips,
        1,
        10,
        5
      );

    let minDuration =
      clampNumber(
        req.body?.minDuration,
        10,
        120,
        20
      );

    let maxDuration =
      clampNumber(
        req.body?.maxDuration,
        20,
        180,
        60
      );

    if (
      maxDuration <
      minDuration
    ) {
      const temp =
        minDuration;

      minDuration =
        maxDuration;

      maxDuration =
        temp;
    }

    console.log(
      `[Análise] CLIPFORGE ${APP_VERSION}`
    );

    console.log(
      `[Análise] Usuário: ${user.id}`
    );

    console.log(
      `[Análise] Vídeo: ${normalized.videoId}`
    );

    try {
      const result =
        await analisarComGemini({
          youtubeUrl:
            normalized.url,

          videoId:
            normalized.videoId,

          maxClips,

          minDuration,

          maxDuration,
        });

      user.analyses++;

      user.lastAnalysisAt =
        new Date().toISOString();

      metrics.analysisSuccess++;

      return res.json({
        ok: true,

        version:
          APP_VERSION,

        video: {
          id:
            normalized.videoId,

          url:
            normalized.url,
        },

        title:
          result.title,

        summary:
          result.summary,

        clips:
          result.clips,

        count:
          result.clips.length,

        user: {
          id:
            user.id,

          vip:
            user.vip,

          points:
            user.points,
        },
      });
    } catch (error) {
      metrics.analysisFailures++;

      console.error(
        `[Análise] Erro: ${error.message}`
      );

      return res.status(500).json({
        ok: false,

        error:
          error.message ||
          "Não foi possível analisar o vídeo.",

        code:
          "ANALYSIS_FAILED",

        version:
          APP_VERSION,
      });
    }
  }
);

/* ============================================================
   DOWNLOAD / RENDER
   ============================================================ */

app.post(
  "/api/download",
  async (req, res) => {
    metrics.downloads++;

    const user =
      resolveRequestUser(req) ||
      getOrCreateUser(
        randomId("user_")
      );

    const rawUrl =
      req.body?.url ||
      req.body?.youtubeUrl ||
      req.body?.videoUrl;

    const normalized =
      normalizeYouTubeUrl(
        rawUrl
      );

    if (!normalized) {
      metrics.downloadFailures++;

      return res.status(400).json({
        ok: false,

        error:
          "URL do YouTube inválida.",
      });
    }

    const start =
      clampNumber(
        req.body?.start ??
        req.body?.inicio,

        0,
        86400,
        0
      );

    const duration =
      clampNumber(
        req.body?.duration ??
        req.body?.duracao,

        1,
        180,
        60
      );

    let original =
      null;

    let clipPath =
      null;

    try {
      original =
        await downloadOriginalVideo({
          youtubeUrl:
            normalized.url,

          videoId:
            normalized.videoId,
        });

      console.log(
        `[Download] Método: ${original.method}`
      );

      const probe =
        await probeVideo(
          original.path
        );

      let actualDuration =
        duration;

      if (
        Number.isFinite(
          probe.duration
        )
      ) {
        if (
          start >=
          probe.duration
        ) {
          throw new Error(
            "O tempo inicial solicitado está além da duração total do vídeo."
          );
        }

        actualDuration =
          Math.min(
            actualDuration,
            probe.duration -
              start
          );
      }

      const filename =
        `clip-${normalized.videoId}-${Date.now()}.mp4`;

      clipPath =
        path.join(
          OUTPUT_DIR,
          filename
        );

      await renderClip({
        inputPath:
          original.path,

        outputPath:
          clipPath,

        start,

        duration:
          actualDuration,
      });

      user.downloads++;

      user.lastDownloadAt =
        new Date().toISOString();

      metrics.downloadSuccess++;

      return res.download(
        clipPath,
        filename,
        async (error) => {
          await safeRemove(
            clipPath
          );

          if (original) {
            await safeRemove(
              original.path
            );
          }

          if (error) {
            console.error(
              "[Download] Erro no envio:",
              error.message
            );
          }
        }
      );
    } catch (error) {
      metrics.downloadFailures++;

      await safeRemove(
        clipPath
      );

      if (original) {
        await safeRemove(
          original.path
        );
      }

      console.error(
        `[Download] Erro: ${error.message}`
      );

      return res.status(500).json({
        ok: false,

        error:
          error.message ||
          "Falha ao renderizar o corte.",

        code:
          "DOWNLOAD_FAILED",

        version:
          APP_VERSION,
      });
    }
  }
);

/* ============================================================
   MERCADO PAGO - CRIAR PIX
   ============================================================ */

app.post(
  "/api/pix/criar",
  async (req, res) => {
    const user =
      resolveRequestUser(req) ||
      getOrCreateUser(
        randomId("user_")
      );

    if (!MP_ACCESS_TOKEN) {
      return res.status(503).json({
        ok: false,

        error:
          "Mercado Pago não configurado.",
      });
    }

    const amount =
      Number(
        req.body?.amount ??
        req.body?.valor ??
        19.90
      );

    if (
      !Number.isFinite(
        amount
      ) ||
      amount <= 0
    ) {
      return res.status(400).json({
        ok: false,

        error:
          "Valor inválido.",
      });
    }

    try {
      const externalReference =
        `clipforge-${user.id}-${randomId()}`;

      /*
       * CORRIGIDO:
       * URL original estava quebrada.
       */

      const mpRes =
        await fetch(
          "https://api.mercadopago.com/v1/payments",
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${MP_ACCESS_TOKEN}`,

              "Content-Type":
                "application/json",

              "X-Idempotency-Key":
                randomId("mp_"),
            },

            body:
              JSON.stringify({
                transaction_amount:
                  Number(
                    amount.toFixed(
                      2
                    )
                  ),

                description:
                  "ClipForge Pro VIP",

                payment_method_id:
                  "pix",

                external_reference:
                  externalReference,

                payer: {
                  email:
                    `user-${user.id}@clipforge.local`,
                },
              }),
          }
        );

      const data =
        await mpRes.json();

      if (!mpRes.ok) {
        throw new Error(
          data.message ||
          "Erro Mercado Pago."
        );
      }

      const transactionData =
        data
          .point_of_interaction
          ?.transaction_data ||
        {};

      const paymentId =
        String(
          data.id
        );

      payments.set(
        paymentId,
        {
          id:
            paymentId,

          userId:
            user.id,

          status:
            data.status,

          externalReference,
        }
      );

      metrics.pixCreated++;

      return res.json({
        ok: true,

        id:
          paymentId,

        paymentId,

        status:
          data.status,

        qr_code:
          transactionData.qr_code,

        qrCode:
          transactionData.qr_code,

        qr_code_base64:
          transactionData.qr_code_base64,

        qrCodeBase64:
          transactionData.qr_code_base64,

        ticket_url:
          transactionData.ticket_url,

        ticketUrl:
          transactionData.ticket_url,
      });
    } catch (error) {
      metrics.pixRejected++;

      console.error(
        `[Mercado Pago] ${error.message}`
      );

      return res.status(500).json({
        ok: false,

        error:
          error.message ||
          "Erro ao criar pagamento PIX.",
      });
    }
  }
);

/* ============================================================
   MERCADO PAGO - STATUS
   ============================================================ */

app.get(
  "/api/pix/status/:id",
  async (req, res) => {
    if (!MP_ACCESS_TOKEN) {
      return res.status(503).json({
        ok: false,

        error:
          "Mercado Pago não configurado.",
      });
    }

    const paymentId =
      encodeURIComponent(
        req.params.id
      );

    try {
      /*
       * CORRIGIDO:
       * URL original estava quebrada.
       */

      const response =
        await fetch(
          `https://api.mercadopago.com/v1/payments/${paymentId}`,
          {
            headers: {
              Authorization:
                `Bearer ${MP_ACCESS_TOKEN}`,
            },
          }
        );

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.message ||
          `Mercado Pago HTTP ${response.status}`
        );
      }

      if (
        data.status ===
        "approved"
      ) {
        const payment =
          payments.get(
            String(
              req.params.id
            )
          );

        if (
          payment?.userId
        ) {
          const user =
            users.get(
              payment.userId
            );

          if (user) {
            if (!user.vip) {
              metrics.pixApproved++;
            }

            user.vip = true;
          }
        }
      }

      return res.json({
        ok: true,

        id:
          data.id,

        status:
          data.status,

        approved:
          data.status ===
          "approved",
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,

        error:
          error.message ||
          "Erro ao consultar pagamento.",
      });
    }
  }
);

/* ============================================================
   ADMIN LOGIN
   ============================================================ */

app.post(
  "/api/admin/login",
  (req, res) => {
    if (!ADMIN_PASSWORD) {
      return res.status(503).json({
        ok: false,

        error:
          "ADMIN_PASSWORD não definida.",
      });
    }

    const {
      username,
      password,
    } =
      req.body || {};

    if (
      username !==
        ADMIN_USER ||
      password !==
        ADMIN_PASSWORD
    ) {
      return res.status(401).json({
        ok: false,

        error:
          "Credenciais inválidas.",
      });
    }

    const token =
      createAdminSession();

    return res.json({
      ok: true,

      token,

      user:
        ADMIN_USER,
    });
  }
);

/* ============================================================
   ADMIN DASHBOARD
   ============================================================ */

app.get(
  "/api/admin/dashboard",
  requireAdmin,
  (req, res) => {
    res.json({
      ok: true,

      version:
        APP_VERSION,

      server: {
        uptime:
          process.uptime(),

        node:
          process.version,

        platform:
          process.platform,

        memory:
          process.memoryUsage(),
      },

      metrics,

      usersCount:
        users.size,

      sessionsCount:
        sessions.size,

      paymentsCount:
        payments.size,
    });
  }
);

/* ============================================================
   404
   ============================================================ */

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,

      error:
        "Rota não encontrada.",

      path:
        req.originalUrl,
    });
  }
);

/* ============================================================
   ERRO GLOBAL
   ============================================================ */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    metrics.errors++;

    console.error(
      "[Global Error]",
      error
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    res.status(500).json({
      ok: false,

      error:
        error.message ||
        "Erro interno do servidor.",
    });
  }
);

/* ============================================================
   START
   ============================================================ */

async function startServer() {
  await ensureDirectories();

  await cleanupOldFiles();

  setInterval(
    () => {
      cleanupOldFiles()
        .catch(
          () => {}
        );
    },
    30 * 60 * 1000
  );

  app.listen(
    PORT,
    HOST,
    () => {
      console.log("");

      console.log(
        "===================================================="
      );

      console.log(
        `CLIPFORGE PRO ${APP_VERSION}`
      );

      console.log(
        "===================================================="
      );

      console.log(
        `Server: http://${HOST}:${PORT}`
      );

      console.log(
        `Node: ${process.version}`
      );

      console.log(
        `Environment: ${NODE_ENV}`
      );

      console.log(
        `Gemini: ${
          GEMINI_API_KEY
            ? "CONFIGURADO"
            : "NÃO CONFIGURADO"
        }`
      );

      console.log(
        `Gemini Model: ${GEMINI_MODEL}`
      );

      console.log(
        `Gemini Endpoint: ${GEMINI_ENDPOINT}`
      );

      console.log(
        "Gemini API: Interactions API"
      );

      console.log(
        `RapidAPI: ${
          RAPIDAPI_KEY
            ? "CONFIGURADO"
            : "NÃO CONFIGURADO"
        }`
      );

      console.log(
        `yt-dlp: ${
          fs.existsSync(
            YTDLP_PATH
          )
            ? YTDLP_PATH
            : "NÃO ENCONTRADO"
        }`
      );

      console.log(
        `FFmpeg: ${FFMPEG_PATH}`
      );

      console.log(
        `FFprobe: ${FFPROBE_PATH}`
      );

      console.log(
        `Downloader externo: ${
          EXTERNAL_DOWNLOAD_URL
            ? "CONFIGURADO"
            : "NÃO CONFIGURADO"
        }`
      );

      console.log(
        `Mercado Pago: ${
          MP_ACCESS_TOKEN
            ? "CONFIGURADO"
            : "NÃO CONFIGURADO"
        }`
      );

      console.log(
        "===================================================="
      );

      console.log("");
    }
  );
}

startServer()
  .catch(
    (error) => {
      console.error(
        "[FATAL] Erro ao iniciar servidor:",
        error
      );

      process.exit(1);
    }
  );