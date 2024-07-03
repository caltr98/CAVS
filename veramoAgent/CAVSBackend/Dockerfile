# Use the official Node.js 20.12.0 image as base
FROM node:20.12.0

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to install app dependencies
COPY ./package-lock.json ./package-lock.json
COPY ./package.json ./package.json

# Copy other necessary files
COPY ./CAVSService.js ./CAVSService.js
COPY ./config.json ./config.json

# Install app dependencies
RUN yarn install --frozen-lockfile

# Expose the port on which the app will run
EXPOSE 4200

# Run the app using ts-node/esm loader
CMD ["npm","run","start"]
