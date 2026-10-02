const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  GoogleGenAI,
  createUserContent,
  createPartFromUri
} = require('@google/genai');

let mercadopago = null;

try {
  mercadopago = require('mercadopago');
} catch (error) {
  console.warn(
    '[MercadoPago] Módulo não disponível.'
  );
}

// ============================================================
// APP
// ============================================================

const app = express();

app.use(
  cors({
    origin: '*',
    exposedHeaders: [
      'Content-Disposition',
      'Content-Length'
    ]
  })
);

app.use(
  express.json({
    limit: '10mb'
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

// ============================================================
// CONFIGURAÇÕES
// ============================================================

const PORT =
  process.env.PORT || 3000;

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || '';

const GEMINI_MODEL =
  process.env.GEMINI_MODEL ||
  'gemini-3.6-flash';

const RAPIDAPI_KEY =
  process.env.RAPIDAPI_KEY || '';

const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST ||
  'cloud-api-hub-youtube-downloader.p.rapidapi.com';

const MP_ACCESS_TOKEN =
  process.env.MP_ACCESS_TOKEN || '';

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || 'samuel123';

// ============================================================
// GEMINI
// ============================================================

let gemini = null;

if (GEMINI_API_KEY) {
  try {
    gemini =
      new GoogleGenAI({
        apiKey: GEMINI_API_KEY
      });

    console.log(
      `[Gemini] Cliente iniciado. Modelo: ${GEMINI_MODEL}`
    );

  } catch (error) {

    console.error(
      '[Gemini] Erro ao iniciar:',
      error.message
    );
  }

} else {

  console.warn(
    '[Gemini] GEMINI_API_KEY não configurada.'
  );
}

// ============================================================
// MERCADO PAGO
// ============================================================

let mpClient = null;

if (
  mercadopago &&
  MP_ACCESS_TOKEN &&
  MP_ACCESS_TOKEN.startsWith('APP_USR')
) {

  try {

    mpClient =
      new mercadopago.MercadoPagoConfig({
        accessToken:
          MP_ACCESS_TOKEN
      });

    console.log(
      '[MercadoPago] Cliente iniciado.'
    );

  } catch (error) {

    console.error(
      '[MercadoPago] Erro:',
      error.message
    );
  }

} else {

  console.warn(
    '[MercadoPago] Cliente não configurado.'
  );
}

// ============================================================
// MÉTRICAS
// ============================================================

const metricas = {

  totalDownloads: 0,

  totalVendas: 0,

  totalAnalises: 0,

  valorArrecadado: 0,

  inicioOperacao:
    new Date().toISOString()
};

const pagamentos =
  new Map();

// ============================================================
// UTILITÁRIOS
// ============================================================

function sleep(ms) {

  return new Promise(
    resolve => {
      setTimeout(
        resolve,
        ms
      );
    }
  );
}

// ============================================================
// EXTRAIR ID DO YOUTUBE
// ============================================================

function extrairVideoId(url) {

  if (
    !url ||
    typeof url !== 'string'
  ) {
    return null;
  }

  const regExp =
    /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=|shorts\/)|youtu\.be\/)([^"&?\/\s]{11})/;

  const match =
    url
      .trim()
      .match(regExp);

  return match
    ? match[1]
    : null;
}

// ============================================================
// LIMPAR JSON GEMINI
// ============================================================

function limparJsonGemini(texto) {

  if (!texto) {
    return null;
  }

  let textoLimpo =
    String(texto).trim();

  textoLimpo =
    textoLimpo
      .replace(
        /^```json\s*/i,
        ''
      )
      .replace(
        /^```\s*/i,
        ''
      )
      .replace(
        /\s*```$/i,
        ''
      )
      .trim();

  try {

    return JSON.parse(
      textoLimpo
    );

  } catch (error) {}

  const inicio =
    textoLimpo.indexOf('{');

  const fim =
    textoLimpo.lastIndexOf('}');

  if (
    inicio !== -1 &&
    fim !== -1 &&
    fim > inicio
  ) {

    try {

      return JSON.parse(
        textoLimpo.substring(
          inicio,
          fim + 1
        )
      );

    } catch (error) {}
  }

  return null;
}

// ============================================================
// LIMITAR NÚMEROS
// ============================================================

function limitarNumero(
  valor,
  minimo,
  maximo,
  padrao
) {

  const numero =
    Number(valor);

  if (
    !Number.isFinite(numero)
  ) {
    return padrao;
  }

  return Math.min(
    maximo,
    Math.max(
      minimo,
      numero
    )
  );
}

// ============================================================
// REMOVER ARQUIVO TEMPORÁRIO
// ============================================================

function apagarArquivo(
  arquivo
) {

  if (
    arquivo &&
    fs.existsSync(arquivo)
  ) {

    try {

      fs.unlinkSync(
        arquivo
      );

      console.log(
        '[Arquivo] Temporário removido.'
      );

    } catch (error) {

      console.warn(
        '[Arquivo] Não foi possível remover:',
        error.message
      );
    }
  }
}

// ============================================================
// STATUS
// ============================================================

app.get(
  '/',
  (req, res) => {

    res.json({

      status:
        'online',

      versao:
        '10.1.0-GEMINI-AI'
    });
  }
);

app.get(
  '/api/status',
  (req, res) => {

    res.json({

      status:
        'online',

      uptime:
        Math.floor(
          process.uptime()
        ),

      gemini:
        Boolean(gemini),

      modeloGemini:
        GEMINI_MODEL,

      rapidapi:
        Boolean(RAPIDAPI_KEY),

      mercadoPago:
        Boolean(mpClient)
    });
  }
);

// ============================================================
// ADMIN
// ============================================================

app.post(
  '/api/admin/login',
  (req, res) => {

    const {
      password
    } = req.body;

    // CORRIGIDO:
    // antes estava password !== samuel123
    if (
      !password ||
      password !== ADMIN_PASSWORD
    ) {

      return res.status(401).json({

        error:
          'Credencial inválida.'
      });
    }

    return res.json({

      success:
        true
    });
  }
);

app.get(
  '/api/admin/dashboard',
  (req, res) => {

    if (
      req.headers.authorization !==
      ADMIN_PASSWORD
    ) {

      return res.status(401).json({

        error:
          'Não autorizado.'
      });
    }

    const memoria =
      process.memoryUsage();

    return res.json({

      status:
        'online',

      metricas,

      memoriaUsadaMb:
        Math.round(
          memoria.heapUsed /
          1024 /
          1024
        )
    });
  }
);

// ============================================================
// RAPIDAPI
// ============================================================

async function extrairStreamOficial(
  videoId
) {

  if (!RAPIDAPI_KEY) {

    throw new Error(
      'RAPIDAPI_KEY não configurada no Render.'
    );
  }

  try {

    console.log(
      `[RapidAPI] Obtendo vídeo ${videoId}...`
    );

    const response =
      await axios.get(
        `https://${RAPIDAPI_HOST}/download`,
        {

          params: {

            id:
              videoId,

            quality:
              'lowest',

            filter:
              'audioandvideo'
          },

          headers: {

            'x-rapidapi-key':
              RAPIDAPI_KEY,

            'x-rapidapi-host':
              RAPIDAPI_HOST,

            'User-Agent':
              'Mozilla/5.0'
          },

          timeout:
            30000
        }
      );

    const data =
      response.data;

    // ========================================================
    // FORMATS
    // ========================================================

    if (
      Array.isArray(
        data?.formats
      )
    ) {

      const formatos =
        data.formats.filter(
          item =>
            item?.url &&
            !item.url.includes(
              'ytimg.com'
            )
        );

      // Primeiro tenta áudio + vídeo
      const formatoCompleto =
        formatos.find(
          item =>
            item.hasAudio !== false &&
            item.hasVideo !== false
        );

      if (
        formatoCompleto?.url
      ) {

        console.log(
          '[RapidAPI] Stream encontrado em formats[].'
        );

        return formatoCompleto.url;
      }

      // Fallback para qualquer formato com URL
      if (
        formatos[0]?.url
      ) {

        console.log(
          '[RapidAPI] Usando primeiro formato disponível.'
        );

        return formatos[0].url;
      }
    }

    // ========================================================
    // URL DIRETA
    // ========================================================

    if (
      typeof data?.url === 'string' &&
      data.url.length > 20 &&
      !data.url.includes(
        'ytimg.com'
      )
    ) {

      console.log(
        '[RapidAPI] Stream encontrado em url.'
      );

      return data.url;
    }

    // ========================================================
    // DOWNLOAD URL
    // ========================================================

    if (
      typeof data?.download_url === 'string' &&
      data.download_url.length > 20
    ) {

      console.log(
        '[RapidAPI] Stream encontrado em download_url.'
      );

      return data.download_url;
    }

    console.error(
      '[RapidAPI] Nenhum stream encontrado.'
    );

    return null;

  } catch (error) {

    console.error(
      '[RapidAPI Error]',
      error.response?.data ||
      error.message
    );

    return null;
  }
}

// ============================================================
// BAIXAR VÍDEO TEMPORÁRIO
// ============================================================

async function baixarVideoTemporario(
  videoUrl
) {

  const arquivo =
    path.join(
      os.tmpdir(),
      `clipforge_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2)}.mp4`
    );

  console.log(
    '[Download] Baixando vídeo para análise...'
  );

  console.log(
    '[Download] Tentando conexão com o stream...'
  );

  try {

    const response =
      await axios.get(
        videoUrl,
        {

          responseType:
            'stream',

          timeout:
            180000,

          maxContentLength:
            300 *
            1024 *
            1024,

          maxBodyLength:
            300 *
            1024 *
            1024,

          maxRedirects:
            10,

          headers: {

            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',

            'Accept':
              'video/mp4,video/*,*/*;q=0.8',

            'Accept-Language':
              'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',

            'Referer':
              'https://www.youtube.com/'
          },

          validateStatus:
            status =>
              status >= 200 &&
              status < 300
        }
      );

    await new Promise(
      (resolve, reject) => {

        const writer =
          fs.createWriteStream(
            arquivo
          );

        response.data.pipe(
          writer
        );

        writer.on(
          'finish',
          resolve
        );

        writer.on(
          'error',
          reject
        );

        response.data.on(
          'error',
          reject
        );
      }
    );

    const stats =
      fs.statSync(
        arquivo
      );

    if (
      !stats.size ||
      stats.size < 1000
    ) {

      throw new Error(
        'O vídeo baixado está vazio ou inválido.'
      );
    }

    console.log(
      `[Download] Vídeo salvo: ${Math.round(
        stats.size /
        1024 /
        1024
      )} MB`
    );

    return arquivo;

  } catch (error) {

    apagarArquivo(
      arquivo
    );

    const status =
      error?.response?.status;

    console.error(
      '[Download Error]',
      status
        ? `HTTP ${status}`
        : error.message
    );

    if (
      status === 403
    ) {

      throw new Error(
        'O servidor do vídeo recusou o download (HTTP 403).'
      );
    }

    if (
      status === 404
    ) {

      throw new Error(
        'O stream do vídeo não está mais disponível (HTTP 404).'
      );
    }

    throw new Error(
      `Falha ao baixar o vídeo: ${error.message}`
    );
  }
}

// ============================================================
// GEMINI - PROCESSAR ARQUIVO
// ============================================================

async function esperarArquivoGemini(
  arquivo
) {

  let atual =
    arquivo;

  let tentativa =
    0;

  while (true) {

    const estado =
      String(
        atual?.state || ''
      ).toUpperCase();

    console.log(
      `[Gemini] Estado do arquivo: ${
        estado || 'DESCONHECIDO'
      }`
    );

    if (
      estado === 'ACTIVE'
    ) {

      return atual;
    }

    if (
      estado === 'FAILED' ||
      estado === 'ERROR'
    ) {

      throw new Error(
        'O Gemini não conseguiu processar o vídeo.'
      );
    }

    tentativa++;

    if (
      tentativa > 60
    ) {

      throw new Error(
        'Tempo limite excedido no processamento do vídeo pelo Gemini.'
      );
    }

    await sleep(5000);

    atual =
      await gemini.files.get({
        name:
          atual.name
      });
  }
}

// ============================================================
// ANALISAR VÍDEO COM GEMINI
// ============================================================

app.post(
  '/api/analisar',
  async (req, res) => {

    let arquivoTemporario =
      null;

    let arquivoGemini =
      null;

    try {

      const {
        youtubeUrl
      } = req.body;

      const duration =
        Math.round(
          limitarNumero(
            req.body.duration,
            15,
            120,
            60
          )
        );

      const quantity =
        Math.round(
          limitarNumero(
            req.body.quantity,
            1,
            5,
            3
          )
        );

      if (!youtubeUrl) {

        return res.status(400).json({

          error:
            'Informe a URL do vídeo do YouTube.'
        });
      }

      const videoId =
        extrairVideoId(
          youtubeUrl
        );

      if (!videoId) {

        return res.status(400).json({

          error:
            'URL do YouTube inválida ou não reconhecida.'
        });
      }

      if (!gemini) {

        return res.status(500).json({

          error:
            'Gemini não configurado. Verifique GEMINI_API_KEY no Render.'
        });
      }

      metricas.totalAnalises++;

      console.log(
        '================================================'
      );

      console.log(
        `[Analisar] Novo pedido: ${videoId}`
      );

      console.log(
        `[Analisar] Cortes: ${quantity} | Duração: ${duration}s`
      );

      // ======================================================
      // 1. OBTER STREAM
      // ======================================================

      let streamUrl =
        await extrairStreamOficial(
          videoId
        );

      if (!streamUrl) {

        return res.status(503).json({

          error:
            'Não foi possível obter o vídeo do YouTube. Tente novamente em alguns instantes.'
        });
      }

      // ======================================================
      // 2. BAIXAR VÍDEO
      // ======================================================

      try {

        arquivoTemporario =
          await baixarVideoTemporario(
            streamUrl
          );

      } catch (downloadError) {

        console.warn(
          '[Analisar] Primeiro download falhou.'
        );

        console.warn(
          '[Analisar] Obtendo um novo stream da RapidAPI...'
        );

        // Apaga qualquer arquivo parcial
        apagarArquivo(
          arquivoTemporario
        );

        arquivoTemporario =
          null;

        // Tenta obter URL NOVA
        streamUrl =
          await extrairStreamOficial(
            videoId
          );

        if (!streamUrl) {

          throw downloadError;
        }

        console.log(
          '[Analisar] Tentando segundo download...'
        );

        arquivoTemporario =
          await baixarVideoTemporario(
            streamUrl
          );
      }

      // ======================================================
      // 3. UPLOAD GEMINI
      // ======================================================

      console.log(
        '[Gemini] Enviando vídeo...'
      );

      arquivoGemini =
        await gemini.files.upload({

          file:
            arquivoTemporario,

          config: {

            mimeType:
              'video/mp4'
          }
        });

      if (
        !arquivoGemini?.name ||
        !arquivoGemini?.uri
      ) {

        throw new Error(
          'O Gemini não retornou um arquivo válido após o upload.'
        );
      }

      console.log(
        `[Gemini] Upload concluído: ${arquivoGemini.name}`
      );

      // ======================================================
      // 4. ESPERAR PROCESSAMENTO
      // ======================================================

      arquivoGemini =
        await esperarArquivoGemini(
          arquivoGemini
        );

      console.log(
        '[Gemini] Vídeo pronto para análise.'
      );

      // ======================================================
      // 5. PROMPT
      // ======================================================

      const prompt = `
Você é o sistema de análise de vídeos do ClipForge Pro.

Analise o vídeo inteiro e encontre os melhores momentos para criar
Shorts, Reels e TikToks.

QUANTIDADE:
Encontre exatamente até ${quantity} cortes.

DURAÇÃO:
Cada corte deve ter aproximadamente ${duration} segundos.

OBJETIVO:
Escolha trechos que tenham potencial de prender a atenção de quem
está assistindo.

Procure principalmente:

- ganchos fortes;
- frases impactantes;
- histórias;
- revelações;
- opiniões interessantes;
- momentos engraçados;
- momentos emocionantes;
- perguntas e respostas;
- reações;
- conflitos ou discussões interessantes;
- informações surpreendentes;
- momentos que possam gerar comentários;
- trechos que façam sentido mesmo fora do contexto completo.

REGRAS IMPORTANTES SOBRE TEMPO:

1. Analise os timestamps REAIS do vídeo.
2. NÃO invente timestamps.
3. "start" precisa ser o segundo real de início.
4. "end" precisa ser o segundo real de término.
5. "duration" deve ser exatamente end - start.
6. Não escolha trechos que ultrapassem o final do vídeo.
7. Evite cortes excessivamente silenciosos.
8. Evite repetir o mesmo momento.
9. Prefira começar alguns segundos antes da frase principal quando
isso melhorar o contexto.
10. Cada corte deve funcionar como um pequeno vídeo independente.

PONTUAÇÃO:

O score deve ser de 0 a 100.

Considere:
- força do gancho;
- clareza;
- emoção;
- curiosidade;
- potencial de retenção;
- potencial de comentários;
- capacidade de funcionar como Short.

RETORNE SOMENTE JSON.

NÃO use markdown.
NÃO escreva explicações fora do JSON.

Formato:

{
  "clips": [
    {
      "id": 1,
      "title": "Título curto",
      "reason": "Motivo pelo qual este trecho foi escolhido",
      "start": 120,
      "end": 180,
      "duration": 60,
      "score": 95
    }
  ]
}
`;

      // ======================================================
      // 6. ANÁLISE GEMINI
      // ======================================================

      console.log(
        '[Gemini] Analisando conteúdo do vídeo...'
      );

      const resultado =
        await gemini.models.generateContent({

          model:
            GEMINI_MODEL,

          contents:
            createUserContent([

              createPartFromUri(
                arquivoGemini.uri,
                arquivoGemini.mimeType ||
                  'video/mp4'
              ),

              prompt
            ]),

          config: {

            responseMimeType:
              'application/json'
          }
        });

      const texto =
        resultado?.text || '';

      console.log(
        '[Gemini] Resposta recebida.'
      );

      // ======================================================
      // 7. CONVERTER JSON
      // ======================================================

      const dados =
        limparJsonGemini(
          texto
        );

      if (
        !dados ||
        !Array.isArray(
          dados.clips
        )
      ) {

        console.error(
          '[Gemini] Resposta:',
          texto
        );

        throw new Error(
          'O Gemini respondeu, mas não retornou os cortes em formato válido.'
        );
      }

      // ======================================================
      // 8. NORMALIZAR CORTES
      // ======================================================

      const clips =
        [];

      for (
        let index = 0;
        index <
          dados.clips.length &&
        clips.length <
          quantity;
        index++
      ) {

        const clip =
          dados.clips[index];

        let start =
          Number(
            clip?.start
          );

        let end =
          Number(
            clip?.end
          );

        let clipDuration =
          Number(
            clip?.duration
          );

        if (
          !Number.isFinite(start) ||
          start < 0
        ) {
          continue;
        }

        if (
          !Number.isFinite(end) ||
          end <= start
        ) {

          if (
            Number.isFinite(
              clipDuration
            ) &&
            clipDuration > 0
          ) {

            end =
              start +
              clipDuration;

          } else {

            end =
              start +
              duration;
          }
        }

        if (
          !Number.isFinite(
            clipDuration
          ) ||
          clipDuration <= 0
        ) {

          clipDuration =
            end -
            start;
        }

        start =
          Math.max(
            0,
            Math.round(start)
          );

        end =
          Math.round(end);

        clipDuration =
          Math.round(
            clipDuration
          );

        if (
          clipDuration < 5
        ) {
          continue;
        }

        end =
          start +
          clipDuration;

        if (
          clipDuration > 120
        ) {

          clipDuration =
            duration;

          end =
            start +
            clipDuration;
        }

        let score =
          Number(
            clip?.score
          );

        if (
          !Number.isFinite(score)
        ) {
          score = 80;
        }

        score =
          Math.round(
            Math.min(
              100,
              Math.max(
                0,
                score
              )
            )
          );

        clips.push({

          id:
            clips.length + 1,

          title:
            String(
              clip?.title ||
              `Corte viral #${clips.length + 1}`
            ).slice(
              0,
              120
            ),

          reason:
            String(
              clip?.reason ||
              'Trecho identificado pela IA como um momento relevante do vídeo.'
            ).slice(
              0,
              500
            ),

          start,

          end,

          duration:
            clipDuration,

          score,

          thumbnail:
            `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
        });
      }

      // ======================================================
      // 9. VERIFICAR
      // ======================================================

      if (
        !clips.length
      ) {

        throw new Error(
          'O Gemini não encontrou cortes válidos neste vídeo.'
        );
      }

      console.log(
        `[Analisar] ${clips.length} cortes preparados.`
      );

      console.log(
        '================================================'
      );

      return res.json({

        success:
          true,

        videoId,

        clips
      });

    } catch (error) {

      console.error(
        '================================================'
      );

      console.error(
        '[ANALISAR ERROR]'
      );

      console.error(
        error?.response?.data ||
        error?.message ||
        error
      );

      console.error(
        '================================================'
      );

      let mensagem =
        error?.message ||
        'Erro ao processar análise do vídeo.';

      if (
        mensagem.includes(
          'quota'
        ) ||
        mensagem.includes(
          '429'
        )
      ) {

        mensagem =
          'O limite da API Gemini foi atingido. Tente novamente mais tarde.';
      }

      if (
        mensagem.includes(
          'API key'
        ) ||
        mensagem.includes(
          'API_KEY'
        )
      ) {

        mensagem =
          'A chave da API Gemini não foi aceita pelo servidor.';
      }

      return res.status(500).json({

        error:
          mensagem
      });

    } finally {

      apagarArquivo(
        arquivoTemporario
      );
    }
  }
);

// ============================================================
// PIX - CRIAR
// ============================================================

app.post(
  '/api/pix/criar',
  async (req, res) => {

    const {
      userId = 'anonimo',
      valor = 19.90
    } = req.body;

    const valorFormatado =
      Number(
        parseFloat(
          valor
        ).toFixed(2)
      );

    if (!mpClient) {

      const mockId =
       