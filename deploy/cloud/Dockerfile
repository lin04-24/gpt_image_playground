FROM --platform=$BUILDPLATFORM node:22-alpine AS build

WORKDIR /app

ENV VITE_DOCKER_DEPLOYMENT=true

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV STATIC_DIR=/app/dist
ENV IMAGE_DATA_DIR=/app/data

# 不复用 build stage 的 node_modules：只装生产依赖，构建工具链（vite/wrangler 等）不进运行镜像
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server

VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "server/api/main.mjs"]
