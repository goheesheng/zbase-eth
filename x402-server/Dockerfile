# syntax=docker/dockerfile:1
# zBase x402 paid API (Express, the payment-enforced endpoints).
# Same base as the app image so the layer is shared on the box.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY index.js ./
# index.js appends to ./logs/requests.ndjson; pre-create it node-writable so
# the named volume inherits correct ownership on first mount.
RUN mkdir -p /app/logs && chown node:node /app/logs
USER node
EXPOSE 4020
CMD ["node", "index.js"]
