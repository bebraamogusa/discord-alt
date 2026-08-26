# Build stage (compile native dependencies)
FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 pip make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Runtime stage
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=build /app/server/node_modules ./server/node_modules
COPY server/ ./server/
COPY client/ ./client/

RUN mkdir -p /app/data /app/uploads && chown -R node:node /app/server /app/client /app/data /app/uploads
USER node

ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

# Run core server (it applies core SQL migrations on startup)
CMD ["sh", "-c", "node server/index.core.js"]
