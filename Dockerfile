FROM node:20-bookworm-slim AS dependencies
WORKDIR /app
COPY app/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY app/package*.json ./
COPY app/server.js ./
COPY app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
