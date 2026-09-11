FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
ARG NPM_REGISTRY=https://packagefeedproxy.microsoft.io/npm/
RUN npm ci --omit=dev --registry="$NPM_REGISTRY" && npm cache clean --force

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100 DATA_DIRECTORY=/data SQLITE_JOURNAL_MODE=DELETE
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
COPY --chown=node:node web/dist ./web/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:3100/api/health').then(response => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"
CMD ["node", "server/index.ts"]