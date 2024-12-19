# Use an official node.js runtime as parent image
FROM node:22-alpine

# Install OpenSSL
RUN apk add --no-cache openssl

# Set the working directory in the container
WORKDIR /app

# Copy the package.json and package-lock.json files to the container
COPY package*.json ./

# Install the dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the port that the app runs on
EXPOSE 5000

# Define the command to run application
CMD [ "node", "./src/server.js" ]
