FROM node:24-bookworm AS build

ARG EMSDK_VERSION=4.0.11
ARG POB_VERSION=v2.66.2

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      build-essential \
      ca-certificates \
      git \
      ninja-build \
      python3 \
      python3-pip \
    && pip3 install --break-system-packages --no-cache-dir cmake==4.0.3 \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${EMSDK_VERSION}" https://github.com/emscripten-core/emsdk.git /opt/emsdk \
    && /opt/emsdk/emsdk install "${EMSDK_VERSION}" \
    && /opt/emsdk/emsdk activate "${EMSDK_VERSION}" \
    && rm -rf /opt/emsdk/downloads

ENV PATH="/opt/emsdk:/opt/emsdk/upstream/emscripten:${PATH}"

WORKDIR /src

COPY package.json package-lock.json ./
COPY packages/dds/package.json packages/dds/package.json
COPY packages/driver/package.json packages/driver/package.json
COPY packages/game/package.json packages/game/package.json
COPY packages/packer/package.json packages/packer/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci

COPY . .

RUN npm run -w packages/packer pack "${POB_VERSION}" poe1 clone \
    && npm run -w packages/driver build \
    && npm run -w packages/web build \
    && node selfhost/verify-build.mjs packages/web/build/client "${POB_VERSION}"

FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    STATIC_ROOT=/app/public

WORKDIR /app

COPY --from=build --chown=node:node /src/packages/web/build/client /app/public
COPY --from=build --chown=node:node /src/selfhost/server.mjs /app/server.mjs

USER node
EXPOSE 3000

CMD ["node", "/app/server.mjs"]
