ARG CAVS_SOURCE_SHA256=unversioned
FROM node:20-bullseye@sha256:c0122351f25f04facee976f9db7214789eabadb489f4e4aea9cd00a0d6af77c4
ARG CAVS_SOURCE_SHA256
LABEL org.opencontainers.image.cavs-source-sha256="${CAVS_SOURCE_SHA256}"

WORKDIR /usr/src/app

COPY package.json yarn.lock tsconfig.json veramoRestAgent.js veramoRestAgent.ts ./
COPY src ./src
COPY MultiSignatureVeramo ./MultiSignatureVeramo
COPY start.sh .

RUN yarn install --frozen-lockfile

ENV TS_NODE_TRANSPILE_ONLY=1
EXPOSE 3001

ENTRYPOINT ["/usr/src/app/start.sh"]
