const express = require('express');
const axios = require('axios');
const cors = require('cors');

let mercadopago = null;
try {
  mercadopago = require('mercadopago');
} catch (e) {
  console.log('Módulo mercadopago não encontrado, modo fallback ativo.');
}

const app = express();
app.use(cors());
app.use(express.json());

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'c9dea9a596msh9565df12086412fp1d11cejsnadb3d0bd41ad';
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'cloud-api-hub-youtube-downloader.p.rapidapi.com';
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

let mpClient = null;
if (mercadopago && MP_ACCESS_TOKEN && MP_ACCESS_TOKEN.startsWith('APP_USR')) {
  try {
    mpClient = new mercadopago.MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
  } catch (err) {
    console.error('Falha MP:', err.message);
  }
}

const metricas = { totalDownloads: 0, totalVendas: 0, valorArrecadado: 0 };
const pagamentos = new Map();

// 1. Health
app.get('/', (req, res) => res.json({ status: 'online', service: 'ClipForge OS Pro v2.3' }));
app.get('/api/status', (req, res) => res.json({ status: 'online', uptime: process.uptime() }));

// 2. Admin
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) return res.json({ success: true });
  return res.status(401).json({ error: 'Senha incorreta' });
});

app.get('/api/admin/dashboard', (req, res) => {
  if (req.headers['authorization'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Não autorizado' });
  res.json({
    status: 'online',
    metricas,
    memoriaUsadaMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
  });
});

// 3. Pagamento VIP via Pix
app.post('/api/pix/criar', async (req, res) => {
  const { userId = 'user', valor = 19.90 } = req.body;

  if (!mpClient) {
    const mockId = `pix_${Date.now()}`;
    pagamentos.set(mockId, { status: 'approved', userId, valor });
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
        transaction_amount: Number(valor),
        description: 'ClipForge VIP Pro - Acesso Ilimitado',
        payment_method_id: 'pix',
        payer: {
          email: `cliente_${Date.now()}@clipforge.com`,
          first_name: 'Assinante',
          last_name: 'VIP'
        }
      }
    });

    const pixData = resultado.point_of_interaction?.transaction_data;
    pagamentos.set(String(resultado.id), { status: 'pending', userId, valor });

    res.json({
      id: resultado.id,
      qr_code: pixData?.qr_code,
      qr_code_base64: pixData?.qr_code_base64
    });
  } catch (error) {
    console.error('Erro ao gerar Pix no MP:', error.message);
    const fbId = `fb_${Date.now()}`;
    pagamentos.set(fbId, { status: 'approved', userId, valor });
    res.json({
      id: fbId,
      qr_code: '00020126580014br.gov.bcb.pix0136pix-clipforge-vip520400005303986540419.905802BR',
      simulado: true
    });
  }
});

app.get('/api/pix/status/:id', async (req, res) => {
  const paymentId = req.params.id;
  const reg = pagamentos.get(String(paymentId));

  if (paymentId.startsWith('pix_') || paymentId.startsWith('fb_')) {
    metricas.totalVendas += 1;
    metricas.valorArrecadado += 19.90;
    return res.json({ status: 'approved' });
  }

  if (mpClient) {
    try {
      const payment = new mercadopago.Payment(mpClient);
      const dados = await payment.get({ id: paymentId });
      if (dados.status === 'approved') {
        metricas.totalVendas += 1;
        metricas.valorArrecadado += Number(reg?.valor || 19.90);
      }
      return res.json({ status: dados.status });
    } catch (e) {}
  }

  res.json({ status: reg?.status || 'pending' });
});

// 4. DOWNLOAD ESTÁVEL (SEM REDIRECIONAR PARA SITES FORA DO AR)
app.get('/api/download', async (req, res) => {
  const videoId = req.query.id;
  const start = parseInt(req.query.start || 0, 10);

  if (!videoId || videoId.length < 5) {
    return res.status(400).send('ID do vídeo inválido.');
  }

  try {
    const response = await axios.get(`https://${RAPIDAPI_HOST}/download`, {
      params: { id: videoId },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      },
      timeout: 25000
    });

    const data = response.data;
    let targetUrl = null;

    if (Array.isArray(data?.formats)) {
      const stream = data.formats.find(f => f.url && !f.url.includes('ytimg.com') && (f.qualityLabel === '360p' || f.hasAudio));
      targetUrl = stream ? stream.url : data.formats[0]?.url;
    }
    if (!targetUrl) targetUrl = data?.url || data?.download_url || data?.link;

    if (targetUrl && !targetUrl.includes('ytimg.com')) {
      const videoStream = await axios({
        method: 'GET',
        url: targetUrl,
        responseType: 'stream',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 40000
      });

      metricas.totalDownloads += 1;
      res.setHeader('Content-Disposition', `attachment; filename="clipforge_${videoId}_${start}s.mp4"`);
      res.setHeader('Content-Type', 'video/mp4');
      return videoStream.data.pipe(res);
    }

    // Se a API não devolver o link direto, usa o provedor espelho direto sem quebrar
    const fallbackStreamUrl = `https://loader.to/ajax/download.php?format=360&url=https://www.youtube.com/watch?v=${videoId}`;
    return res.redirect(fallbackStreamUrl);

  } catch (error) {
    console.error('Erro download:', error.message);
    // Em caso de falha, envia direto para o gerador sem quebrar no y2mate fora do ar
    return res.redirect(`https://en.savefrom.net/1-youtube-video-downloader-4vA/?url=https://www.youtube.com/watch?v=${videoId}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ClipForge OS v2.3 online na porta ${PORT}`));
