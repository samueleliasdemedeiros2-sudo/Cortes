FROM node:22-bookworm-slim

# ============================================
# SISTEMA
# ============================================

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        python3-pip \
        ca-certificates && \
    pip3 install --break-system-packages -U yt-dlp && \
    rm -rf /var/lib/apt/lists/*


# ============================================
# PROJETO
# ============================================

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev --ignore-scripts

COPY . .


# ============================================
# DIRETÓRIOS
# ============================================

RUN mkdir -p \
    bin \
    tmp \
    uploads \
    outputs


# ============================================
# AMBIENTE
# ============================================

ENV NODE_ENV=production
ENV PORT=10000

EXPOSE 10000


# ============================================
# START
# ============================================

CMD ["node", "server.js"]