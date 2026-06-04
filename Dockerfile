# Stage 1: Build backend
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json yarn.lock tsconfig.json ./
RUN yarn install --frozen-lockfile
COPY src/ ./src/
RUN yarn build

# Stage 2: Build frontend
FROM node:20-slim AS frontend-builder
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY frontend/ ./frontend/
RUN yarn build:frontend

# Stage 3: Runtime
FROM node:20-slim
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --production --frozen-lockfile
COPY --from=builder /app/dist ./dist
COPY --from=frontend-builder /app/frontend-dist ./frontend-dist
COPY static ./static
RUN mkdir -p uploads
CMD ["node", "dist/index.js"]
