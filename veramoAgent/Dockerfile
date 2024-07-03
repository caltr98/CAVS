# Use the official Node.js 20.12.0 image as base
FROM node:20.12.0

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to install app dependencies
COPY ./package-lock.json ./package-lock.json
COPY ./package.json ./package.json

# Copy other necessary files
COPY ./tsconfig.json ./tsconfig.json
COPY src/veramo/setup.ts ./src/veramo/setup.ts
COPY src/veramo/setupETH.ts ./src/veramo/setupETH.ts

COPY ./veramoRestAgent.ts ./veramoRestAgent.ts

# Install app dependencies
RUN yarn install

# Install TypeScript globally
RUN npm install -g typescript

# Install npx at version 10.5.0 globally
RUN yarn add qrcode
# Install type declarations for required modules
RUN yarn add --dev @types/qrcode @types/pngjs @types/jpeg-js @types/jwt-decode

# Run TypeScript compiler
RUN npx tsc --resolveJsonModule

# Expose the port on which the app will run
EXPOSE 3001

# Run the app using ts-node/esm loader
CMD ["node", "./veramoRestAgent.js"]
