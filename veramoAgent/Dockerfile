# Use the official Node.js 20.12.0 image as base
FROM node:20.12.0

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to install app dependencies
COPY ./package-lock.json ./package-lock.json
COPY ./package.json ./package.json
COPY ./yarn.lock ./yarn.lock

# Copy other necessary files
COPY ./tsconfig.json ./tsconfig.json
COPY src/veramo/setup.ts ./src/veramo/setup.ts
COPY ./veramoRestAgent.ts ./veramoRestAgent.ts

# Install app dependencies
RUN yarn install --frozen-lockfile

# Install TypeScript globally
RUN npm install -g typescript

# Install npx at version 10.5.0 globally
RUN npm install qrcode
# Install type declarations for required modules
RUN npm install --save-dev @types/qrcode @types/pngjs @types/jpeg-js @types/jwt-decode

# Run TypeScript compiler
RUN npx tsc --resolveJsonModule

# Expose the port on which the app will run
EXPOSE 3001

# Run the app using ts-node/esm loader
CMD ["node", "./veramoRestAgent.js"]
