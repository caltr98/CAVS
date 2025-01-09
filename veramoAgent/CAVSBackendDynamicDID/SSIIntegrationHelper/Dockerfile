# Use the official Node.js 20.12.0 image as base
FROM node:20.12.0

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to install app dependencies
COPY ./package-lock.json ./package-lock.json
COPY ./package.json ./package.json

# Copy other necessary files
COPY ./SSIBridgeIntegration.js ./SSIBridgeIntegration.js

# Install app dependencies
RUN yarn install --frozen-lockfile

# Expose the port on which the app will run
EXPOSE 17005

# Run the app using ts-node/esm loader
CMD ["node", "SSIBridgeIntegration.js"]
