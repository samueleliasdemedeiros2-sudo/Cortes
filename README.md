# ClipForge Pro — Backend 16.2.0 (Motor Local)

Esta versão substitui a chamada de análise do OpenRouter por um motor heurístico local baseado em mudanças de cena detectadas pelo FFmpeg. O objetivo é remover a dependência de IA generativa para a seleção inicial dos trechos.

## O que mudou
- Análise local de cenas com FFmpeg, sem chamada ao OpenRouter durante a análise.
- Seleção de trechos com diversidade temporal para reduzir cortes quase iguais.
- Fallback distribuído se a detecção de cenas não encontrar mudanças suficientes.
- Mantém os endpoints e o fluxo de análise/download existentes no backend.
- A inicialização não exige mais `PUBLIC_BASE_URL` apenas para análise de vídeo.
- PostgreSQL continua obrigatório em produção, para não iniciar com armazenamento comercial volátil.

## Implantação no Render
1. Faça backup do backend atual.
2. Substitua `server.js` e `package.json` pelos arquivos deste pacote no repositório do backend.
3. Mantenha Build Command `npm install` e Start Command `npm start`.
4. Configure `DATABASE_URL` com a URL real do PostgreSQL do Render (normalmente começa com `postgres://` ou `postgresql://`). Não use a palavra `base` como valor.
5. Mantenha as demais variáveis de ambiente que o seu serviço atual usa, incluindo segredos de autenticação/pagamento.
6. Faça deploy e confira os logs e `/health` antes de testar um vídeo MP4.

## Limitações honestas
- Este é um algoritmo de análise visual, não uma IA semântica: não entende piadas, contexto, fala ou significado. Ele usa mudanças de cena e distribuição temporal como sinais de seleção.
- A legenda automática não é adicionada por esta alteração.
- A obtenção de vídeos do YouTube continua dependendo do downloader e dos acessos/cookies configurados no serviço; esta alteração não remove bloqueios do YouTube.
- O ZIP contém o backend (`server.js`, `package.json`) e estas instruções. Não contém o frontend `index.html` nem credenciais.
