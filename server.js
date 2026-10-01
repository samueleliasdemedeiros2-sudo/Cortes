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

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "c9dea9a596msh9565df12086412fp1d11cejsnadb3d0bd41ad";
const RAPIDAPI_HOST = "youtube-video-fast-downloader-24-7.p.rapidapi.com";

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
Retorna APENAS JSON puro no seguinte formato, sem formatação markdown:
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

// Endpoint seguro de geração na RapidAPI
app.get("/api/download-rapid", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ success: false, error: "videoId em falta." });

  try {
    // Solicita o vídeo com áudio em 720p (quality=22) para renderização rápida
    const apiUrl = `https://${RAPIDAPI_HOST}/download_video/${encodeURIComponent(videoId)}?quality=22`;
    const apiRes = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST,
        "Accept": "application/json"
      }
    });

    const data = await apiRes.json();
    const downloadUrl = data.file || data.url || data.link || (data.data && data.data.file);

    if (!downloadUrl) {
      console.error("Resposta RapidAPI:", data);
      return res.status(500).json({ success: false, error: "Link não gerado pela API." });
    }

    // Aguarda até o ficheiro estar pronto nos servidores da RapidAPI
    let isReady = false;
    let attempts = 0;
    const maxAttempts = 8; // até ~24 segundos

    while (!isReady && attempts < maxAttempts) {
      attempts++;
      await new Promise(resolve => setTimeout(resolve, 3000));

      try {
        const checkRes = await fetch(downloadUrl, { method: "HEAD" });
        if (checkRes.status === 200) {
          isReady = true;
          break;
        }
      } catch (e) {}
    }

    // Retorna a URL direta para o frontend descarregar no telemóvel
    return res.json({ success: true, downloadUrl });

  } catch (err) {
    console.error("Erro RapidAPI:", err.message);
    return res.status(500).json({ success: false, error: "Falha na comunicação com a API." });
  }
});

app.listen(PORT, () => console.log(`Servidor ativo na porta ${PORT}`));
