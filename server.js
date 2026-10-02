/**
 * ============================================================
 * CLIPFORGE PRO - BACKEND 12.9.0
 * ============================================================
 *
 * NOVO:
 * - Gemini 3.8 Flash real
 * - Gemini recebe URL pública do YouTube diretamente
 * - IA analisa vídeo + áudio
 * - IA retorna timestamps em JSON estruturado
 * - Seleção inteligente dos melhores momentos
 * - Mantém /api/analisar compatível com frontend atual
 * - Download continua usando YT-API + FFmpeg + yt-dlp
 * - Fallback seguro quando uma fonte não funciona
 * - Admin protegido por senha
 * - Dashboard
 * - Mercado Pago PIX
 *
 * IMPORTANTE:
 * O Gemini analisa o vídeo do YouTube diretamente.
 * Isso NÃO significa que o servidor possa necessariamente
 * baixar o vídeo para renderizar o MP4.
 *
 * Para baixar/renderizar, a fonte precisa permitir acesso
 * normal ao conteúdo.
 * ============================================================
 */

"use strict";

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();

const PORT = Number(process.env.PORT || 10000);

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "";
const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST || "yt-api.p.rapidapi.com";

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

const YTDLP_PATH =
  process.env.YTDLP_PATH ||
  path.join(__dirname, "bin", "yt-dlp");

const TEMP_DIR =
  process.env.TEMP_DIR ||
  path.join(os.tmpdir(), "clipforge");

const DOWNLOAD_TIMEOUT =
  Number(process.env.DOWNLOAD_TIMEOUT || 120000);

const MAX_CLIPS =
  Number(process.env.MAX_CLIPS || 5);

const DEFAULT_CLIP_DURATION =
  Number(process.env.DEFAULT_CLIP_DURATION || 55);

const MIN_CLIP_DURATION =
  Number(process.env.MIN_CLIP_DURATION || 20);

const MAX_CLIP_DURATION =
  Number(process.env.MAX_CLIP_DURATION || 60);


/* ============================================================
   APP
   ============================================================ */

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization"
    ]
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));


/* ============================================================
   DIRETÓRIOS
   ============================================================ */

try {
  fs.mkdirSync(TEMP_DIR, {
    recursive: true
  });
} catch (err) {
  console.error(
    "[TEMP] Erro criando diretório:",
    err.message
  );
}


/* ============================================================
   MÉTRICAS
   ============================================================ */

const metrics = {
  downloads: 0,
  analyses: 0,
  geminiAnalyses: 0,
  failedAnalyses: 0,
  pixCreated: 0,
  pixApproved: 0,
  revenue: 0
};


/* ============================================================
   HELPERS
   ============================================================ */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


function safeNumber(value, fallback = 0) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return number;
}


function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}


function extractYouTubeId(input) {
  if (!input) return null;

  const value = String(input).trim();

  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) {
    return value;
  }

  try {
    const url = new URL(value);

    if (
      url.hostname.includes("youtube.com") ||
      url.hostname.includes("youtu.be") ||
      url.hostname.includes("youtube-nocookie.com")
    ) {
      if (
        url.hostname === "youtu.be" ||
        url.hostname.endsWith("youtu.be")
      ) {
        const id = url.pathname
          .replace(/^\/+/, "")
          .split("/")[0];

        if (id) {
          return id.substring(0, 11);
        }
      }

      const queryId = url.searchParams.get("v");

      if (queryId) {
        return queryId.substring(0, 11);
      }

      const pathParts = url.pathname
        .split("/")
        .filter(Boolean);

      const possibleIndex =
        pathParts.indexOf("shorts") >= 0
          ? pathParts.indexOf("shorts") + 1
          : pathParts.indexOf("embed") >= 0
            ? pathParts.indexOf("embed") + 1
            : -1;

      if (
        possibleIndex >= 0 &&
        pathParts[possibleIndex]
      ) {
        return pathParts[possibleIndex]
          .substring(0, 11);
      }
    }
  } catch (_) {
    return null;
  }

  return null;
}


function buildYouTubeUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}


function authFromRequest(req) {
  const auth =
    req.headers.authorization || "";

  if (!auth) {
    return "";
  }

  return auth
    .replace(/^Bearer\s+/i, "")
    .trim();
}


function isAdmin(req) {
  if (!ADMIN_PASSWORD) {
    return false;
  }

  const token = authFromRequest(req);

  return token === ADMIN_PASSWORD;
}


/* ============================================================
   STATUS
   ============================================================ */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "ClipForge Pro Backend",
    version: "12.9.0",
    status: "online",
    gemini: Boolean(GEMINI_API_KEY),
    geminiModel: GEMINI_MODEL,
    youtubeAIAnalysis: Boolean(GEMINI_API_KEY),
    timestamp: new Date().toISOString()
  });
});


app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    version: "12.9.0",

    services: {
      gemini: Boolean(GEMINI_API_KEY),
      rapidapi: Boolean(RAPIDAPI_KEY),
      mercadoPago: Boolean(MP_ACCESS_TOKEN),
      admin: Boolean(ADMIN_PASSWORD),
      ytDlp: fs.existsSync(YTDLP_PATH)
    },

    metrics
  });
});


/* ============================================================
   GEMINI
   ============================================================ */

async function analisarComGemini({
  youtubeUrl,
  videoId,
  quantity,
  targetDuration
}) {

  if (!GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY não configurada no servidor."
    );
  }

  const quantidade = clamp(
    safeNumber(quantity, 3),
    1,
    MAX_CLIPS
  );

  const duracaoAlvo = clamp(
    safeNumber(
      targetDuration,
      DEFAULT_CLIP_DURATION
    ),
    MIN_CLIP_DURATION,
    MAX_CLIP_DURATION
  );

  const schema = {
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

            title: {
              type: "string"
            },

            reason: {
              type: "string"
            },

            score: {
              type: "number"
            }
          },

          required: [
            "start",
            "end",
            "title",
            "reason",
            "score"
          ]
        }
      }
    },

    required: [
      "clips"
    ]
  };


  const prompt = `
Você é o motor de seleção de cortes do ClipForge Pro.

Analise cuidadosamente o vídeo inteiro, incluindo:

- imagem
- áudio
- falas
- mudanças de cena
- momentos de surpresa
- humor
- emoção
- conflitos
- revelações
- frases fortes
- perguntas e respostas
- momentos que prendem atenção
- momentos com potencial para Shorts/Reels/TikTok

OBJETIVO:

Encontrar ${quantidade} dos melhores momentos do vídeo
para transformar em Shorts verticais.

Cada corte deve ter aproximadamente
${duracaoAlvo} segundos.

IMPORTANTE:

1. Retorne timestamps em segundos.
2. "start" deve ser o começo do corte.
3. "end" deve ser o final do corte.
4. Evite começar no meio de uma frase.
5. Evite terminar no meio de uma frase.
6. Prefira cortes que tenham começo, desenvolvimento
   e conclusão.
7. Evite longos períodos de silêncio.
8. Evite trechos sem contexto.
9. Dê prioridade a momentos que funcionem
   mesmo quando vistos isoladamente.
10. Não invente acontecimentos.
11. O score deve ser de 0 a 100.
12. Ordene os cortes do maior potencial para o menor.
13. Não ultrapasse ${MAX_CLIPS} cortes.
14. Não use timestamps negativos.
15. Não use timestamps fora do vídeo.

A resposta deve conter SOMENTE o JSON solicitado.
`;


  const body = {
    model: GEMINI_MODEL,

    input: [
      {
        type: "text",
        text: prompt
      },

      {
        type: "video",
        uri: youtubeUrl
      }
    ],

    response_format: {
      type: "text",
      mime_type: "application/json",
      schema
    }
  };


  console.log(
    "[Gemini] Enviando vídeo do YouTube para análise..."
  );

  console.log(
    "[Gemini] Modelo:",
    GEMINI_MODEL
  );

  console.log(
    "[Gemini] Vídeo:",
    videoId
  );


  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },

      body: JSON.stringify(body)
    }
  );


  const rawText = await response.text();


  let data;

  try {
    data = JSON.parse(rawText);
  } catch (_) {
    data = {
      raw: rawText
    };
  }


  if (!response.ok) {
    console.error(
      "[Gemini] HTTP:",
      response.status
    );

    console.error(
      "[Gemini] Resposta:",
      rawText.substring(0, 3000)
    );

    throw new Error(
      `Gemini HTTP ${response.status}: ${
        data?.error?.message ||
        rawText.substring(0, 500)
      }`
    );
  }


  let outputText =
    data.output_text ||
    data.outputText ||
    "";


  /*
   * Algumas respostas podem trazer o texto
   * dentro das etapas da interação.
   */

  if (!outputText && Array.isArray(data.steps)) {

    const textParts = [];

    for (const step of data.steps) {

      if (
        step &&
        Array.isArray(step.content)
      ) {

        for (const content of step.content) {

          if (
            content &&
            typeof content.text === "string"
          ) {
            textParts.push(content.text);
          }
        }
      }
    }

    outputText = textParts.join("");
  }


  if (!outputText) {
    console.error(
      "[Gemini] Não encontrou output_text."
    );

    console.error(
      JSON.stringify(data).substring(0, 5000)
    );

    throw new Error(
      "Gemini não retornou o JSON dos cortes."
    );
  }


  console.log(
    "[Gemini] Resposta recebida."
  );


  let result;

  try {

    result = JSON.parse(outputText);

  } catch (error) {

    /*
     * Fallback para caso o modelo tenha colocado
     * markdown em volta do JSON.
     */

    const cleaned =
      outputText
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

    try {
      result = JSON.parse(cleaned);
    } catch (_) {
      console.error(
        "[Gemini] JSON inválido:",
        outputText.substring(0, 3000)
      );

      throw new Error(
        "Gemini retornou uma resposta que não pôde ser convertida em JSON."
      );
    }
  }


  if (
    !result ||
    !Array.isArray(result.clips)
  ) {
    throw new Error(
      "Gemini não retornou uma lista válida de clips."
    );
  }


  const clips = result.clips
    .map((clip, index) => {

      const start = Math.max(
        0,
        safeNumber(clip.start, 0)
      );

      const end = Math.max(
        start + MIN_CLIP_DURATION,
        safeNumber(
          clip.end,
          start + duracaoAlvo
        )
      );

      const duration = end - start;

      return {
        id: index + 1,

        inicio: Math.round(start),

        fim: Math.round(end),

        duracao: Math.round(duration),

        titulo:
          String(
            clip.title ||
            `Melhor momento #${index + 1}`
          ).substring(0, 150),

        motivo:
          String(
            clip.reason ||
            "Momento identificado pela IA."
          ).substring(0, 500),

        score: clamp(
          Math.round(
            safeNumber(
              clip.score,
              80
            )
          ),
          0,
          100
        ),

        ai: true,

        modelo: GEMINI_MODEL
      };
    })

    .filter(clip => {

      if (
        clip.duracao <
        MIN_CLIP_DURATION
      ) {
        return false;
      }

      if (
        clip.duracao >
        MAX_CLIP_DURATION + 15
      ) {
        return false;
      }

      return true;
    })

    .slice(0, quantidade);


  if (!clips.length) {
    throw new Error(
      "A IA não encontrou cortes válidos."
    );
  }


  console.log(
    `[Gemini] ${clips.length} cortes encontrados.`
  );


  for (const clip of clips) {

    console.log(
      `[Gemini] #${clip.id} ` +
      `${clip.inicio}s → ${clip.fim}s ` +
      `score=${clip.score}`
    );
  }


  metrics.geminiAnalyses++;

  return clips;
}


/* ============================================================
   FALLBACK DE ANÁLISE
   ============================================================ */

function gerarFallbackClips() {

  return [
    {
      id: 1,
      inicio: 35,
      fim: 90,
      duracao: 55,
      titulo: "Melhor momento",
      motivo: "Corte de fallback.",
      score: 90,
      ai: false
    },

    {
      id: 2,
      inicio: 145,
      fim: 200,
      duracao: 55,
      titulo: "Momento interessante",
      motivo: "Corte de fallback.",
      score: 85,
      ai: false
    },

    {
      id: 3,
      inicio: 290,
      fim: 345,
      duracao: 55,
      titulo: "Momento de destaque",
      motivo: "Corte de fallback.",
      score: 80,
      ai: false
    }
  ];
}


/* ============================================================
   ANALISAR
   ============================================================ */

app.post("/api/analisar", async (req, res) => {

  const youtubeUrl =
    String(
      req.body.youtubeUrl ||
      req.body.url ||
      ""
    ).trim();

  const requestedVideoId =
    String(
      req.body.videoId ||
      ""
    ).trim();

  const quantity =
    safeNumber(
      req.body.quantity,
      3
    );

  const duration =
    safeNumber(
      req.body.duration,
      DEFAULT_CLIP_DURATION
    );


  console.log("");
  console.log(
    "[Análise] =================================="
  );

  console.log(
    "[Análise] Entrada:",
    youtubeUrl || requestedVideoId
  );


  const videoId =
    extractYouTubeId(
      youtubeUrl
    ) ||
    extractYouTubeId(
      requestedVideoId
    );


  if (!videoId) {

    return res.status(400).json({
      ok: false,
      error:
        "Link do YouTube inválido."
    });
  }


  const finalYoutubeUrl =
    buildYouTubeUrl(videoId);


  metrics.analyses++;


  console.log(
    "[Análise] ID:",
    videoId
  );

  console.log(
    "[Análise] URL:",
    finalYoutubeUrl
  );

  console.log(
    "[Análise] Quantidade:",
    quantity
  );

  console.log(
    "[Análise] Duração:",
    duration
  );


  /*
   * GEMINI REAL
   */

  if (GEMINI_API_KEY) {

    try {

      const clips =
        await analisarComGemini({
          youtubeUrl: finalYoutubeUrl,
          videoId,
          quantity,
          targetDuration: duration
        });


      return res.json({

        ok: true,

        success: true,

        ai: true,

        modelo: GEMINI_MODEL,

        videoId,

        youtubeUrl: finalYoutubeUrl,

        clips,

        quantidade: clips.length,

        message:
          "Cortes encontrados pela IA Gemini."
      });

    } catch (error) {

      metrics.failedAnalyses++;

      console.error(
        "[Análise] Gemini falhou:",
        error.message
      );


      /*
       * NÃO escondemos erro do Gemini.
       *
       * Se a IA estiver configurada mas não conseguir
       * analisar o vídeo, avisamos o frontend.
       *
       * Isso evita mostrar cortes falsos como se fossem
       * resultados da IA.
       */

      return res.status(502).json({

        ok: false,

        success: false,

        ai: false,

        videoId,

        error:
          "A IA não conseguiu analisar este vídeo.",

        details:
          error.message,

        hint:
          "Verifique se o vídeo é público e se a GEMINI_API_KEY está válida."
      });
    }
  }


  /*
   * SEM GEMINI
   */

  console.warn(
    "[Análise] GEMINI_API_KEY não configurada."
  );


  const clips =
    gerarFallbackClips();


  return res.json({

    ok: true,

    success: true,

    ai: false,

    modelo: null,

    videoId,

    youtubeUrl: finalYoutubeUrl,

    clips,

    quantidade: clips.length,

    message:
      "Gemini não configurado. Foram usados cortes de fallback."
  });
});


/* ============================================================
   RAPIDAPI
   ============================================================ */

async function consultarYTAPI(videoId) {

  if (!RAPIDAPI_KEY) {

    throw new Error(
      "RAPIDAPI_KEY não configurada."
    );
  }


  const url =
    `https://${RAPIDAPI_HOST}/dl?id=${encodeURIComponent(
      videoId
    )}&cgeo=BR`;


  console.log(
    "[YT-API] Consultando",
    videoId
  );


  const response =
    await fetch(url, {

      method: "GET",

      headers: {
        "x-rapidapi-key":
          RAPIDAPI_KEY,

        "x-rapidapi-host":
          RAPIDAPI_HOST
      },

      signal:
        AbortSignal.timeout(
          30000
        )
    });


  const text =
    await response.text();


  let data;

  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error(
      "YT-API retornou resposta inválida."
    );
  }


  if (!response.ok) {

    throw new Error(
      `YT-API HTTP ${response.status}`
    );
  }


  const streams = [];


  function collect(value) {

    if (!value) return;


    if (Array.isArray(value)) {

      for (const item of value) {
        collect(item);
      }

      return;
    }


    if (
      typeof value !== "object"
    ) {
      return;
    }


    const urlCandidate =
      value.url ||
      value.link ||
      value.download_url ||
      value.downloadUrl;


    if (
      typeof urlCandidate === "string" &&
      /^https?:\/\//i.test(
        urlCandidate
      )
    ) {

      streams.push({
        url: urlCandidate,

        mime:
          value.mime ||
          value.mimeType ||
          value.type ||
          "",

        quality:
          value.quality ||
          value.qualityLabel ||
          value.resolution ||
          "",

        height:
          safeNumber(
            value.height,
            0
          ),

        width:
          safeNumber(
            value.width,
            0
          ),

        audio:
          Boolean(
            value.audio ||
            value.hasAudio
          )
      });
    }


    for (
      const key of Object.keys(value)
    ) {

      const child =
        value[key];


      if (
        child &&
        typeof child === "object"
      ) {
        collect(child);
      }
    }
  }


  collect(data);


  const unique = [];

  const seen =
    new Set();


  for (const stream of streams) {

    if (
      seen.has(stream.url)
    ) {
      continue;
    }

    seen.add(stream.url);

    unique.push(stream);
  }


  console.log(
    "[YT-API] URLs encontradas:",
    unique.length
  );


  return unique;
}


/* ============================================================
   TESTE DE STREAM
   ============================================================ */

async function testarStream(url) {

  try {

    const response =
      await fetch(url, {

        method: "GET",

        headers: {
          Range: "bytes=0-1023",
          "User-Agent":
            "Mozilla/5.0"
        },

        redirect: "follow",

        signal:
          AbortSignal.timeout(
            15000
          )
      });


    console.log(
      "[Download] Teste stream:",
      response.status
    );


    if (
      response.body &&
      typeof response.body.cancel ===
        "function"
    ) {
      try {
        await response.body.cancel();
      } catch (_) {}
    }


    return response.ok;
  } catch (error) {

    console.log(
      "[Download] Teste falhou:",
      error.message
    );

    return false;
  }
}


/* ============================================================
   FFPROBE
   ============================================================ */

function ffprobeDuration(filePath) {

  return new Promise(resolve => {

    const process =
      spawn(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          filePath
        ]
      );


    let output = "";


    process.stdout.on(
      "data",
      data => {
        output += data.toString();
      }
    );


    process.on(
      "close",
      () => {

        const value =
          Number(
            output.trim()
          );

        resolve(
          Number.isFinite(value)
            ? value
            : null
        );
      }
    );


    process.on(
      "error",
      () => {
        resolve(null);
      }
    );
  });
}


/* ============================================================
   DOWNLOAD COM URL DIRETA
   ============================================================ */

async function baixarStreamParaArquivo(
  streamUrl,
  outputPath
) {

  return new Promise(
    async (resolve, reject) => {

      try {

        const response =
          await fetch(
            streamUrl,
            {
              method: "GET",

              headers: {
                "User-Agent":
                  "Mozilla/5.0"
              },

              redirect: "follow",

              signal:
                AbortSignal.timeout(
                  DOWNLOAD_TIMEOUT
                )
            }
          );


        if (!response.ok) {

          reject(
            new Error(
              `Stream HTTP ${response.status}`
            )
          );

          return;
        }


        if (!response.body) {

          reject(
            new Error(
              "Stream sem body."
            )
          );

          return;
        }


        const fileStream =
          fs.createWriteStream(
            outputPath
          );


        const reader =
          response.body.getReader();


        try {

          while (true) {

            const {
              done,
              value
            } =
              await reader.read();


            if (done) {
              break;
            }


            if (value) {

              if (
                !fileStream.write(
                  Buffer.from(value)
                )
              ) {

                await new Promise(
                  resolveDrain => {
                    fileStream.once(
                      "drain",
                      resolveDrain
                    );
                  }
                );
              }
            }
          }


          fileStream.end();


          fileStream.on(
            "finish",
            () => resolve(outputPath)
          );


          fileStream.on(
            "error",
            reject
          );

        } catch (error) {

          fileStream.destroy();

          reject(error);
        }

      } catch (error) {

        reject(error);
      }
    }
  );
}


/* ============================================================
   EXECUTAR PROCESSO
   ============================================================ */

function executar(
  command,
  args,
  options = {}
) {

  return new Promise(
    (resolve, reject) => {

      console.log(
        "[Processo]",
        command,
        args.join(" ")
      );


      const child =
        spawn(
          command,
          args,
          {
            ...options
          }
        );


      let stdout = "";
      let stderr = "";


      child.stdout?.on(
        "data",
        data => {
          stdout += data.toString();
        }
      );


      child.stderr?.on(
        "data",
        data => {
          stderr += data.toString();
        }
      );


      child.on(
        "error",
        reject
      );


      child.on(
        "close",
        code => {

          resolve({
            code,
            stdout,
            stderr
          });
        }
      );
    }
  );
}


/* ============================================================
   YT-DLP
   ============================================================ */

async function baixarComYtDlp(
  videoId,
  outputPath
) {

  if (
    !fs.existsSync(
      YTDLP_PATH
    )
  ) {

    throw new Error(
      "yt-dlp não encontrado."
    );
  }


  console.log(
    "[YT-DLP] Fallback ativado."
  );

  console.log(
    "[YT-DLP] Executável:",
    YTDLP_PATH
  );


  const url =
    buildYouTubeUrl(
      videoId
    );


  const args = [

    "--no-playlist",

    "--no-warnings",

    "--newline",

    "-f",
    "bv*+ba/b",

    "--merge-output-format",
    "mp4",

    "-o",
    outputPath,

    url
  ];


  const result =
    await executar(
      YTDLP_PATH,
      args,
      {
        cwd:
          path.dirname(
            YTDLP_PATH
          )
      }
    );


  if (
    result.code !== 0
  ) {

    throw new Error(
      `yt-dlp terminou com código ${result.code}. ` +
      result.stderr.slice(-2000)
    );
  }


  if (
    !fs.existsSync(
      outputPath
    )
  ) {

    throw new Error(
      "yt-dlp terminou sem gerar o arquivo."
    );
  }


  return outputPath;
}


/* ============================================================
   CORTAR COM FFMPEG
   ============================================================ */

async function cortarVideo(
  inputPath,
  outputPath,
  start,
  duration
) {

  const safeStart =
    Math.max(
      0,
      Math.floor(
        safeNumber(
          start,
          0
        )
      )
    );


  const safeDuration =
    clamp(
      Math.floor(
        safeNumber(
          duration,
          DEFAULT_CLIP_DURATION
        )
      ),
      1,
      300
    );


  console.log(
    `[FFmpeg] Corte ${safeStart}s / ${safeDuration}s`
  );


  const args = [

    "-y",

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
    "23",

    "-c:a",
    "aac",

    "-b:a",
    "128k",

    "-movflags",
    "+faststart",

    outputPath
  ];


  const result =
    await executar(
      "ffmpeg",
      args
    );


  if (
    result.code !== 0
  ) {

    throw new Error(
      "FFmpeg falhou: " +
      result.stderr.slice(-3000)
    );
  }


  if (
    !fs.existsSync(
      outputPath
    )
  ) {

    throw new Error(
      "FFmpeg não gerou o arquivo."
    );
  }


  return outputPath;
}


/* ============================================================
   DOWNLOAD
   ============================================================ */

app.get("/api/download", async (req, res) => {

  const videoId =
    extractYouTubeId(
      req.query.id ||
      req.query.url ||
      ""
    );


  const start =
    Math.max(
      0,
      safeNumber(
        req.query.start,
        0
      )
    );


  const duration =
    clamp(
      safeNumber(
        req.query.duration,
        DEFAULT_CLIP_DURATION
      ),
      1,
      300
    );


  if (!videoId) {

    return res.status(400).json({
      ok: false,
      error:
        "ID ou URL do YouTube inválido."
    });
  }


  const jobId =
    crypto
      .randomBytes(8)
      .toString("hex");


  const originalPath =
    path.join(
      TEMP_DIR,
      `${jobId}-original.mp4`
    );


  const clipPath =
    path.join(
      TEMP_DIR,
      `${jobId}-short.mp4`
    );


  console.log("");
  console.log(
    "[Download] =================================="
  );

  console.log(
    "[Download] NOVO DOWNLOAD 12.9.0"
  );

  console.log(
    "[Download] ID:",
    videoId
  );

  console.log(
    "[Download] Início:",
    start,
    "s"
  );

  console.log(
    "[Download] Duração:",
    duration,
    "s"
  );


  try {

    let sourceDownloaded =
      false;


    /*
     * ========================================================
     * 1. TENTAR YT-API
     * ========================================================
     */

    if (RAPIDAPI_KEY) {

      try {

        console.log(
          "[Download] Consultando YT-API..."
        );


        const streams =
          await consultarYTAPI(
            videoId
          );


        console.log(
          `[Download] ${streams.length} streams encontradas.`
        );


        /*
         * Testamos algumas das melhores streams.
         */

        const candidates =
          streams
            .sort(
              (a, b) =>
                (b.height || 0) -
                (a.height || 0)
            )
            .slice(0, 12);


        for (
          const stream of candidates
        ) {

          if (
            !stream.url
          ) {
            continue;
          }


          const accessible =
            await testarStream(
              stream.url
            );


          if (!accessible) {
            continue;
          }


          console.log(
            "[Download] Stream acessível encontrada."
          );


          try {

            await baixarStreamParaArquivo(
              stream.url,
              originalPath
            );


            sourceDownloaded =
              fs.existsSync(
                originalPath
              );


            if (
              sourceDownloaded
            ) {
              break;
            }

          } catch (error) {

            console.log(
              "[Download] Falha baixando stream:",
              error.message
            );

            try {
              fs.unlinkSync(
                originalPath
              );
            } catch (_) {}
          }
        }

      } catch (error) {

        console.log(
          "[Download] YT-API falhou:",
          error.message
        );
      }
    }


    /*
     * ========================================================
     * 2. FALLBACK YT-DLP
     * ========================================================
     */

    if (!sourceDownloaded) {

      console.log(
        "[Download] Ativando fallback yt-dlp..."
      );


      try {

        await baixarComYtDlp(
          videoId,
          originalPath
        );


        sourceDownloaded =
          fs.existsSync(
            originalPath
          );

      } catch (error) {

        console.error(
          "[YT-DLP] Falhou:",
          error.message
        );
      }
    }


    /*
     * ========================================================
     * 3. SE NÃO CONSEGUIU OBTER O ARQUIVO
     * ========================================================
     */

    if (!sourceDownloaded) {

      return res.status(502).json({

        ok: false,

        error:
          "Não foi possível obter uma fonte de vídeo acessível para gerar o MP4.",

        reason:
          "O YouTube ou a fonte utilizada bloqueou o acesso ao arquivo.",

        ai:
          Boolean(GEMINI_API_KEY),

        message:
          "A IA pode analisar o vídeo, mas a renderização do MP4 depende de uma fonte de vídeo acessível ao servidor."
      });
    }


    /*
     * ========================================================
     * 4. FFMPEG
     * ========================================================
     */

    await cortarVideo(
      originalPath,
      clipPath,
      start,
      duration
    );


    metrics.downloads++;


    const filename =
      `clipforge-short-${videoId}-${start}s.mp4`;


    res.setHeader(
      "Content-Type",
      "video/mp4"
    );


    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );


    res.setHeader(
      "Cache-Control",
      "no-store"
    );


    const stream =
      fs.createReadStream(
        clipPath
      );


    stream.on(
      "error",
      error => {

        console.error(
          "[Download] Erro enviando arquivo:",
          error.message
        );

        if (
          !res.headersSent
        ) {
          res.status(500).json({
            ok: false,
            error:
              "Erro enviando o vídeo."
          });
        }
      }
    );


    stream.on(
      "close",
      () => {

        /*
         * Pequeno atraso para garantir que
         * o sistema terminou de liberar o arquivo.
         */

        setTimeout(
          () => {

            try {
              fs.unlinkSync(
                clipPath
              );
            } catch (_) {}


            try {
              fs.unlinkSync(
                originalPath
              );
            } catch (_) {}

          },
          3000
        );
      }
    );


    stream.pipe(res);

  } catch (error) {

    console.error(
      "[Download Error]",
      error.message
    );


    try {
      fs.unlinkSync(
        originalPath
      );
    } catch (_) {}


    try {
      fs.unlinkSync(
        clipPath
      );
    } catch (_) {}


    if (
      !res.headersSent
    ) {

      return res.status(500).json({

        ok: false,

        error:
          "Erro ao gerar o corte.",

        details:
          error.message
      });
    }
  }
});


/* ============================================================
   ADMIN LOGIN
   ============================================================ */

app.post(
  "/api/admin/login",
  (req, res) => {

    const password =
      String(
        req.body.password ||
        ""
      );


    if (
      !ADMIN_PASSWORD
    ) {

      return res.status(503).json({

        ok: false,

        error:
          "ADMIN_PASSWORD não configurada."
      });
    }


    if (
      password !== ADMIN_PASSWORD
    ) {

      return res.status(401).json({

        ok: false,

        error:
          "Senha administrativa inválida."
      });
    }


    return res.json({

      ok: true,

      authenticated: true,

      token: ADMIN_PASSWORD
    });
  }
);


/* ============================================================
   ADMIN DASHBOARD
   ============================================================ */

app.get(
  "/api/admin/dashboard",
  (req, res) => {

    if (
      !isAdmin(req)
    ) {

      return res.status(401).json({

        ok: false,

        error:
          "Não autorizado."
      });
    }


    const memory =
      process.memoryUsage();


    const memoriaMB =
      Number(
        (
          memory.rss /
          1024 /
          1024
        ).toFixed(2)
      );


    return res.json({

      ok: true,

      version: "12.9.0",

      metricas: {

        valorArrecadado:
          Number(
            metrics.revenue.toFixed(2)
          ),

        totalVendas:
          metrics.pixApproved,

        totalDownloads:
          metrics.downloads,

        totalAnalises:
          metrics.analyses,

        analisesGemini:
          metrics.geminiAnalyses,

        memoriaMB,

        uptime:
          Math.round(
            process.uptime()
          )
      },

      services: {

        gemini:
          Boolean(
            GEMINI_API_KEY
          ),

        geminiModel:
          GEMINI_MODEL,

        rapidapi:
          Boolean(
            RAPIDAPI_KEY
          ),

        mercadoPago:
          Boolean(
            MP_ACCESS_TOKEN
          )
      }
    });
  }
);


/* ============================================================
   MERCADO PAGO - PIX
   ============================================================ */

const pagamentos =
  new Map();


app.post(
  "/api/pix/criar",
  async (req, res) => {

    if (
      !MP_ACCESS_TOKEN
    ) {

      return res.status(503).json({

        ok: false,

        error:
          "Mercado Pago não configurado."
      });
    }


    const valor =
      safeNumber(
        req.body.valor,
        19.90
      );


    const plano =
      String(
        req.body.plano ||
        "VIP"
      );


    const userId =
      String(
        req.body.userId ||
        "user_anonimo"
      );


    const externalReference =
      `clipforge-${userId}-${Date.now()}`;


    try {

      const response =
        await fetch(
          "https://api.mercadopago.com/v1/payments",
          {

            method: "POST",

            headers: {

              "Authorization":
                `Bearer ${MP_ACCESS_TOKEN}`,

              "Content-Type":
                "application/json",

              "X-Idempotency-Key":
                crypto
                  .randomUUID()
            },

            body:
              JSON.stringify({

                transaction_amount:
                  Number(
                    valor.toFixed(2)
                  ),

                description:
                  `ClipForge Pro ${plano}`,

                payment_method_id:
                  "pix",

                external_reference:
                  externalReference,

                payer: {

                  email:
                    String(
                      req.body.email ||
                      `user-${Date.now()}@clipforge.local`
                    )
                }
              })
          }
        );


      const data =
        await response.json();


      if (
        !response.ok
      ) {

        console.error(
          "[Mercado Pago]",
          JSON.stringify(data)
        );

        return res.status(
          response.status
        ).json({

          ok: false,

          error:
            data?.message ||
            "Erro criando pagamento."
        });
      }


      const id =
        String(
          data.id
        );


      const pix =
        data.point_of_interaction
          ?.transaction_data;


      pagamentos.set(
        id,
        {
          id,
          userId,
          plano,
          valor,
          status:
            data.status ||
            "pending",
          createdAt:
            Date.now(),
          approved:
            false
        }
      );


      metrics.pixCreated++;


      return res.json({

        ok: true,

        id,

        paymentId:
          id,

        status:
          data.status,

        qrCode:
          pix?.qr_code ||
          null,

        qrCodeBase64:
          pix?.qr_code_base64 ||
          null,

        ticketUrl:
          pix?.ticket_url ||
          null,

        externalReference
      });

    } catch (error) {

      console.error(
        "[PIX]",
        error.message
      );


      return res.status(500).json({

        ok: false,

        error:
          "Erro criando PIX.",

        details:
          error.message
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

    const paymentId =
      String(
        req.params.id
      );


    if (
      !MP_ACCESS_TOKEN
    ) {

      return res.status(503).json({

        ok: false,

        error:
          "Mercado Pago não configurado."
      });
    }


    try {

      const response =
        await fetch(
          `https://api.mercadopago.com/v1/payments/${encodeURIComponent(
            paymentId
          )}`,
          {

            headers: {

              "Authorization":
                `Bearer ${MP_ACCESS_TOKEN}`
            },

            signal:
              AbortSignal.timeout(
                20000
              )
          }
        );


      const data =
        await response.json();


      if (
        !response.ok
      ) {

        return res.status(
          response.status
        ).json({

          ok: false,

          error:
            data?.message ||
            "Erro consultando pagamento."
        });
      }


      const status =
        data.status ||
        "pending";


      const registro =
        pagamentos.get(
          paymentId
        );


      const approved =
        status ===
        "approved";


      if (
        registro
      ) {

        registro.status =
          status;

        registro.approved =
          approved;


        if (
          approved &&
          !registro.counted
        ) {

          registro.counted =
            true;

          metrics.pixApproved++;

          metrics.revenue +=
            safeNumber(
              registro.valor,
              0
            );
        }
      }


      return res.json({

        ok: true,

        id:
          paymentId,

        status,

        approved,

        plano:
          registro?.plano ||
          "VIP",

        valor:
          registro?.valor ||
          data.transaction_amount ||
          0
      });

    } catch (error) {

      console.error(
        "[PIX STATUS]",
        error.message
      );


      return res.status(500).json({

        ok: false,

        error:
          "Erro consultando pagamento."
      });
    }
  }
);


/* ============================================================
   WEBHOOK MERCADO PAGO
   ============================================================ */

app.post(
  "/api/pix/webhook",
  async (req, res) => {

    console.log(
      "[Webhook MP]",
      JSON.stringify(
        req.body
      ).substring(0, 2000)
    );


    /*
     * Respondemos rapidamente ao Mercado Pago.
     *
     * O status real continua sendo consultado
     * pelo endpoint /api/pix/status/:id.
     */

    return res.sendStatus(200);
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
        req.originalUrl
    });
  }
);


/* ============================================================
   ERRO GLOBAL
   ============================================================ */

app.use(
  (error, req, res, next) => {

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
        "Erro interno do servidor."
    });
  }
);


/* ============================================================
   LIMPEZA AUTOMÁTICA
   ============================================================ */

setInterval(
  () => {

    try {

      if (
        !fs.existsSync(
          TEMP_DIR
        )
      ) {
        return;
      }


      const files =
        fs.readdirSync(
          TEMP_DIR
        );


      const agora =
        Date.now();


      for (
        const file of files
      ) {

        const fullPath =
          path.join(
            TEMP_DIR,
            file
          );


        try {

          const stat =
            fs.statSync(
              fullPath
            );


          /*
           * Remove arquivos com mais de 30 minutos.
           */

          if (
            agora -
              stat.mtimeMs >
            30 * 60 * 1000
          ) {

            fs.unlinkSync(
              fullPath
            );

            console.log(
              "[Cleanup] Removido:",
              file
            );
          }

        } catch (_) {}
      }

    } catch (error) {

      console.error(
        "[Cleanup]",
        error.message
      );
    }

  },
  10 * 60 * 1000
);


/* ============================================================
   START
   ============================================================ */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");
    console.log(
      "===================================================="
    );

    console.log(
      "      CLIPFORGE PRO BACKEND VERSION 12.9.0"
    );

    console.log(
      "===================================================="
    );

    console.log(
      `[ClipForge] Porta: ${PORT}`
    );

    console.log(
      `[YT-API] ${
        RAPIDAPI_KEY
          ? "CONFIGURADA"
          : "NÃO CONFIGURADA"
      }`
    );

    console.log(
      `[Mercado Pago] ${
        MP_ACCESS_TOKEN
          ? "CONFIGURADO"
          : "NÃO CONFIGURADO"
      }`
    );

    console.log(
      `[Gemini] ${
        GEMINI_API_KEY
          ? "CONFIGURADO"
          : "NÃO CONFIGURADO"
      }`
    );

    console.log(
      `[Gemini] Modelo: ${GEMINI_MODEL}`
    );

    console.log(
      `[Admin] ${
        ADMIN_PASSWORD
          ? "CONFIGURADO"
          : "NÃO CONFIGURADO"
      }`
    );

    console.log(
      `[yt-dlp] ${
        fs.existsSync(YTDLP_PATH)
          ? `Encontrado em ${YTDLP_PATH}`
          : "NÃO ENCONTRADO"
      }`
    );

    console.log(
      "[Gemini] Análise direta de URLs públicas do YouTube ativa."
    );

    console.log(
      "[Download] YT-API + FFmpeg + yt-dlp fallback ativo."
    );

    console.log(
      "===================================================="
    );

    console.log("");
  }
);