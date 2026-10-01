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

// Libera cabeçalhos essenciais para o Blob do frontend ler o arquivo MP4
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
app.get('/', (req, res) => res.json({ status: 'online', versao: '3.5.0-DIRECT-BLOB' }));
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
// SISTEMA DE PAGAMENTO PIX (MERCADO PAGO)
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
// RESOLUÇÃO DE STREAM DIRETO DO VÍDEO (MULTI-ENGINE)
// ----------------------------------------------------
async function resolverUrlDiretaVideo(videoId) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // 1. Instâncias Cobalt (API v10 sem bloqueio de IP)
  const cobaltNodes = [
    'https://api.cobalt.tools',
    'https://cobalt-api.kwiatekm.tokyo',
    'https://api.server.cobalt.tools'
  ];

  for (const node of cobaltNodes) {
    try {
      const resp = await axios.post(node, {
        url: videoUrl,
        videoQuality: '360',
        downloadMode: 'auto'
      }, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: 8000
      });

      if (resp.data?.url) return resp.data.url;
    } catch (e) {}
  }

  // 2. Consulta RapidAPI Cloud Hub (com suporte a formatos combinados de áudio e vídeo)
  try {
    const resRapid = await axios.get(`https://${RAPIDAPI_HOST}/download`, {
      params: { id: videoId },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      },
      timeout: 9000
    });

    const d = resRapid.data;
    if (d?.url && !d.url.includes('ytimg.com')) return d.url;
    if (d?.download_url && !d.download_url.includes('ytimg.com')) return d.download_url;

    if (Array.isArray(d?.formats)) {
      const progressive = d.formats.find(f => f.url && !f.url.includes('ytimg.com') && (f.hasAudio !== false && f.hasVideo !== false))
                       || d.formats.find(f => f.url && !f.url.includes('ytimg.com') && f.qualityLabel === '360p')
                       || d.formats.find(f => f.url && !f.url.includes('ytimg.com'));
      if (progressive?.url) return progressive.url;
    }
  } catch (e) {}

  // 3. CDNs Abertas Piped / Invidious
  const invidiousNodes = [
    `https://inv.nadeko.net/api/v1/videos/${videoId}`,
    `https://invidious.nerdvpn.de/api/v1/videos/${videoId}`,
    `https://pipedapi.kavin.rocks/streams/${videoId}`
  ];

  for (const nodeUrl of invidiousNodes) {
    try {
      const invResp = await axios.get(nodeUrl, { timeout: 7000 });
      const streams = invResp.data?.formatStreams || invResp.data?.videoStreams || [];
      const chosen = streams.find(s => s.url && s.videoOnly === false) || streams[0];
      if (chosen?.url) return chosen.url;
    } catch (e) {}
  }

  return null;
}

// ----------------------------------------------------
// DOWNLOAD DIRETO BINÁRIO PARA O BLOB DO FRONTEND
// ----------------------------------------------------
app.get('/api/download', async (req, res) => {
  const videoId = req.query.id;
  const start = parseInt(req.query.start || 0, 10);

  if (!videoId || videoId.length < 5) {
    return res.status(400).json({ error: 'ID do vídeo inválido.' });
  }

  try {
    const directStreamUrl = await resolverUrlDiretaVideo(videoId);

    // Se nenhum motor responder, devolve 503 JSON puro para o frontend avisar e estornar os pontos
    if (!directStreamUrl) {
      return res.status(503).json({ error: 'Servidores temporariamente ocupados.' });
    }

    // Faz o stream direto em binário para o navegador
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

    // Cancela o stream se o usuário fechar a aba
    req.on('close', () => {
      if (responseStream.data && typeof responseStream.data.destroy === 'function') {
        responseStream.data.destroy();
      }
    });

    return responseStream.data.pipe(res);

  } catch (error) {
    console.error('[Download] Falha no streaming:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Falha temporária na transferência do vídeo.' });
    }
  }
});

// ----------------------------------------------------
// INICIALIZAÇÃO DO SERVIDOR
// ----------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[ClipForge Core] Servidor operacional na porta ${PORT} [v3.5.0]`);
});
