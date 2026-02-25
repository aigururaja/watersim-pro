# syntax=docker/dockerfile:1
FROM node:20-alpine AS base

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY src ./src
COPY .env.example .env.example

EXPOSE 4000

# Use nodemon in development for hot-reload (mounted volume)
CMD ["node", "src/server.js"]
