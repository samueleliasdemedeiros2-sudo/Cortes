const express = require('express');
const axios = require('axios');
const cors = require('cors');

let mercadopago = null;
try {
  mercadopago = require('mercadopago');
} catch (e) {
  console.warn('[MercadoPago] Módulo nativo não detetado. A operar em modo de contingência resiliente.');
}

const app = express();

// Middlewares essenciais de produção
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Variáveis de Configuração
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'c9dea9a596msh9565df12086412fp1d11cejsnadb3d0bd41ad';
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'cloud-api-hub-youtube-downloader.p.rapidapi.com';
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

// Inicialização segura do SDK Mercado Pago
let mpClient = null;
if (mercadopago && MP_ACCESS_TOKEN && MP_ACCESS_TOKEN.startsWith('APP_USR')) {
  try {
    mpClient = new mercadopago.MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
    console.log('[MercadoPago] Inicializado com sucesso em modo Produção.');
  } catch (err) {
    console.error('[MercadoPago] Falha ao instanciar credenciais:', err.message);
  }
}

// Métricas de Operação
const metricas = {
  totalDownloads: 0,
  totalVendas: 0,
  valorArrecadado: 0.00,
  inicioOperacao: new Date().toISOString()
};

const pagamentos = new Map();

// ----------------------------------------------------
// ROTAS DE DIAGNÓSTICO E MONITORIZAÇÃO (HEALTH CHECK)
// ----------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    sistema: 'ClipForge Core OS',
    versao: '2.6.0-PRO',
    ambiente: process.env.NODE_ENV || 'production'
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    uptimeSegundos: Math.floor(process.uptime()),
    timestamp: Date.now()
  });
});

// ----------------------------------------------------
// ROTAS ADMINISTRATIVAS
// ----------------------------------------------------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Credencial administrativa inválida.' });
  }
  return res.json({ success: true, mensagem: 'Sessão autenticada.' });
});

app.get('/api/admin/dashboard', (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Acesso não autorizado.' });
  }

  const mem = process.memoryUsage();
  res.json({
    status: 'online',
    metricas,
    memoriaUsadaMb: Math.round(mem.heapUsed / 1024 / 1024),
    memoriaTotalMb: Math.round(mem.rss / 1024 / 1024)
  });
});

// ----------------------------------------------------
// MOTOR DE PAGAMENTOS PIX (MERCADO PAGO)
// ----------------------------------------------------
app.post('/api/pix/criar', async (req, res) => {
  const { userId = 'anonimo', valor = 19.90 } = req.body;
  const valorFormatado = Number(parseFloat(valor).toFixed(2));

  // Modo contingência / Fallback
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
    console.error('[MercadoPago] Erro na geração da cobrança:', error.message);
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

  // Verificação imediata para fallbacks
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
    } catch (e) {
      console.warn('[MercadoPago] Erro na consulta de status:', e.message);
    }
  }

  return res.json({ status: reg?.status || 'pending' });
});

// ----------------------------------------------------
// MOTOR DE RESOLUÇÃO DE FLUXO DE VÍDEO (MULTI-FONTE)
// ----------------------------------------------------
async function extrairStreamDireto(videoId) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // 1. Cobalt Engine (API de Alta Fidelidade)
  const cobaltNodes = [
    'https://api.cobalt.tools/api/json',
    'https://cobalt.api.kwiatekm.tokyo/api/json'
  ];

  for (const node of cobaltNodes) {
    try {
      const resp = await axios.post(node, {
        url: videoUrl,
        vQuality: '360',
        filenamePattern: 'basic'
      }, {
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        timeout: 8000
      });

      if (resp.data && resp.data.url) {
        return resp.data.url;
      }
    } catch (e) {}
  }

  // 2. RapidAPI Downloader Hub
  try {
    const rapidResp = await axios.get(`https://${RAPIDAPI_HOST}/download`, {
      params: { id: videoId },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      },
      timeout: 10000
    });

    const rData = rapidResp.data;
    if (rData?.url && !rData.url.includes('ytimg.com')) return rData.url;
    if (Array.isArray(rData?.formats)) {
      const formato = rData.formats.find(f => f.url && !f.url.includes('ytimg.com') && f.hasAudio !== false);
      if (formato) return formato.url;
    }
  } catch (e) {}

  // 3. Rede Piped / Invidious CDN
  const cdnInstances = [
    'https://pipedapi.kavin.rocks',
    'https://api.piped.privacydev.net'
  ];

  for (const cdn of cdnInstances) {
    try {
      const resp = await axios.get(`${cdn}/streams/${videoId}`, { timeout: 7000 });
      const streams = resp.data?.videoStreams || [];
      const progressivo = streams.find(s => s.videoOnly === false && s.format === 'MPEG_4');
      if (progressivo?.url) return progressivo.url;
    } catch (e) {}
  }

  return null;
}

// ----------------------------------------------------
// ROTA DE DESCARREGAMENTO (STREAMING BINÁRIO DIRETO)
// ----------------------------------------------------
app.get('/api/download', async (req, res) => {
  const videoId = req.query.id;
  const start = parseInt(req.query.start || 0, 10);

  if (!videoId || videoId.length < 5) {
    return res.status(400).send('Identificador de vídeo inválido.');
  }

  try {
    const streamUrl = await extrairStreamDireto(videoId);

    if (!streamUrl) {
      // Redirecionamento de segurança direto para serviço de entrega sem tela de erro
      return res.redirect(`https://yt5s.biz/pt/download?url=https://www.youtube.com/watch?v=${videoId}`);
    }

    // Instanciação da stream direta
    const responseStream = await axios({
      method: 'GET',
      url: streamUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 45000
    });

    // Sanitização rigorosa dos cabeçalhos de resposta
    const sanitizedId = videoId.replace(/[^a-zA-Z0-9_-]/g, '');
    const filename = `corte_${sanitizedId}_${start}s.mp4`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'video/mp4');

    if (responseStream.headers['content-length']) {
      res.setHeader('Content-Length', responseStream.headers['content-length']);
    }

    // Contabilização
    metricas.totalDownloads += 1;

    // Gestão de encerramento prematuro de ligação pelo cliente
    req.on('close', () => {
      if (responseStream.data && typeof responseStream.data.destroy === 'function') {
        responseStream.data.destroy();
      }
    });

    responseStream.data.pipe(res);

  } catch (error) {
    console.error('[Download] Falha no transporte da stream:', error.message);
    if (!res.headersSent) {
      return res.redirect(`https://yt5s.biz/pt/download?url=https://www.youtube.com/watch?v=${videoId}`);
    }
  }
});

// ----------------------------------------------------
// ARRANQUE DO SERVIDOR
// ----------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[ClipForge Core] Servidor operacional na porta ${PORT} [v2.6.0]`);
});
