import express from "express";
import cors from "cors";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuidv4 } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const exec = promisify(execFile);
const app = express();

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const JOB_DIR = process.env.JOB_DIR || "/tmp/clipforge";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

await fs.mkdir(JOB_DIR, { recursive: true });

app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));
app.use("/files", express.static(JOB_DIR));

// Rota raiz: entrega a interface ou texto informativo
app.get("/", async (_req, res) => {
  const indexPath = path.join(__dirname, "index.html");
  try {
    await fs.access(indexPath);
    return res.sendFile(indexPath);
  } catch {
    return res.send("🚀 CLIPFORGE Studio Backend está online!");
  }
});

app.get("/ping", (_req, res) => {
  res.status(200).send("Pong! Servidor ativo.");
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "clipforge-server",
    geminiConfigured: Boolean(GEMINI_API_KEY)
  });
});

function validYouTube(url) {
  try {
    const u = new URL(url);
    return ["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"].includes(u.hostname);
  } catch {
    return false;
  }
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

async function run(bin, args, options = {}) {
  return exec(bin, args, {
    maxBuffer: 20 * 1024 * 1024,
    ...options
  });
}

async function getVideoInfo(url, dir) {
  const output = path.join(dir, "info.json");

  await run("yt-dlp", [
    "--no-playlist",
    "--dump-single-json",
    "--skip-download",
    "--no-warnings",
    "--extractor-args", "youtube:player_client=android,web",
    "-o", output,
    url
  ]);

  const raw = await fs.readFile(output, "utf8");
  return JSON.parse(raw);
}

function fallbackClips(info, quantity, duration) {
  const total = Number(info.duration || 0);
  const count = Math.min(Math.max(Number(quantity) || 5, 1), 8);
  const clipDuration = Math.min(Math.max(Number(duration) || 30, 15), 60);

  if (!total) {
    return Array.from({ length: count }, (_, i) => ({
      title: `Melhor momento #${i + 1}`,
      start: i * clipDuration,
      end: (i + 1) * clipDuration,
      duration: clipDuration,
      potential: "85%"
    }));
  }

  const maxStart = Math.max(0, total - clipDuration);
  const step = count === 1 ? 0 : maxStart / (count - 1);

  return Array.from({ length: count }, (_, i) => {
    const start = Math.floor(i * step);
    const end = Math.min(total, start + clipDuration);
    return {
      title: `Momento sugerido #${i + 1}`,
      start,
      end,
      duration: end - start,
      potential: "90%"
    };
  });
}

function cleanJsonText(text) {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

async function analyzeWithGemini(info, quantity, duration) {
  if (!GEMINI_API_KEY) return null;

  const prompt = `
Você é um editor de vídeos profissional para Shorts/Reels/TikTok.
Analise os dados públicos deste vídeo e sugira ${quantity} cortes de aproximadamente ${duration} segundos com alto potencial de engajamento.
Retorne SOMENTE JSON válido neste formato:
{
  "clips": [
    {
      "title": "título curto e viral",
      "start": 0,
      "end": ${duration},
      "duration": ${duration},
      "potential": "95%"
    }
  ]
}

Regras:
- start e end em segundos inteiros.
- Intervalos maiores que 5 segundos.
- Priorize momentos de pico, ganchos e conclusões.

Dados do vídeo:
Título: ${info.title || ""}
Descrição: ${(info.description || "").slice(0, 4000)}
Duração: ${info.duration || 0} segundos
`;

  // URL corrigido (sem caracteres Markdown corrompidos)
  const apiUrl = `[https://generativelanguage.googleapis.com/v1beta/models/$](https://generativelanguage.googleapis.com/v1beta/models/$){encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;

  const parsed = JSON.parse(cleanJsonText(text));
  if (!Array.isArray(parsed.clips)) return null;

  const total = Number(info.duration || 0);

  return parsed.clips
    .map((clip) => {
      const start = Math.max(0, Number(clip.start) || 0);
      const end = Math.min(total || Infinity, Number(clip.end) || start + duration);
      return {
        title: String(clip.title || "Momento sugerido"),
        start,
        end,
        duration: Math.max(0, end - start),
        potential: String(clip.potential || "88%")
      };
    })
    .filter((clip) => clip.end > clip.start + 4)
    .slice(0, 8);
}

app.post("/api/analisar", async (req, res) => {
  const {
    youtubeUrl,
    quantity = 5,
    duration = 30
  } = req.body || {};

  if (!validYouTube(youtubeUrl)) {
    return res.status(400).json({
      success: false,
      error: "URL do YouTube inválida."
    });
  }

  const safeQuantity = clampNumber(quantity, 1, 8, 5);
  const safeDuration = clampNumber(duration, 15, 60, 30);
  const job = uuidv4();
  const dir = path.join(JOB_DIR, job);

  try {
    await fs.mkdir(dir, { recursive: true });

    const info = await getVideoInfo(youtubeUrl, dir);
    let clips = null;

    if (GEMINI_API_KEY) {
      try {
        clips = await analyzeWithGemini(info, safeQuantity, safeDuration);
      } catch (error) {
        console.error("Gemini falhou; acionando fallback:", error.message);
      }
    }

    if (!clips?.length) {
      clips = fallbackClips(info, safeQuantity, safeDuration);
    }

    return res.json({
      success: true,
      video: {
        id: info.id,
        title: info.title,
        duration: info.duration
      },
      clips
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      error: "Não foi possível analisar o vídeo.",
      detalhe: String(error.message || error)
    });
  }
});

function videoFilter(format) {
  if (format === "1:1") {
    return "scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2";
  }
  if (format === "16:9") {
    return "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2";
  }
  return "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2";
}

async function renderClip(url, start, end, format, res) {
  if (!validYouTube(url)) {
    return res.status(400).json({ error: "URL do YouTube inválida." });
  }

  const safeStart = clampNumber(start, 0, 24 * 60 * 60, 0);
  const safeEnd = clampNumber(end, safeStart + 5, safeStart + 180, safeStart + 30);
  const safeDuration = Math.min(Math.max(safeEnd - safeStart, 5), 180);

  const job = uuidv4();
  const dir = path.join(JOB_DIR, job);
  const input = path.join(dir, "source.%(ext)s");
  const out = path.join(dir, "clip.mp4");

  try {
    await fs.mkdir(dir, { recursive: true });

    await run("yt-dlp", [
      "--no-playlist",
      "-f", "bv*[height<=1080]+ba/b[height<=1080]/b",
      "--merge-output-format", "mp4",
      "--extractor-args", "youtube:player_client=android,web",
      "-o", input,
      url
    ]);

    const files = await fs.readdir(dir);
    const source = files.find((f) => /^source\./.test(f) && f.endsWith(".mp4"));
    if (!source) throw new Error("Vídeo não foi obtido em MP4.");

    const actualSource = path.join(dir, source);

    await run("ffmpeg", [
      "-y",
      "-ss", String(safeStart),
      "-i", actualSource,
      "-t", String(safeDuration),
      "-vf", videoFilter(format),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      out
    ]);

    res.download(out, `CLIPFORGE_${Date.now()}.mp4`, async () => {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {}
    });
  } catch (error) {
    console.error(error);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    return res.status(500).json({
      error: "Falha ao renderizar o vídeo.",
      detalhe: String(error.message || error)
    });
  }
}

app.post("/api/render", async (req, res) => {
  const { youtubeUrl, start = 0, end, duration, format = "9:16" } = req.body || {};
  const calculatedEnd = end != null
    ? Number(end)
    : Number(start || 0) + Number(duration || 30);

  return renderClip(youtubeUrl, start, calculatedEnd, format, res);
});

app.listen(PORT, () => {
  console.log(`ClipForge server listening on port ${PORT}`);
});
