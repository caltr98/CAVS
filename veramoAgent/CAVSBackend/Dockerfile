# Use official Node.js image as base
FROM node:20

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm install
RUN npm install axios express cors

# Copy the rest of the application code
COPY ./textProcessingService.iml .
COPY CAVSService.js .
COPY ./config.json .
COPY ./config.json ./src

# Expose the port your app runs on
EXPOSE 4500

# Command to run your app
CMD ["npm", "start"]
