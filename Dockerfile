FROM node:22-bookworm-slim AS builder

ARG DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian
ARG DEBIAN_SECURITY_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian-security

ENV COREPACK_HOME=/corepack
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV API_INTERNAL_URL=http://api:43171

WORKDIR /app

RUN sed -i \
      -e "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
      -e "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" \
      /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg openssl \
  && rm -rf /var/lib/apt/lists/*

ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG AWS_SDK_REGISTRY=https://registry.npmjs.org
ARG PRISMA_ENGINES_MIRROR=https://npmmirror.com/mirrors/prisma

ENV PRISMA_ENGINES_MIRROR=${PRISMA_ENGINES_MIRROR}

RUN corepack enable \
  && corepack prepare pnpm@10.15.0 --activate \
  && pnpm config set registry "${NPM_REGISTRY}" \
  && pnpm config set '@aws-sdk:registry' "${AWS_SDK_REGISTRY}" \
  && pnpm config set '@aws-crypto:registry' "${AWS_SDK_REGISTRY}" \
  && pnpm config set '@smithy:registry' "${AWS_SDK_REGISTRY}" \
  && pnpm config set '@aws:registry' "${AWS_SDK_REGISTRY}"

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-bookworm-slim AS runtime

ARG DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian
ARG DEBIAN_SECURITY_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian-security

ENV NODE_ENV=production

WORKDIR /app

RUN sed -i \
      -e "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
      -e "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" \
      /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg openssl \
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
