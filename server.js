import express from "express";
import cors from "cors";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));

app.get("/", async (_req, res) => {
  const indexPath = path.join(__dirname, "index.html");
  try {
    await fs.access(indexPath);
    return res.sendFile(indexPath);
  } catch {
    return res.send("🚀 ClipForge Studio API Ativa!");
  }
});

app.get("/ping", (_req, res) => res.status(200).send("Pong!"));

function extractId(url) {
  const match = String(url).match(/^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/);
  return (match && match[2].length === 11) ? match[2] : null;
}

// Análise com Gemini
async function gerarCortesComIA(videoId, quantity, duration) {
  if (!GEMINI_API_KEY) throw new Error("Chave GEMINI_API_KEY ausente.");

  const prompt = `
És um editor profissional de vídeos virais.
Analisa o vídeo do YouTube com ID: "${videoId}" (https://www.youtube.com/watch?v=${videoId}).
Gera exatamente ${quantity} cortes virais de cerca de ${duration} segundos cada.
Retorna APENAS JSON puro no formato:
[
  {
    "title": "Gancho viral do corte",
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
      generationConfig: { temperature: 0.3, responseMimeType: "application/json" }
    })
  });

  if (!response.ok) throw new Error(`Erro Gemini ${response.status}`);
  const data = await response.json();
  let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  text = text.replace(/```json/g, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.clips || []);
}

app.post("/api/analisar", async (req, res) => {
  const { youtubeUrl, quantity = 5, duration = 30 } = req.body || {};
  const videoId = extractId(youtubeUrl);
  if (!videoId) return res.status(400).json({ success: false, error: "Link inválido." });

  try {
    const clips = await gerarCortesComIA(videoId, quantity, duration);
    return res.json({ success: true, videoId, clips });
  } catch (error) {
    const q = Number(quantity) || 5;
    const d = Number(duration) || 30;
    const fallback = Array.from({ length: q }, (_, i) => ({
      title: `Momento de Destaque #${i + 1}`,
      start: i * (d + 10) + 10,
      end: i * (d + 10) + 10 + d,
      duration: d,
      potential: "90%"
    }));
    return res.json({ success: true, videoId, clips: fallback });
  }
});

// Transferência direta do ficheiro MP4 via stream nativo
app.get("/api/download", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).send("ID ausente.");

  try {
    // Obtém o URL direto do ficheiro sem transferir para o servidor
    const { stdout } = await exec("yt-dlp", [
      "--no-playlist",
      "--no-warnings",
      "--extractor-args", "youtube:player_client=android",
      "-f", "best[ext=mp4]/best",
      "-g",
      `https://www.youtube.com/watch?v=${videoId}`
    ]);

    const directStreamUrl = stdout.trim().split("\n")[0];
    if (!directStreamUrl) throw new Error("Stream indisponível.");

    // Redireciona o telemóvel diretamente para descarregar o ficheiro original em MP4
    return res.redirect(directStreamUrl);
  } catch (err) {
    // Fallback: serviço de entrega direta de ficheiros de vídeo
    return res.redirect(`https://y2mate.is/en/download?url=https://www.youtube.com/watch?v=${videoId}`);
  }
});

app.listen(PORT, () => console.log(`Servidor ativo na porta ${PORT}`));
