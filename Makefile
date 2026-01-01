# LineLight developer Makefile
# Usage: make <target>

SHELL := /bin/bash

COMPOSE ?= docker compose
COMPOSE_FILE ?= docker-compose.yml
LOCAL_REDIS_COMPOSE_FILE ?= docker-compose.local.yml

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show available targets
	@echo "LineLight commands:";
	@grep -E '^[a-zA-Z0-9_\-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-22s %s\n", $$1, $$2}'

# --- Docker (full stack) ---

.PHONY: up
up: ## Start full stack (build if needed)
	$(COMPOSE) -f $(COMPOSE_FILE) up -d --build

.PHONY: down
down: ## Stop full stack
	$(COMPOSE) -f $(COMPOSE_FILE) down

.PHONY: restart
restart: ## Restart full stack (no rebuild)
	$(COMPOSE) -f $(COMPOSE_FILE) restart

.PHONY: ps
ps: ## Show running containers
	$(COMPOSE) -f $(COMPOSE_FILE) ps

.PHONY: logs
logs: ## Tail logs (all services)
	$(COMPOSE) -f $(COMPOSE_FILE) logs -f --tail=200

.PHONY: logs-web
logs-web: ## Tail logs (web)
	$(COMPOSE) -f $(COMPOSE_FILE) logs -f --tail=200 web

.PHONY: logs-backend
logs-backend: ## Tail logs (backend)
	$(COMPOSE) -f $(COMPOSE_FILE) logs -f --tail=200 backend

.PHONY: build
build: ## Build all docker images
	$(COMPOSE) -f $(COMPOSE_FILE) build

.PHONY: rebuild
rebuild: ## Force rebuild + recreate all services (use when UI looks stale)
	$(COMPOSE) -f $(COMPOSE_FILE) build --no-cache
	$(COMPOSE) -f $(COMPOSE_FILE) up -d --force-recreate

.PHONY: rebuild-web
rebuild-web: ## Force rebuild + recreate web only (fastest for frontend edits)
	$(COMPOSE) -f $(COMPOSE_FILE) build --no-cache web
	$(COMPOSE) -f $(COMPOSE_FILE) up -d --force-recreate web

.PHONY: rebuild-backend
rebuild-backend: ## Force rebuild + recreate backend only
	$(COMPOSE) -f $(COMPOSE_FILE) build --no-cache backend
	$(COMPOSE) -f $(COMPOSE_FILE) up -d --force-recreate backend

.PHONY: hard-reset
hard-reset: ## DANGER: remove containers + volumes, then rebuild & start
	$(COMPOSE) -f $(COMPOSE_FILE) down -v
	$(COMPOSE) -f $(COMPOSE_FILE) build --no-cache
	$(COMPOSE) -f $(COMPOSE_FILE) up -d --force-recreate

# --- Docker (redis only, for local backend dev) ---

.PHONY: redis-up
redis-up: ## Start local Redis only (for running backend outside docker)
	$(COMPOSE) -f $(LOCAL_REDIS_COMPOSE_FILE) up -d

.PHONY: redis-down
redis-down: ## Stop local Redis only
	$(COMPOSE) -f $(LOCAL_REDIS_COMPOSE_FILE) down

.PHONY: redis-logs
redis-logs: ## Tail local Redis logs
	$(COMPOSE) -f $(LOCAL_REDIS_COMPOSE_FILE) logs -f --tail=200

# --- Node scripts (non-docker) ---

.PHONY: web-build
web-build: ## Build Next.js locally (no docker)
	npm --workspace web run build

.PHONY: backend-build
backend-build: ## Build backend locally (no docker)
	npm --workspace backend run build

.PHONY: core-build
core-build: ## Build shared core package locally (no docker)
	npm --workspace packages/core run build
