import express from "express";
import cors from "cors";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { v4 as uuid } from "uuid";

const exec = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const JOB_DIR = process.env.JOB_DIR || "/tmp/clipforge";

await fs.mkdir(JOB_DIR, { recursive: true });

app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));
app.use("/files", express.static(JOB_DIR));

app.get("/api/health", (_req,res)=>res.json({
  ok:true, service:"clipforge-server", version:"1.0.0"
}));

function validYouTube(url) {
  try {
    const u = new URL(url);
    return ["youtube.com","www.youtube.com","youtu.be","m.youtube.com"].includes(u.hostname);
  } catch { return false; }
}

async function run(bin,args) {
  return exec(bin,args,{maxBuffer:1024*1024*10});
}

app.post("/api/clip", async (req,res)=>{
  const { url, start=0, duration=60, format="9:16" } = req.body || {};
  if (!validYouTube(url)) return res.status(400).json({error:"URL do YouTube inválida."});

  const safeDuration = Math.min(Math.max(Number(duration)||60, 5), 180);
  const safeStart = Math.max(Number(start)||0, 0);
  const job = uuid();
  const dir = path.join(JOB_DIR, job);
  await fs.mkdir(dir, {recursive:true});

  try {
    const input = path.join(dir, "source.%(ext)s");
    const out = path.join(dir, "clip.mp4");

    // Baixa somente conteúdo ao qual o usuário tenha direito de acessar/usar.
    await run("yt-dlp", [
      "--no-playlist",
      "-f", "bv*[height<=1080]+ba/b[height<=1080]/b",
      "--merge-output-format", "mp4",
      "-o", input,
      url
    ]);

    const files = await fs.readdir(dir);
    const source = files.find(f=>/^source\./.test(f) && f.endsWith(".mp4"));
    if (!source) throw new Error("Vídeo não foi obtido em MP4.");

    const sourcePath = path.join(dir, source);
    let vf = "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2";

    if (format === "1:1") {
      vf = "scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2";
    }

    await run("ffmpeg", [
      "-y","-ss",String(safeStart),"-i",sourcePath,
      "-t",String(safeDuration),
      "-vf",vf,
      "-c:v","libx264","-preset","veryfast","-crf","23",
      "-c:a","aac","-b:a","128k","-movflags","+faststart",
      out
    ]);

    const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
    res.json({
      ok:true,
      jobId:job,
      status:"completed",
      clipUrl:`${base}/files/${job}/clip.mp4`,
      note:"V1: corte por intervalo. A análise automática de melhores momentos entra na próxima camada."
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({error:"Falha ao processar o vídeo.", detail:String(e.message||e)});
  }
});

app.listen(PORT, ()=>console.log(`ClipForge server listening on ${PORT}`));
