# NODE_IMAGE defaults to Node 22. scripts/try-node.sh passes a newer major without changing this default.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
RUN pin="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([^"]*\)".*/\1/p' package.json | head -1)" \
    && test -n "${pin}" \
    && corepack prepare "pnpm@${pin}" --activate
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY apps/web-console/package.json apps/web-console/package.json
COPY services/engines/package.json services/engines/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
ENV NODE_ENV=production
ENV WEB_DIST=/app/apps/web-console/dist
EXPOSE 3101
CMD ["node", "apps/control-plane/dist/index.js"]
