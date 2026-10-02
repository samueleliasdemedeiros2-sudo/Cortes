// ============================================================
// ANÁLISE
// ============================================================

app.post('/api/analisar', async (req, res) => {

  try {

    const {
      url,
      videoUrl,
      youtubeUrl,
      videoId,
      id,
      youtube_url,
      link,
      youtube,
      v,
      duration,
      quantity
    } = req.body || {};

    // Aceita todos os formatos possíveis enviados pelo frontend
    let entrada =
      id ||
      videoId ||
      url ||
      videoUrl ||
      youtubeUrl ||
      youtube_url ||
      link ||
      youtube ||
      v;

    // Se vier somente o ID no campo "v"
    if (
      v &&
      /^[a-zA-Z0-9_-]{11}$/.test(
        String(v).trim()
      )
    ) {

      entrada =
        `https://www.youtube.com/watch?v=${String(v).trim()}`;

    }

    console.log(
      '[Análise] Entrada recebida:',
      entrada
        ? String(entrada).slice(0, 200)
        : 'nenhuma'
    );

    // Extrair ID do YouTube
    const youtubeId =
      extrairVideoId(entrada);

    console.log(
      '[Análise] ID extraído:',
      youtubeId || 'NÃO ENCONTRADO'
    );

    if (!youtubeId) {

      return respostaErro(
        res,
        400,
        'URL ou ID do YouTube inválido.'
      );

    }

    metrics.analises++;

    // Quantidade de cortes
    const quantidade =
      limitarNumero(
        Math.floor(
          numeroSeguro(
            quantity,
            3
          )
        ),
        1,
        10
      );

    // Duração solicitada
    const duracaoSolicitada =
      limitarNumero(
        numeroSeguro(
          duration,
          60
        ),
        1,
        3600
      );

    console.log(
      `[Análise] Vídeo: ${youtubeId}`
    );

    console.log(
      `[Análise] Quantidade solicitada: ${quantidade}`
    );

    console.log(
      `[Análise] Duração solicitada: ${duracaoSolicitada}s`
    );

    // Thumbnail
    const thumbnail =
      `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`;

    // ========================================================
    // CLIPS
    // ========================================================

    const clipsBase = [

      {
        id: 1,

        title:
          'Melhor momento',

        start: 35,

        end: 90,

        duration: 55,

        score: 98,

        reason:
          'Momento com alto potencial de retenção.',

        thumbnail

      },

      {
        id: 2,

        title:
          'Momento de destaque',

        start: 145,

        end: 200,

        duration: 55,

        score: 95,

        reason:
          'Trecho com potencial para gerar engajamento.',

        thumbnail

      },

      {
        id: 3,

        title:
          'Trecho viral',

        start: 290,

        end: 345,

        duration: 55,

        score: 92,

        reason:
          'Trecho interessante para formato curto.',

        thumbnail

      }

    ];

    const clips =
      clipsBase.slice(
        0,
        quantidade
      );

    // ========================================================
    // RESPOSTA
    // ========================================================

    return res.json({

      success: true,

      videoId:
        youtubeId,

      videoUrl:
        `https://www.youtube.com/watch?v=${youtubeId}`,

      duration:
        duracaoSolicitada,

      quantity:
        clips.length,

      clips

    });

  } catch (erro) {

    console.error(
      '[Análise Error]:',
      erro
    );

    return respostaErro(
      res,
      500,
      'Não foi possível analisar o vídeo.'
    );

  }

});