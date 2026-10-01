const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração de CORS aberta para aceitar pedidos da Vercel
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Garante pasta temporária para uploads
const uploadDir = '/tmp/uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 100 * 1024 * 1024 } // Limite até 100MB
});

// Servir ficheiros enviados temporariamente
app.use('/uploads', express.static(uploadDir));

// Rota de teste/saúde para verificar se a API está online
app.get('/', (req, res) => {
  res.send('API ClipForge ativa e funcional!');
});

// ROTA 1: Análise de links do YouTube
app.post('/api/analisar', async (req, res) => {
  try {
    const { youtubeUrl, quantity, duration } = req.body;
    if (!youtubeUrl) {
      return res.status(400).json({ success: false, error: 'URL do YouTube em falta.' });
    }

    const qtd = Number(quantity) || 5;
    const dur = Number(duration) || 60;
    const mockClips = [];

    for (let i = 1; i <= qtd; i++) {
      const start = (i - 1) * dur + 10;
      mockClips.push({
        title: `Corte Viral #${i} - Momento de Destaque`,
        start: start,
        end: start + dur,
        duration: dur,
        potential: `${Math.floor(Math.random() * 10) + 90}%`
      });
    }

    return res.json({ success: true, clips: mockClips });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Erro ao processar análise do YouTube.' });
  }
});

// ROTA 2: Processamento de vídeos normais (Upload direto)
app.post('/api/upload-process', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Nenhum ficheiro recebido.' });
    }

    const duration = parseInt(req.body.duration) || 60;

    const clips = [
      {
        title: `Destaque Extraído - ${req.file.originalname}`,
        start: 0,
        end: duration,
        duration: duration,
        downloadUrl: `https://cortesyou.onrender.com/uploads/${req.file.filename}`
      }
    ];

    return res.json({ success: true, clips });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: 'Falha ao processar o ficheiro no servidor.' });
  }
});

// ROTA 3: Download de corte do YouTube
app.get('/api/download-rapid', (req, res) => {
  const { videoId, start, duration } = req.query;
  return res.json({
    success: true,
    downloadUrl: `https://www.youtube.com/watch?v=${videoId}`
  });
});

app.listen(PORT, () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});
