# Use node image as the base image
FROM node:20

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install
RUN npm install axios


# Copy project files
COPY . .

# Expose port 3000 for the React app
EXPOSE 3000

# Start the React app using npm start
CMD ["npm", "start"]
