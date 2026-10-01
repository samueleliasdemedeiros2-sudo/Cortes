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
const JOB_DIR = process.env.JOB_DIR || "/tmp/clipforge";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

await fs.mkdir(JOB_DIR, { recursive: true });

app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));
app.use("/files", express.static(JOB_DIR));

app.get("/", async (_req, res) => {
  const indexPath = path.join(__dirname, "index.html");
  try {
    await fs.access(indexPath);
    return res.sendFile(indexPath);
  } catch {
    return res.send("🚀 ClipForge API Online!");
  }
});

app.get("/ping", (_req, res) => res.status(200).send("Pong! Servidor ativo."));

function extractId(url) {
  const match = String(url).match(/^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/);
  return (match && match[2].length === 11) ? match[2] : null;
}

// Análise e identificação com IA Gemini
async function gerarCortesComIA(videoId, quantity, duration) {
  if (!GEMINI_API_KEY) {
    throw new Error("Chave GEMINI_API_KEY não configurada.");
  }

  const prompt = `
És um especialista em edição de vídeos virais para TikTok, Instagram Reels e YouTube Shorts.
Analisa o vídeo do YouTube com ID: "${videoId}" (URL: https://www.youtube.com/watch?v=${videoId}).

Gera exatamente ${quantity} sugestões de cortes virais de aproximadamente ${duration} segundos cada.
Prioriza partes com ganchos fortes, momentos de pico, humor ou lições de alto impacto.

Retorna APENAS JSON puro no seguinte formato, sem formatação markdown:
[
  {
    "title": "Gancho chamativo do corte",
    "start": 15,
    "end": ${15 + Number(duration)},
    "duration": ${Number(duration)},
    "potential": "98%"
  }
]
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Falha Gemini ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  text = text.replace(/```json/g, "").replace(/```/g, "").trim();

  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.clips || []);
}

// Rota de Análise
app.post("/api/analisar", async (req, res) => {
  const { youtubeUrl, quantity = 5, duration = 30 } = req.body || {};
  const videoId = extractId(youtubeUrl);

  if (!videoId) {
    return res.status(400).json({ success: false, error: "Link do YouTube inválido." });
  }

  try {
    const clips = await gerarCortesComIA(videoId, quantity, duration);
    return res.json({ success: true, videoId, clips });
  } catch (error) {
    console.error("Erro na IA, aplicando fallback:", error.message);
    const q = Number(quantity) || 5;
    const d = Number(duration) || 30;
    const fallback = Array.from({ length: q }, (_, i) => ({
      title: `Momento de Destaque #${i + 1}`,
      start: i * (d + 10) + 15,
      end: i * (d + 10) + 15 + d,
      duration: d,
      potential: "90%"
    }));

    return res.json({ success: true, videoId, clips: fallback });
  }
});

// Rota de Renderização com Download em Seções
app.post("/api/render", async (req, res) => {
  const { youtubeUrl, start = 0, duration = 30, format = "9:16" } = req.body || {};
  const videoId = extractId(youtubeUrl);

  if (!videoId) {
    return res.status(400).json({ error: "Link inválido." });
  }

  const safeStart = Number(start) || 0;
  const safeDuration = Number(duration) || 30;
  const safeEnd = safeStart + safeDuration;

  const job = uuidv4();
  const dir = path.join(JOB_DIR, job);
  const partFile = path.join(dir, "part.mp4");
  const outputFile = path.join(dir, "clip.mp4");

  try {
    await fs.mkdir(dir, { recursive: true });

    // Descarrega apenas os segundos solicitados para poupar memória e evitar bloqueios
    await exec("yt-dlp", [
      "--no-playlist",
      "--no-warnings",
      "--force-overwrites",
      "--download-sections", `*${safeStart}-${safeEnd}`,
      "-f", "best[ext=mp4]/best",
      "-o", partFile,
      `https://www.youtube.com/watch?v=${videoId}`
    ]);

    const filter = format === "9:16"
      ? "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2"
      : "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2";

    // Processamento rápido com FFmpeg
    await exec("ffmpeg", [
      "-y",
      "-i", partFile,
      "-t", String(safeDuration),
      "-vf", filter,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "28",
      "-c:a", "aac",
      "-b:a", "96k",
      outputFile
    ]);

    return res.download(outputFile, `Corte_${videoId}_${safeStart}s.mp4`, async () => {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
    });
  } catch (err) {
    console.error("Falha ao renderizar:", err.message);
    try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
    return res.status(500).json({ error: "Falha ao gerar o corte.", detalhe: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});
