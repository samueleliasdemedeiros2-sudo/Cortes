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
app.get('/', (req, res) => res.json({ status: 'online', versao: '3.2.0-DIRECT-STREAM' }));
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
// MOTOR DE EXTRAÇÃO DIRETA (BUSCA O LINK MP4 REAL)
// ----------------------------------------------------
async function resolverUrlDiretaVideo(videoId) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // 1. Cobalt API (v10 protocol)
  const cobaltEndpoints = [
    'https://api.cobalt.tools',
    'https://cobalt-api.kwiatekm.tokyo',
    'https://api.server.cobalt.tools'
  ];

  for (const endpoint of cobaltEndpoints) {
    try {
      const cobaltResp = await axios.post(endpoint, {
        url: videoUrl,
        videoQuality: '360',
        downloadMode: 'auto'
      }, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        timeout: 9000
      });

      if (cobaltResp.data?.url) {
        return cobaltResp.data.url;
      }
    } catch (e) {}
  }

  // 2. RapidAPI Cloud Hub
  try {
    const rapidResp = await axios.get(`https://${RAPIDAPI_HOST}/download`, {
      params: { id: videoId },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      },
      timeout: 10000
    });

    const data = rapidResp.data;
    if (data?.url && !data.url.includes('ytimg.com')) return data.url;
    if (Array.isArray(data?.formats)) {
      const formatoValido = data.formats.find(f => f.url && !f.url.includes('ytimg.com') && f.hasAudio !== false)
                         || data.formats.find(f => f.url && !f.url.includes('ytimg.com'));
      if (formatoValido?.url) return formatoValido.url;
    }
  } catch (e) {}

  // 3. Invidious Open Video Stream CDNs
  const invidiousInstances = [
    `https://inv.nadeko.net/api/v1/videos/${videoId}`,
    `https://invidious.nerdvpn.de/api/v1/videos/${videoId}`,
    `https://pipedapi.kavin.rocks/streams/${videoId}`
  ];

  for (const urlInstance of invidiousInstances) {
    try {
      const invResp = await axios.get(urlInstance, { timeout: 7000 });
      const streams = invResp.data?.formatStreams || invResp.data?.videoStreams || [];
      const progressive = streams.find(s => s.url && s.videoOnly === false) || streams[0];
      if (progressive?.url) return progressive.url;
    } catch (e) {}
  }

  return null;
}

// ----------------------------------------------------
// DOWNLOAD DIRETO (TRANSMISSÃO BINÁRIA SEM REDIRECIONAMENTOS)
// ----------------------------------------------------
app.get('/api/download', async (req, res) => {
  const videoId = req.query.id;
  const start = parseInt(req.query.start || 0, 10);

  if (!videoId || videoId.length < 5) {
    return res.status(400).send('ID do vídeo inválido.');
  }

  try {
    const directStreamUrl = await resolverUrlDiretaVideo(videoId);

    if (!directStreamUrl) {
      // Retorna uma resposta limpa sem redirecionar para sites de terceiros
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(503).send(`
        <body style="background:#020617;color:#fff;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
          <div style="background:#0f172a;border:1px solid #1e293b;border-radius:20px;padding:28px;text-align:center;max-width:360px;">
            <h3 style="color:#c084fc;margin:0 0 10px 0;">Servidores Ocupados</h3>
            <p style="font-size:13px;color:#94a3b8;line-height:1.5;">Não foi possível obter o fluxo de vídeo no momento. Tente novamente em 20 segundos.</p>
            <a href="javascript:history.back()" style="display:inline-block;margin-top:14px;background:#9333ea;color:#fff;padding:10px 22px;border-radius:10px;text-decoration:none;font-weight:600;font-size:13px;">Voltar</a>
          </div>
        </body>
      `);
    }

    // Faz o streaming direto do binário MP4 para o cliente
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

    // Se o cliente fechar o navegador antes de terminar, encerra a requisição do stream
    req.on('close', () => {
      if (responseStream.data && typeof responseStream.data.destroy === 'function') {
        responseStream.data.destroy();
      }
    });

    return responseStream.data.pipe(res);

  } catch (error) {
    console.error('[Download] Erro na transmissão do arquivo:', error.message);
    if (!res.headersSent) {
      res.status(500).send('Erro temporário ao transferir o arquivo. Tente novamente.');
    }
  }
});

// ----------------------------------------------------
// ARRANQUE
// ----------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[ClipForge Core] Servidor em operação na porta ${PORT} [v3.2.0]`);
});
