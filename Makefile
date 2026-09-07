# SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
# SPDX-License-Identifier: Apache-2.0
#
# Convenience wrapper. Requires cargo (1.96.1), go (1.25+), and pnpm on PATH for
# a full run. See docs/architecture.md.

.DEFAULT_GOAL := help
SHELL := /bin/bash

.PHONY: help
help: ## List targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  %-22s %s\n", $$1, $$2}'

.PHONY: check
check: spdx rust-check go-check desktop-check harness-check docs-check ## All static checks

.PHONY: test
test: rust-test go-test desktop-test harness-test ## All unit tests

.PHONY: spdx
spdx: ## SPDX headers on non-vendored files
	node scripts/spdx-check.mjs

.PHONY: rust-check
rust-check: ## fmt + clippy -D warnings + cargo deny
	cargo fmt --all --check
	cargo clippy --workspace --all-targets --locked -- -D warnings
	cargo deny --locked check

.PHONY: rust-test
rust-test: ## cargo test (workspace)
	cargo test --workspace --locked

.PHONY: go-check
go-check: ## go vet + staticcheck (vendored services/)
	cd services && go vet ./... && staticcheck ./... || true

.PHONY: go-test
go-test: ## go test (vendored services/ + yardmaster-lan-scanner)
	cd services && go test ./...

.PHONY: desktop-check
desktop-check: ## typecheck + lint + contracts (vendored desktop/)
	cd desktop && npm run typecheck && npm run lint && npm run service-contracts:check

.PHONY: desktop-test
desktop-test: ## desktop unit tests
	cd desktop && npm run test:unit

.PHONY: harness-check
harness-check: ## typecheck the DeepSeek Harness packages
	pnpm -C packages/dsh-yardmaster typecheck
	pnpm -C packages/dsh-bundle-yardmaster typecheck

.PHONY: harness-test
harness-test: ## vitest for the DeepSeek Harness packages (pinned dsh)
	pnpm -C packages/dsh-yardmaster test
	pnpm -C packages/dsh-bundle-yardmaster test

.PHONY: docs-check
docs-check: ## ADR index + validate fenced TOML in docs
	node scripts/adr-index-check.mjs
	node scripts/validate-doc-toml.mjs

.PHONY: build
build: ## Build everything and stage into services/build/bin (see scripts/build.sh)
	./scripts/build.sh

.PHONY: docker-build
docker-build: ## Build the headless node image (docker/Dockerfile)
	docker build -f docker/Dockerfile -t yardmaster:dev .

.PHONY: docker-lint
docker-lint: ## Validate the Portainer stack files and the entrypoint
	@for f in deploy/portainer/*.stack.yml; do \
	  echo "  $$f"; YM_CONFIG_FILE=/dev/null docker compose -f "$$f" config -q; done
	shellcheck docker/entrypoint.sh
