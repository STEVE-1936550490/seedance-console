FROM node:22-bookworm-slim AS builder

ENV COREPACK_HOME=/corepack
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV API_INTERNAL_URL=http://api:43171

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.15.0 --activate

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=node:node /app /app

USER node

FROM runtime AS web
EXPOSE 43170
CMD ["node", "apps/web/node_modules/next/dist/bin/next", "start", "apps/web", "--hostname", "0.0.0.0", "--port", "43170"]

FROM runtime AS api
EXPOSE 43171
CMD ["node", "apps/api/dist/index.js"]

FROM runtime AS worker
EXPOSE 43172
CMD ["node", "apps/worker/dist/index.js"]
