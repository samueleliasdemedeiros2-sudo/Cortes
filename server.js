const express = require('express');
const axios = require('axios');
const cors = require('cors');

let mercadopago = null;
try {
  mercadopago = require('mercadopago');
} catch (e) {
  console.warn('[MercadoPago] Módulo nativo não instalado.');
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
    console.error('[MercadoPago] Erro de configuração:', err.message);
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
app.get('/', (req, res) => res.json({ status: 'online', versao: '3.1.0-POLL-PRO' }));
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
// MOTOR DE DOWNLOAD COM POLLING AUTOMÁTICO (SEM REDIRECTS QUEBRADOS)
// ----------------------------------------------------
async function resolverMp4ComPolling(videoId) {
  const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // 1. Inicia conversão na RapidAPI
  try {
    const initResp = await axios.get(`https://${RAPIDAPI_HOST}/ajax/download.php`, {
      params: { url: targetUrl, format: '360' },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      },
      timeout: 10000
    });

    const initData = initResp.data;

    // Se já veio pronto
    if (initData?.download_url) return initData.download_url;

    // Se devolveu progress_url, faz polling até 6 segundos
    if (initData?.progress_url) {
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 1200));
        const check = await axios.get(initData.progress_url, { timeout: 6000 });
        if (check.data?.download_url) {
          return check.data.download_url;
        }
      }
    }
  } catch (e) {}

  // 2. Consulta pelo endpoint direto padrão (/download)
  try {
    const r2 = await axios.get(`https://${RAPIDAPI_HOST}/download`, {
      params: { id: videoId },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      },
      timeout: 10000
    });

    const d2 = r2.data;
    if (d2?.url && !d2.url.includes('ytimg.com')) return d2.url;
    if (Array.isArray(d2?.formats)) {
      const f = d2.formats.find(x => x.url && !x.url.includes('ytimg.com') && x.hasAudio !== false) || d2.formats[0];
      if (f?.url) return f.url;
    }
  } catch (e) {}

  // 3. Consulta em nós Invidious estáveis (CDN Direta)
  const invidiousNodes = [
    `https://inv.nadeko.net/api/v1/videos/${videoId}`,
    `https://invidious.nerdvpn.de/api/v1/videos/${videoId}`
  ];

  for (const node of invidiousNodes) {
    try {
      const resNode = await axios.get(node, { timeout: 6000 });
      const formatStreams = resNode.data?.formatStreams || [];
      const best = formatStreams.find(s => s.resolution === '360p' || s.resolution === '720p') || formatStreams[0];
      if (best?.url) return best.url;
    } catch (e) {}
  }

  return null;
}

// ----------------------------------------------------
// ROTA DE DOWNLOAD FINAL: TRANSMISSÃO DIRETA DO MP4
// ----------------------------------------------------
app.get('/api/download', async (req, res) => {
  const videoId = req.query.id;
  const start = parseInt(req.query.start || 0, 10);

  if (!videoId || videoId.length < 5) {
    return res.status(400).send('ID do vídeo inválido.');
  }

  try {
    const directMp4Url = await resolverMp4ComPolling(videoId);

    if (!directMp4Url) {
      // Se demorar muito, em vez de 404 em site chinês, faz o download seguro via CDN direta
      return res.redirect(`https://api.vevioz.com/apis/widget?url=https://www.youtube.com/watch?v=${videoId}`);
    }

    // Faz o streaming direto do binário MP4 para o celular do usuário
    const videoStream = await axios({
      method: 'GET',
      url: directMp4Url,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 45000
    });

    const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '');
    res.setHeader('Content-Disposition', `attachment; filename="corte_${safeId}_${start}s.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');

    if (videoStream.headers['content-length']) {
      res.setHeader('Content-Length', videoStream.headers['content-length']);
    }

    metricas.totalDownloads += 1;

    req.on('close', () => {
      if (videoStream.data && typeof videoStream.data.destroy === 'function') {
        videoStream.data.destroy();
      }
    });

    return videoStream.data.pipe(res);

  } catch (error) {
    console.error('[Download] Falha no streaming:', error.message);
    if (!res.headersSent) {
      return res.redirect(`https://api.vevioz.com/apis/widget?url=https://www.youtube.com/watch?v=${videoId}`);
    }
  }
});

// ----------------------------------------------------
// ARRANQUE DO SERVIDOR
// ----------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[ClipForge] Sistema operacional pronto na porta ${PORT} [v3.1.0]`);
});
