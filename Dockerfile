# syntax=docker/dockerfile:1

# --- 1. Сборка статики фронтенда (vite build → dist/) ------------------------
FROM node:22-alpine AS build
WORKDIR /app
# сначала манифесты — кеш слоя npm ci не сбрасывается при правках исходников
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- 2. Рантайм: прокси /yt → YouTrack + раздача dist/ ----------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8414
WORKDIR /app
# сервер без зависимостей — нужен только server.cjs и собранная статика
COPY --chown=node:node server.cjs ./
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8414
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||8414,path:'/'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server.cjs"]
