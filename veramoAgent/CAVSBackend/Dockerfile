FROM node:20-alpine

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci

COPY CAVSService.js config.json pipeline.config.json trustedissuers.json ./

EXPOSE 4200

CMD ["npm", "start"]

