# syntax=docker/dockerfile:1.6

ARG NODE_VERSION=20.11.1
FROM node:${NODE_VERSION}-alpine AS base

FROM base AS deps
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./backend/
COPY packages ./packages
RUN cd /app/packages/core && npm install && npm run build
RUN cd backend && npm install

FROM base AS builder
WORKDIR /app
COPY backend ./backend
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/backend/node_modules ./backend/node_modules
WORKDIR /app/backend
RUN npm run build

FROM base AS prod_deps
WORKDIR /app
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm prune --omit=dev

FROM base AS runtime
WORKDIR /app/backend
ENV PORT=4000
ENV NODE_ENV=production
EXPOSE 4000
COPY backend/package.json backend/package-lock.json ./
COPY --from=prod_deps /app/backend/node_modules ./node_modules
COPY --from=builder /app/backend/dist ./dist
CMD ["node", "dist/index.js"]
