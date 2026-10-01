FROM node:22-bookworm-slim

# Instala ffmpeg, python3 e atualiza o yt-dlp para a versão mais recente
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    ca-certificates && \
    pip3 install --break-system-packages -U yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instala dependências do Node.js
COPY package*.json ./
RUN npm install --omit=dev

# Copia todos os ficheiros da raiz (incluindo server.js)
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
