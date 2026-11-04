FROM node:26-slim

# iptables provides both the nft (default) and the legacy backend.
RUN apt-get update \
 && apt-get install -y --no-install-recommends iptables \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY config ./config
COPY src ./src

ENV NODE_ENV=production

# Runs as root: managing iptables requires CAP_NET_ADMIN.
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.LEONIDAS_HTTP_PORT || 8161) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD [ "node", "src/index.js" ]
