# Use official Node.js image as base
FROM node:20

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm install
RUN npm install axios

# Copy the rest of the application code
COPY ./skillsExtractorService.js .
COPY ./config.json .

# Expose the port your app runs on
EXPOSE 4502

# Command to run your app
CMD ["npm", "start"]
