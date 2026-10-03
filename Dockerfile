# Undercard: Next.js standalone server + the official Qloo harness for `qloo mcp`.
# Build: docker buildx build --platform linux/amd64 [--build-arg UNDERCARD_BASE_PATH=/undercard] -t undercard:<tag> .
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
ARG UNDERCARD_BASE_PATH=""
ENV UNDERCARD_BASE_PATH=$UNDERCARD_BASE_PATH
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
ARG UNDERCARD_BASE_PATH=""
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 UNDERCARD_BASE_PATH=$UNDERCARD_BASE_PATH \
    QLOO_MCP_COMMAND=qloo QLOO_HOME=/data/qloo-home NEXT_TELEMETRY_DISABLED=1
# The harness runs as a spawned child process, so standalone tracing does not include it; pin it here.
RUN npm install --global --omit=dev @qloo/qloo-harness@0.1.26 && npm cache clean --force \
    && mkdir -p /data/qloo-home && chown -R node:node /data
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000'+(process.env.UNDERCARD_BASE_PATH||'')+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
