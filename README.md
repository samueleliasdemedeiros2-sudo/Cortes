# ClipForge Pro Backend V16.2.1 — MP4 Only

Esta versão remove a origem por URL do YouTube e aceita apenas arquivos MP4 enviados por `/api/upload`.

## Alterações
- Removidos `yt-dlp`, cookies do YouTube e fallbacks Piped/Invidious do backend.
- `/api/analisar` exige `uploadId` de um MP4 previamente enviado.
- `/api/download` exige `uploadId`; URLs não são usadas como origem.
- Modo padrão `smart`: seleção local de trechos por detecção de mudanças de cena e distribuição temporal.
- Modo `minute`: cortes sequenciais de até 60 segundos. Envie `cutMode: "minute"` ou `mode: "minute"` junto com `uploadId` em `/api/analisar`.
- Cortes exportados pelo endpoint de download são limitados a no máximo 60 segundos.
- Mantidos usuários, pontos, VIP, Mercado Pago, administração e PostgreSQL.

## API de vídeo
1. `POST /api/upload` com `multipart/form-data`, campo `video` contendo um MP4.
2. Guarde o `uploadId` retornado.
3. `POST /api/analisar` com JSON, por exemplo:
   ```json
   { "uploadId": "UPLOAD_ID", "cutMode": "minute", "clipCount": 5 }
   ```
   Para cortes inteligentes, use `cutMode: "smart"` ou omita `cutMode`.
4. `POST /api/download` com `uploadId`, `start`, `duration` (máximo 60), e `format` (`9:16`, `1:1` ou `16:9`).

## Render / PostgreSQL
- `npm start` inicia `server.js`.
- Em produção, configure `DATABASE_URL` com a URL real do PostgreSQL do Render. Um valor placeholder como `base` não é uma URL válida; a proteção de produção não deve ser desativada para esconder esse erro.
- Configure `MP_ACCESS_TOKEN` (ou `MERCADO_PAGO_ACCESS_TOKEN`) e mantenha o arquivo `mercadoPago.js` no repositório para habilitar os pagamentos PIX.
- `MAX_UPLOAD_MB` define o limite do upload; o padrão é 150 MB.
- Verifique `/health` e os logs do Render após deploy.

## Limitação importante
O modo `smart` é uma heurística local baseada em mudanças de cena e distribuição temporal. Ele não entende semanticamente o áudio/fala nem substitui um modelo de IA multimodal. A validação sintática do código não comprova que o processamento real, o banco ou o pagamento funcionam no Render; esses itens precisam ser testados no ambiente publicado.
