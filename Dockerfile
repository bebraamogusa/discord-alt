# ── Build stage (compile native deps) ─────────────────
FROM node:22-alpine AS build
RUN apk add --no-cache python3 py3-pip make g++ linux-headers
WORKDIR /app/server
COPY server/package.json .
RUN npm install --production

# ── Runtime stage ─────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

COPY --from=build /app/server/node_modules ./server/node_modules
COPY server/ ./server/
COPY client/ ./client/

RUN mkdir -p uploads data

ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

# Run core server (it applies core SQL migrations on startup)
CMD ["sh", "-c", "node server/index.core.js"]
