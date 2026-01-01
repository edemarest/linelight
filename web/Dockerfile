# syntax=docker/dockerfile:1.6

ARG NODE_VERSION=20.11.1
FROM node:${NODE_VERSION}-alpine AS base

FROM base AS deps
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL:-http://localhost:4000}
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
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL:-http://localhost:4000}
WORKDIR /app
COPY web ./web
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/web/node_modules ./web/node_modules
# Render images based on alpine don't include git by default.
# Our build-info script calls git opportunistically; install it so it can succeed when available.
RUN apk add --no-cache git
WORKDIR /app/web
RUN npm run build

FROM base AS runtime
WORKDIR /app/web
ENV NODE_ENV=production
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL:-http://localhost:4000}
EXPOSE 3000
COPY --from=builder /app/web/.next/standalone ./
COPY --from=builder /app/web/.next/static ./.next/static
COPY --from=builder /app/web/public ./public
# In a monorepo, Next standalone output may preserve the app folder name
# (e.g. place server.js under ./web/server.js). In that case, the server
# will look for assets under ./web/.next/static and ./web/public.
RUN if [ -d "./web" ]; then \
			mkdir -p ./web/.next && \
			rm -rf ./web/.next/static ./web/public && \
			cp -R ./.next/static ./web/.next/static && \
			cp -R ./public ./web/public; \
		fi
CMD ["sh", "-c", "export PORT=${PORT:-3000} HOSTNAME=0.0.0.0; if [ -f server.js ]; then node server.js; elif [ -f web/server.js ]; then node web/server.js; else echo 'Error: server.js not found' >&2; exit 1; fi"]
