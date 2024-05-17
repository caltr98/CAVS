# Use the official Node.js 20.12.0 image as base
FROM node:20.12.0

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to install app dependencies
COPY ./package-lock.json ./package-lock.json
COPY ./package.json ./package.json
COPY ./yarn.lock ./yarn.lock

# Copy other necessary files
COPY ./ipfsAgentService.js ./ipfsAgentService.js
COPY ./secret.json ./secret.json
COPY ./indexing.json ./indexing.json
# Install app dependencies
RUN yarn install --frozen-lockfile

# Expose the port on which the app will run
EXPOSE 4201

# Run the app using ts-node/esm loader
CMD ["npm","run","start"]
