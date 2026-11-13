# syntax=docker/dockerfile:1

# Float the Node 22 tag and assert pdfjs-dist's >=22.13 engine floor below.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=optional --no-audit --no-fund

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build && npm prune --omit=dev --omit=optional

FROM node:22-bookworm-slim AS runtime
ARG APP_BUILD_VERSION=""
ENV NODE_ENV=production \
    PORT=4000 \
    DATA_DIR=/data \
    SV_VERSION=${APP_BUILD_VERSION}
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
RUN node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) throw new Error("SVault requires Node.js >=22.13.0")'
USER svault
EXPOSE 4000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/svault-entrypoint"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server/index.js"]
