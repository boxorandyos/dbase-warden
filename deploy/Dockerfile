FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
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
