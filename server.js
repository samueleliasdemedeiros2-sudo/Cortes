import express from "express";
import cors from "cors";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    return res.send("🚀 ClipForge API Online!");
  }
});

app.get("/ping", (_req, res) => res.status(200).send("Pong! Servidor ativo."));

function extractId(url) {
  const match = String(url).match(/^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/);
  return (match && match[2].length === 11) ? match[2] : null;
}

// Geração de cortes com a IA do Gemini
async function gerarCortesComIA(videoId, quantity, duration) {
  if (!GEMINI_API_KEY) {
    throw new Error("Chave GEMINI_API_KEY ausente.");
  }

  const prompt = `
Você é um editor profissional de vídeos para Reels, Shorts e TikTok.
Analise o vídeo do YouTube com ID: "${videoId}" (https://www.youtube.com/watch?v=${videoId}).

Gere exatamente ${quantity} cortes virais de cerca de${duration} segundos cada.
Priorize trechos impactantes, ganchos fortes ou lições práticas.

Retorne APENAS um array JSON puro (sem markdown, sem \`\`\`json):
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
      generationConfig: {
        temperature: 0.3,
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Erro Gemini ${response.status}`);
  }

  const data = await response.json();
  let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  text = text.replace(/```json/g, "").replace(/```/g, "").trim();

  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.clips || []);
}

// Rota de análise
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
    console.error("Fallback da IA:", error.message);
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

// DOWNLOAD DIRETO: Pega o stream limpo sem encurtador e redireciona direto pro arquivo MP4
app.get("/api/download-direct", async (req, res) => {
  const { videoId } = req.query;

  if (!videoId) {
    return res.status(400).send("Video ID ausente.");
  }

  try {
    // Consulta a API de stream limpo sem restrição de CORS
    const cobaltRes = await fetch("https://api.cobalt.tools", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url: `https://www.youtube.com/watch?v=${videoId}`,
        videoQuality: "720",
        downloadMode: "auto"
      })
    });

    const data = await cobaltRes.json();
    const downloadUrl = data.url || (data.picker && data.picker[0]?.url);

    if (downloadUrl) {
      // Redireciona o navegador direto para o download do arquivo MP4
      return res.redirect(downloadUrl);
    } else {
      return res.status(500).send("Não foi possível gerar o link de download direto.");
    }
  } catch (err) {
    return res.status(500).send("Erro ao obter o vídeo.");
  }
});

app.listen(PORT, () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});
