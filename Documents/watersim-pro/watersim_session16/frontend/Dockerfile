# syntax=docker/dockerfile:1
FROM node:20-alpine AS base

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 3000

# Vite dev server — bind 0.0.0.0 so it's reachable from host
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "3000"]
