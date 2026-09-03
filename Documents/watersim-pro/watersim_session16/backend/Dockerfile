# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
# WaterSim Pro — Backend Development Dockerfile
#
# This is an npm-workspaces monorepo with a SINGLE root package-lock.json.
# Build context MUST be the repo root:
#   docker build -f backend/Dockerfile .
# (docker-compose.yml already sets context: . / dockerfile: backend/Dockerfile)
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS base

WORKDIR /repo

# Workspace-aware install: root manifest + lockfile + every workspace manifest.
# (npm ci validates the lockfile against ALL declared workspaces, so both
# workspace package.json files must be present even for a filtered install.)
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json

# Dev dependencies included (no --omit=dev) so nodemon is available for hot reload
RUN npm ci --workspace=backend --ignore-scripts

# Copy source — docker-compose.yml bind-mounts ./backend/src over this for live reload
COPY backend/src ./backend/src

WORKDIR /repo/backend

EXPOSE 4000

# nodemon restarts on changes under the mounted src/ volume (hot reload)
CMD ["npx", "nodemon", "src/server.js"]
