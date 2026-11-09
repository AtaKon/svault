# syntax=docker/dockerfile:1

# node:22 tracks the latest 22.x; pdfjs-dist requires Node >=22.13.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    DATA_DIR=/data
WORKDIR /app
RUN groupadd --system svault && useradd --system --gid svault svault \
 && mkdir -p /data && chown -R svault:svault /data
COPY --from=build --chown=svault:svault /app/package.json ./package.json
COPY --from=build --chown=svault:svault /app/node_modules ./node_modules
COPY --from=build --chown=svault:svault /app/dist ./dist
COPY --from=build --chown=svault:svault /app/public ./public
COPY --from=build --chown=svault:svault /app/assets ./assets
COPY --chown=svault:svault docker-entrypoint.sh /usr/local/bin/svault-entrypoint
RUN chmod 0555 /usr/local/bin/svault-entrypoint
USER svault
EXPOSE 4000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/svault-entrypoint"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server/index.js"]
