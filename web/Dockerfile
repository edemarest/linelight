# syntax=docker/dockerfile:1.6

ARG NODE_VERSION=20.11.1
FROM node:${NODE_VERSION}-bookworm-slim AS base

FROM base AS deps
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL:-http://localhost:4000}
ENV NODE_OPTIONS=--max-old-space-size=450
ENV NEXT_TELEMETRY_DISABLED=1
ENV TURBOPACK_ROOT=/app/web
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/
COPY packages/core/package.json ./packages/core/package.json
RUN npm config set fetch-retries 5 \
	&& npm config set fetch-retry-factor 10 \
	&& npm config set fetch-retry-mintimeout 20000 \
	&& npm config set fetch-retry-maxtimeout 120000 \
	&& npm config set fetch-timeout 300000 \
	&& npm config set maxsockets 1 \
	&& npm config set prefer-offline true \
	&& npm ci --workspaces --include-workspace-root --no-audit --no-fund --unsafe-perm

# Ensure the correct lightningcss native binary package is present for the
# build platform (Tailwind v4 / @tailwindcss/postcss depends on this).
RUN node - <<'NODE'
const { execSync } = require('child_process');

let MUSL = 'MUSL';
let familySync = null;
try {
  ({ MUSL, familySync } = require('/app/web/node_modules/detect-libc'));
} catch {
  familySync = null;
}

let parts = [process.platform, process.arch];
if (process.platform === 'linux') {
	const family = familySync ? familySync() : null;
	if (family === MUSL) parts.push('musl');
	else if (process.arch === 'arm') parts.push('gnueabihf');
	else parts.push('gnu');
} else if (process.platform === 'win32') {
	parts.push('msvc');
}

const suffix = parts.join('-');

const lightningPkg = `lightningcss-${suffix}`;
let lightningVersion = null;
try {
	lightningVersion = require('/app/web/node_modules/lightningcss/package.json').version;
} catch {
	lightningVersion = require('/app/node_modules/lightningcss/package.json').version;
}

const oxidePkg = `@tailwindcss/oxide-${suffix}`;
let oxideVersion = null;
try {
	oxideVersion = require('/app/web/node_modules/@tailwindcss/oxide/package.json').version;
} catch {
	oxideVersion = require('/app/node_modules/@tailwindcss/oxide/package.json').version;
}

console.log(`Ensuring ${lightningPkg}@${lightningVersion}`);
console.log(`Ensuring ${oxidePkg}@${oxideVersion}`);

execSync(
	`npm install --no-save --no-audit --no-fund ${lightningPkg}@${lightningVersion} ${oxidePkg}@${oxideVersion}`,
	{ cwd: '/app/web', stdio: 'inherit' },
);

require.resolve(lightningPkg);
require.resolve(oxidePkg);
NODE

FROM base AS builder
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL:-http://localhost:4000}
ENV NODE_OPTIONS=--max-old-space-size=450
ENV NEXT_TELEMETRY_DISABLED=1
ENV TURBOPACK_ROOT=/app/web
WORKDIR /app
COPY web ./web
COPY packages ./packages
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
# Our build-info script calls git opportunistically; install it so it can succeed when available.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app/packages/core
RUN npm run build
WORKDIR /app/web
RUN npm run build

FROM base AS runtime
WORKDIR /app/web
ENV NODE_ENV=production
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL:-http://localhost:4000}
EXPOSE 3000
RUN npm install -g serve
COPY --from=builder /app/web/out ./out
CMD ["sh", "-c", "export PORT=${PORT:-3000} HOSTNAME=0.0.0.0; serve -s out -l ${PORT}"]
