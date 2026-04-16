FROM node:20-alpine

WORKDIR /usr/src/app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY ipfsAgentService.js indexing.json secret.json ./

EXPOSE 4201

CMD ["node", "ipfsAgentService.js"]

