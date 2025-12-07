# syntax=docker/dockerfile:1.6

ARG NODE_VERSION=20.11.1
FROM node:${NODE_VERSION}-alpine AS base

FROM base AS deps
WORKDIR /app
COPY web/package.json web/package-lock.json ./web/
COPY packages ./packages
RUN cd /app/packages/core && npm install && npm run build
RUN cd web \
	&& npm config set fetch-retries 5 \
	&& npm config set fetch-retry-factor 10 \
	&& npm config set fetch-retry-mintimeout 20000 \
	&& npm config set fetch-retry-maxtimeout 120000 \
	&& npm install --prefer-offline --no-audit --no-fund --unsafe-perm

FROM base AS builder
WORKDIR /app
COPY web ./web
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/web/node_modules ./web/node_modules
RUN rm -rf /app/web/node_modules/@linelight/core && cp -R /app/packages/core /app/web/node_modules/@linelight/core
WORKDIR /app/web
RUN npm run build

FROM base AS runtime
WORKDIR /app/web
ENV NODE_ENV=production
EXPOSE 3000
COPY --from=builder /app/web/.next/standalone ./
COPY --from=builder /app/web/.next/static ./.next/static
COPY --from=builder /app/web/public ./public
CMD ["sh", "-c", "export PORT=${PORT:-3000} HOSTNAME=0.0.0.0; if [ -f server.js ]; then node server.js; elif [ -f web/server.js ]; then node web/server.js; else echo 'Error: server.js not found' >&2; exit 1; fi"]
