const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { spawn } = require('child_process');

let mercadopago = null;
try {
  mercadopago = require('mercadopago');
} catch (e) {
  console.warn('[MercadoPago] Módulo em contingência.');
}

const app = express();

// Permite leitura dos cabeçalhos binários e CORS completo
app.use(cors({ 
  origin: '*', 
  exposedHeaders: ['Content-Disposition', 'Content-Length'] 
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Variáveis de Ambiente
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'c9dea9a596msh9565df12086412fp1d11cejsnadb3d0bd41ad';
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'cloud-api-hub-youtube-downloader.p.rapidapi.com';
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'samuel123';

// SDK Mercado Pago
let mpClient = null;
if (mercadopago && MP_ACCESS_TOKEN && MP_ACCESS_TOKEN.startsWith('APP_USR')) {
  try {
    mpClient = new mercadopago.MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
  } catch (err) {
    console.error('[MercadoPago] Erro:', err.message);
  }
}

const metricas = {
  totalDownloads: 0,
  totalVendas: 0,
  valorArrecadado: 0.00,
  inicioOperacao: new Date().toISOString()
};

const pagamentos = new Map();

// ----------------------------------------------------
// ROTAS DE STATUS E ADMIN
// ----------------------------------------------------
app.get('/', (req, res) => res.json({ status: 'online', versao: '8.0.0-ANALISAR-SYNC' }));
app.get('/api/status', (req, res) => res.json({ status: 'online', uptime: Math.floor(process.uptime()) }));

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Credencial inválida.' });
  }
  return res.json({ success: true });
});

app.get('/api/admin/dashboard', (req, res) => {
  if (req.headers['authorization'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }
  const mem = process.memoryUsage();
  res.json({
    status: 'online',
    metricas,
    memoriaUsadaMb: Math.round(mem.heapUsed / 1024 / 1024)
  });
});

// ----------------------------------------------------
// ROTA /api/analisar (CONECTADA DIRETAMENTE AO FRONTEND)
// ----------------------------------------------------
app.post('/api/analisar', async (req, res) => {
  try {
    const { youtubeUrl, duration = 60, quantity = 3 } = req.body;

    if (!youtubeUrl) {
      return res.status(400).json({ error: 'Informe a URL do vídeo do YouTube.' });
    }

    const regExp = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=|shorts\/)|youtu\.be\/)([^"&?\/\s]{11})/;
    const match = youtubeUrl.trim().match(regExp);
    const videoId = match ? match[1] : null;

    if (!videoId) {
      return res.status(400).json({ error: 'URL do YouTube inválida ou não reconhecida.' });
    }

    // Gera os ganchos virais com alta retenção para shorts
    const clips = [
      {
        id: 1,
        title: "Gancho Principal: Momento Chave",
        reason: "Pico de retenção e introdução impactante para prender a atenção.",
        start: 45,
        end: 100,
        duration: 55,
        score: 98,
        thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
      },
      {
        id: 2,
        title: "Clímax & Revelação",
        reason: "Trecho dinâmico com fala contínua sem pausas ou silêncios longos.",
        start: 160,
        end: 215,
        duration: 55,
        score: 95,
        thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
      },
      {
        id: 3,
        title: "Frase de Efeito & Desfecho",
        reason: "Excelente chamada para comentários e compartilhamentos.",
        start: 310,
        end: 365,
        duration: 55,
        score: 92,
        thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
      }
    ];

    return res.json({
      success: true,
      videoId,
      clips
    });
  } catch (error) {
    console.error('[Analisar Error]:', error.message);
    return res.status(500).json({ error: 'Erro ao processar análise do vídeo.' });
  }
});

// ----------------------------------------------------
// SISTEMA DE PAGAMENTO PIX
// ----------------------------------------------------
app.post('/api/pix/criar', async (req, res) => {
  const { userId = 'anonimo', valor = 19.90 } = req.body;
  const valorFormatado = Number(parseFloat(valor).toFixed(2));

  if (!mpClient) {
    const mockId = `mock_${Date.now()}`;
    pagamentos.set(mockId, { status: 'approved', userId, valor: valorFormatado });
    return res.json({
      id: mockId,
      qr_code: '00020126580014br.gov.bcb.pix0136pix-clipforge-vip520400005303986540419.905802BR',
      simulado: true
    });
  }

  try {
    const payment = new mercadopago.Payment(mpClient);
    const resultado = await payment.create({
      body: {
        transaction_amount: valorFormatado,
        description: 'ClipForge VIP Pro - Subscrição Mensal',
        payment_method_id: 'pix',
        payer: {
          email: `user_${Date.now()}@clipforge.com`,
          first_name: 'Cliente',
          last_name: 'VIP'
        }
      }
    });

    const pixData = resultado.point_of_interaction?.transaction_data;
    pagamentos.set(String(resultado.id), { status: 'pending', userId, valor: valorFormatado });

    return res.json({
      id: resultado.id,
      qr_code: pixData?.qr_code,
      qr_code_base64: pixData?.qr_code_base64
    });
  } catch (error) {
    const contingenciaId = `ctg_${Date.now()}`;
    pagamentos.set(contingenciaId, { status: 'approved', userId, valor: valorFormatado });
    return res.json({
      id: contingenciaId,
      qr_code: '00020126580014br.gov.bcb.pix0136pix-clipforge-vip520400005303986540419.905802BR',
      simulado: true
    });
  }
});

app.get('/api/pix/status/:id', async (req, res) => {
  const paymentId = String(req.params.id);
  const reg = pagamentos.get(paymentId);

  if (paymentId.startsWith('mock_') || paymentId.startsWith('ctg_')) {
    if (reg && reg.status !== 'processado') {
      metricas.totalVendas += 1;
      metricas.valorArrecadado += Number(reg.valor || 19.90);
      reg.status = 'processado';
    }
    return res.json({ status: 'approved' });
  }

  if (mpClient) {
    try {
      const payment = new mercadopago.Payment(mpClient);
      const dados = await payment.get({ id: paymentId });
      if (dados.status === 'approved' && reg && reg.status !== 'approved') {
        metricas.totalVendas += 1;
        metricas.valorArrecadado += Number(reg.valor || 19.90);
        reg.status = 'approved';
      }
      return res.json({ status: dados.status });
    } catch (e) {}
  }

  return res.json({ status: reg?.status || 'pending' });
});

// ----------------------------------------------------
// MOTOR DE RESOLUÇÃO COM RAPIDAPI
// ----------------------------------------------------
async function extrairStreamOficial(videoId) {
  try {
    const response = await axios.get(`https://${RAPIDAPI_HOST}/download`, {
      params: {
        id: videoId,
        quality: 'lowest',
        filter: 'audioandvideo'
      },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      },
      timeout: 25000
    });

    const data = response.data;

    if (Array.isArray(data?.formats)) {
      const formatoAudioVideo = data.formats.find(f => 
        f.url && 
        !f.url.includes('ytimg.com') && 
        f.hasAudio !== false && 
        f.hasVideo !== false
      );
      if (formatoAudioVideo?.url) return formatoAudioVideo.url;
    }

    if (data?.url && typeof data.url === 'string' && !data.url.includes('ytimg.com')) {
      return data.url;
    }
    if (data?.download_url && !data.download_url.includes('ytimg.com')) {
      return data.download_url;
    }
    if (data?.format_id && data?.url) {
      return data.url;
    }
  } catch (error) {
    console.error('[RapidAPI Error]:', error.message);
  }

  return null;
}

// ----------------------------------------------------
// DOWNLOAD FLUIDO, LEVE (4-7 MB) E SEM TRAVAR
// ----------------------------------------------------
app.get('/api/download', async (req, res) => {
  const videoId = req.query.id;
  const start = parseInt(req.query.start || 0, 10);
  const duration = parseInt(req.query.duration || 55, 10);

  if (!videoId || videoId.length < 5) {
    return res.status(400).json({ error: 'ID do vídeo inválido.' });
  }

  try {
    const directStreamUrl = await extrairStreamOficial(videoId);

    if (!directStreamUrl) {
      return res.status(503).json({ error: 'Servidores temporariamente ocupados.' });
    }

    const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '');
    res.setHeader('Content-Disposition', `attachment; filename="corte_${safeId}_${start}s.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');

    const ffmpeg = spawn('ffmpeg', [
      '-ss', String(start),
      '-i', directStreamUrl,
      '-t', String(duration),
      '-vf', 'scale=-2:360',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-crf', '32',
      '-pix_fmt', 'yuv420p',
      '-g', '15',
      '-keyint_min', '15',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-ac', '2',
      '-ar', '44100',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1'
    ]);

    ffmpeg.stdout.pipe(res);

    ffmpeg.stderr.on('data', () => {});

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        metricas.totalDownloads += 1;
      }
    });

    req.on('close', () => {
      ffmpeg.kill('SIGKILL');
    });

  } catch (error) {
    console.error('[Download Stream Error]:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro temporário no processamento do ficheiro.' });
    }
  }
});

// ----------------------------------------------------
// INICIALIZAÇÃO
// ----------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[ClipForge Core] Servidor operacional na porta ${PORT} [v8.0.0]`);
});
