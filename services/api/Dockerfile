# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY services/api/package.json services/api/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY services/api/tsconfig.json services/api/tsconfig.build.json ./
COPY services/api/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S pcdi && adduser -S pcdi -G pcdi
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY services/api/package.json ./
COPY db/migrations ./db/migrations
USER pcdi
EXPOSE 3000
CMD ["node", "dist/main.js"]
