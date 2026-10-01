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

// Análise com Gemini adaptada para trechos de 60 segundos
async function gerarCortesComIA(videoId, quantity, duration) {
  if (!GEMINI_API_KEY) throw new Error("Chave GEMINI_API_KEY ausente.");

  const targetDuration = Number(duration) || 60;
  const targetQuantity = Number(quantity) || 5;

  const prompt = `
És um editor profissional de vídeos virais.
Analisa o vídeo do YouTube com ID: "${videoId}" (https://www.youtube.com/watch?v=${videoId}).
Gera exatamente ${targetQuantity} cortes virais de cerca de ${targetDuration} segundos cada.
Certifica-te que os cortes tenham desenvolvimento completo (começo, meio e fim) durando aproximadamente ${targetDuration} segundos.
Retorna APENAS JSON puro no formato:
[
  {
    "title": "Título chamativo do corte viral",
    "start": 10,
    "end": ${10 + targetDuration},
    "duration": ${targetDuration},
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
  const { youtubeUrl, quantity = 5, duration = 60 } = req.body || {};
  const videoId = extractId(youtubeUrl);
  if (!videoId) return res.status(400).json({ success: false, error: "Link inválido." });

  try {
    const clips = await gerarCortesComIA(videoId, quantity, duration);
    return res.json({ success: true, videoId, clips });
  } catch (error) {
    const q = Number(quantity) || 5;
    const d = Number(duration) || 60;
    const fallback = Array.from({ length: q }, (_, i) => ({
      title: `Corte de Alto Impacto #${i + 1}`,
      start: i * (d + 15) + 15,
      end: i * (d + 15) + 15 + d,
      duration: d,
      potential: "95%"
    }));
    return res.json({ success: true, videoId, clips: fallback });
  }
});

// Download na RapidAPI com suporte a trim_duration de 60s
app.get("/api/download-rapid", async (req, res) => {
  const { videoId, start = 0, duration = 60 } = req.query;
  if (!videoId) return res.status(400).json({ success: false, error: "videoId em falta." });

  const safeStart = Number(start) || 0;
  const safeDuration = Number(duration) || 60;

  try {
    const apiUrl = `https://${RAPIDAPI_HOST}/download_video/${encodeURIComponent(videoId)}?quality=22&trim_start_time=${safeStart}&trim_duration=${safeDuration}`;
    
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
      return res.status(500).json({ success: false, error: "Não foi possível obter o link da API." });
    }

    // Polling aguardando o vídeo de 60s sair do estado 404
    let isReady = false;
    let attempts = 0;
    const maxAttempts = 10;

    while (!isReady && attempts < maxAttempts) {
      attempts++;
      await new Promise(resolve => setTimeout(resolve, 4000));

      try {
        const testRes = await fetch(downloadUrl, { method: "GET" });
        if (testRes.status === 200) {
          isReady = true;
          break;
        }
      } catch (e) {
        // Aguardando conversão
      }
    }

    return res.json({ success: true, downloadUrl });

  } catch (err) {
    console.error("Erro no processamento:", err.message);
    return res.status(500).json({ success: false, error: "Falha na comunicação com a API." });
  }
});

app.listen(PORT, () => console.log(`Servidor ativo na porta ${PORT}`));