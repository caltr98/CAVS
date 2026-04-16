FROM node:20-bullseye

WORKDIR /usr/src/app

COPY package.json yarn.lock tsconfig.json veramoRestAgent.js veramoRestAgent.ts ./
COPY src ./src
COPY MultiSignatureVeramo ./MultiSignatureVeramo
COPY start.sh .

RUN yarn install --frozen-lockfile

ENV TS_NODE_TRANSPILE_ONLY=1
EXPOSE 3001

ENTRYPOINT ["/usr/src/app/start.sh"]
