FROM --platform=$BUILDPLATFORM node:22-alpine AS build

WORKDIR /app

ENV VITE_API_PROXY_AVAILABLE=true
ENV VITE_API_PROXY_LOCKED=false
ENV VITE_DOCKER_DEPLOYMENT=true
ENV VITE_BACKEND_API=true

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV STATIC_DIR=/app/dist
ENV IMAGE_DATA_DIR=/app/data

COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules

VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "server/index.mjs"]
