# 前端静态构建（可选）
#
# 注意：当前生产部署不走 Docker —— 实际是 systemd 跑 app/server/server.mjs（:8791）
# + deploy/gateway.mjs（:8080 静态与反代），前端产物由 vite 构建后直接落在 app/dist。
# 这个文件只用于需要镜像化时的前端静态托管，不含后端与网关。
#
# 构建： docker build -t agri-web .
FROM node:22-alpine AS build
WORKDIR /app
COPY app/package*.json ./
RUN npm ci
COPY app/ ./
RUN npm run build

FROM nginx:stable-alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
