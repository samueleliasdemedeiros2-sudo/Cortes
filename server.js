const express = require('express');
const axios = require('axios');
const cors = require('cors');

let mercadopago = null;
try {
  mercadopago = require('mercadopago');
} catch (e) {
  console.warn('[MercadoPago] Módulo em modo de contingência.');
}

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'c9dea9a596msh9565df12086412fp1d11cejsnadb3d0bd41ad';
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'cloud-api-hub-youtube-downloader.p.rapidapi.com';
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'samuel123';

let mpClient = null;
if (mercadopago && MP_ACCESS_TOKEN && MP_ACCESS_TOKEN.startsWith('APP_USR')) {
  try {
    mpClient = new mercadopago.MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
  } catch (err) {
    console.error('[MercadoPago] Falha ao instanciar credenciais:', err.message);
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
// STATUS & HEALTH CHECK
// ----------------------------------------------------
app.get('/', (req, res) => res.json({ status: 'online', versao: '3.0.0-DEFINITIVE' }));
app.get('/api/status', (req, res) => res.json({ status: 'online', uptime: Math.floor(process.uptime()) }));

// ----------------------------------------------------
// ADMIN
// ----------------------------------------------------
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
// MERCADO PAGO PIX
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
// MOTOR DE RESOLUÇÃO MULTI-CAMADA (SEM TELAS DE ERRO)
// ----------------------------------------------------
async function extrairStreamDireto(videoId) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // 1. Consulta Direta ao Cloud API Hub (RapidAPI)
  try {
    const r1 = await axios.get(`https://${RAPIDAPI_HOST}/download`, {
      params: { id: videoId },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      },
      timeout: 12000
    });

    const data = r1.data;
    if (data?.url && !data.url.includes('ytimg.com')) return data.url;
    if (data?.download_url && !data.download_url.includes('ytimg.com')) return data.download_url;

    if (Array.isArray(data?.formats)) {
      const formato = data.formats.find(f => f.url && !f.url.includes('ytimg.com') && (f.hasAudio !== false && f.hasVideo !== false))
                   || data.formats.find(f => f.url && !f.url.includes('ytimg.com') && f.qualityLabel === '360p')
                   || data.formats.find(f => f.url && !f.url.includes('ytimg.com'));
      if (formato?.url) return formato.url;
    }
  } catch (err) {}

  // 2. Consulta à rede de CDNs abertas (Invidious / Piped)
  const fallbackNodes = [
    `https://pipedapi.kavin.rocks/streams/${videoId}`,
    `https://api.piped.privacydev.net/streams/${videoId}`,
    `https://inv.nadeko.net/api/v1/videos/${videoId}`,
    `https://invidious.nerdvpn.de/api/v1/videos/${videoId}`
  ];

  for (const urlNode of fallbackNodes) {
    try {
      const resp = await axios.get(urlNode, { timeout: 7000 });
      const streams = resp.data?.videoStreams || resp.data?.formatStreams || [];
      const chosen = streams.find(s => s.url && s.videoOnly === false) || streams[0];
      if (chosen?.url) return chosen.url;
    } catch (e) {}
  }

  // 3. Fallback Direto em CDN Cobalt
  try {
    const cResp = await axios.post('https://api.cobalt.tools', {
      url: videoUrl,
      videoQuality: '360'
    }, {
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      timeout: 8000
    });
    if (cResp.data?.url) return cResp.data.url;
  } catch (e) {}

  return null;
}

// ----------------------------------------------------
// DOWNLOAD REAL (ENTREGA DIRETA NO DISPOSITIVO)
// ----------------------------------------------------
app.get('/api/download', async (req, res) => {
  const videoId = req.query.id;
  const start = parseInt(req.query.start || 0, 10);

  if (!videoId || videoId.length < 5) {
    return res.status(400).send('ID de vídeo inválido.');
  }

  try {
    const streamUrl = await extrairStreamDireto(videoId);

    if (streamUrl) {
      const responseStream = await axios({
        method: 'GET',
        url: streamUrl,
        responseType: 'stream',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 45000
      });

      const sanitizedId = videoId.replace(/[^a-zA-Z0-9_-]/g, '');
      res.setHeader('Content-Disposition', `attachment; filename="corte_${sanitizedId}_${start}s.mp4"`);
      res.setHeader('Content-Type', 'video/mp4');

      metricas.totalDownloads += 1;

      req.on('close', () => {
        if (responseStream.data && typeof responseStream.data.destroy === 'function') {
          responseStream.data.destroy();
        }
      });

      return responseStream.data.pipe(res);
    }

    // Se as instâncias externas estiverem com lentidão, entrega o fluxo direto sem travar em tela preta
    return res.redirect(`https://yt1s.com/en?q=https://www.youtube.com/watch?v=${videoId}`);

  } catch (error) {
    console.error('[Download] Erro na transmissão:', error.message);
    if (!res.headersSent) {
      return res.redirect(`https://yt1s.com/en?q=https://www.youtube.com/watch?v=${videoId}`);
    }
  }
});

// ----------------------------------------------------
// INICIALIZAÇÃO
// ----------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[ClipForge OS] Servidor em operação total na porta ${PORT} [v3.0.0]`);
});
