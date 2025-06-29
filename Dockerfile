# Use an official Node.js runtime as a parent image.
# Using a specific version is good practice.
FROM node:18-slim

# Install necessary dependencies for Puppeteer to run.
# This runs as root within the Docker container, avoiding permission issues.
RUN apt-get update \
    && apt-get install -yq --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    gconf-service \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libgconf-2-4 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    # Clean up the cache to reduce image size.
    && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container.
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install Node.js dependencies.
RUN npm install

# Copy the rest of your application's source code from your repo to the container.
COPY . .

# Tell Docker that the container listens on this port.
EXPOSE 5000

# The command to run your application.
CMD [ "node", "server.js" ]
