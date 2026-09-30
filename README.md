# ClipForge Server

Servidor V1 para o ClipForge.

## O que faz
- recebe URL do YouTube
- baixa o vídeo com yt-dlp
- corta um intervalo
- converte para 9:16 ou 1:1
- devolve uma URL para o MP4

## Rodar localmente
Requer Docker.

```bash
docker build -t clipforge-server .
docker run --rm -p 3000:3000 clipforge-server
```

Health:
`http://localhost:3000/api/health`

## Endpoint
POST `/api/clip`

JSON:
```json
{
  "url":"https://www.youtube.com/watch?v=...",
  "start":0,
  "duration":60,
  "format":"9:16"
}
```

Use apenas vídeos que você tenha autorização/direito de baixar e processar.
