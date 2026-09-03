# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
# WaterSim Pro — Frontend Development Dockerfile (Vite dev server)
#
# This is an npm-workspaces monorepo with a SINGLE root package-lock.json.
# Build context MUST be the repo root:
#   docker build -f frontend/Dockerfile .
# (docker-compose.yml already sets context: . / dockerfile: frontend/Dockerfile)
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS base

WORKDIR /repo

# Workspace-aware install: root manifest + lockfile + every workspace manifest
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json

RUN npm ci --workspace=frontend --ignore-scripts

# Copy source — docker-compose.yml bind-mounts ./frontend/src over this for HMR
COPY frontend ./frontend

WORKDIR /repo/frontend

EXPOSE 3000

# Vite dev server — bind 0.0.0.0 so it's reachable from host
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "3000"]
