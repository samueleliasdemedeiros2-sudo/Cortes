const express = require('express');
const axios = require('axios');
const cors = require('cors');

let mercadopago = null;
try {
  mercadopago = require('mercadopago');
} catch (e) {
  console.warn('[MercadoPago] Módulo em contingência.');
}

const app = express();

app.use(cors({ 
  origin: '*', 
  exposedHeaders: ['Content-Disposition', 'Content-Length'] 
}));
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
app.get('/', (req, res) => res.json({ status: 'online', versao: '3.6.0-RAPID-FOCUS' }));
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
// MOTOR EXCLUSIVO RAPIDAPI COM PARÂMETROS CORRETOS
> // ----------------------------------------------------
async function resolverUrlDiretaVideo(videoId) {
  const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // 1. Tenta varrer a RapidAPI por ID
  try {
    const resp = await axios.get(`https://${RAPIDAPI_HOST}/download`, {
      params: { id: videoId },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      },
      timeout: 15000
    });

    const data = resp.data;
    if (data?.url && !data.url.includes('ytimg.com')) return data.url;
    if (data?.download_url && !data.download_url.includes('ytimg.com')) return data.download_url;
    if (data?.link && !data.link.includes('ytimg.com')) return data.link;

    if (Array.isArray(data?.formats)) {
      const best = data.formats.find(f => f.url && !f.url.includes('ytimg.com') && f.hasAudio !== false)
                || data.formats.find(f => f.url && !f.url.includes('ytimg.com'));
      if (best?.url) return best.url;
    }
  } catch (e) {}

  // 2. Tenta varrer a RapidAPI passando a URL completa
  try {
    const respUrl = await axios.get(`https://${RAPIDAPI_HOST}/download`, {
      params: { url: targetUrl },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      },
      timeout: 15000
    });

    const data2 = respUrl.data;
    if (data2?.url && !data2.url.includes('ytimg.com')) return data2.url;
    if (data2?.download_url && !data2.download_url.includes('ytimg.com')) return data2.download_url;
    
    if (Array.isArray(data2?.formats)) {
      const best2 = data2.formats.find(f => f.url && !f.url.includes('ytimg.com') && f.hasAudio !== false);
      if (best2?.url) return best2.url;
    }
  } catch (e) {}

  // 3. Fallback de Contingência Direta (Cobalt Oficial)
  try {
    const cResp = await axios.post('https://api.cobalt.tools', {
      url: targetUrl,
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
// DOWNLOAD DIRETO BINÁRIO
// ----------------------------------------------------
app.get('/api/download', async (req, res) => {
  const videoId = req.query.id;
  const start = parseInt(req.query.start || 0, 10);

  if (!videoId || videoId.length < 5) {
    return res.status(400).json({ error: 'ID do vídeo inválido.' });
  }

  try {
    const directStreamUrl = await resolverUrlDiretaVideo(videoId);

    if (!directStreamUrl) {
      return res.status(503).json({ error: 'Servidores temporariamente ocupados.' });
    }

    const responseStream = await axios({
      method: 'GET',
      url: directStreamUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 50000
    });

    const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '');
    res.setHeader('Content-Disposition', `attachment; filename="corte_${safeId}_${start}s.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');

    if (responseStream.headers['content-length']) {
      res.setHeader('Content-Length', responseStream.headers['content-length']);
    }

    metricas.totalDownloads += 1;

    req.on('close', () => {
      if (responseStream.data && typeof responseStream.data.destroy === 'function') {
        responseStream.data.destroy();
      }
    });

    return responseStream.data.pipe(res);

  } catch (error) {
    console.error('[Download] Erro na transmissão:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Falha temporária na transferência do vídeo.' });
    }
  }
});

// ----------------------------------------------------
// INICIALIZAÇÃO
// ----------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[ClipForge Core] Servidor operacional na porta ${PORT} [v3.6.0]`);
});
