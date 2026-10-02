# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY apps/intelligence-console/package.json apps/intelligence-console/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/intelligence-console/ ./
RUN npx ng build --configuration production

FROM nginx:1.29-alpine
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/intelligence-console/browser /usr/share/nginx/html
EXPOSE 8080
