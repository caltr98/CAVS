FROM node:20.12.0

WORKDIR /user/src/app

COPY package*.json ./
RUN npm install --verbose

# all from pc folder to docker workdir app
COPY .. .

EXPOSE 13000
CMD ["npm","run","dev"]