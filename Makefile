.PHONY: server\:sepolia

server\:sepolia:
	@bash -lc '\
		set -euo pipefail; \
		read_env(){ \
			node scripts/read-env.cjs "$$1" "$$2"; \
		}; \
		SEPOLIA_ENV=".env.sepolia.local"; \
		BASE_ENV=".env"; \
		EXAMPLE_ENV=".env.sepolia.example"; \
		get_first(){ \
			for key in "$$@"; do \
				if [ -f "$$SEPOLIA_ENV" ]; then \
					val="$$(read_env "$$SEPOLIA_ENV" "$$key")"; \
					if [ -n "$$val" ]; then printf "%s" "$$val"; return 0; fi; \
				fi; \
				if [ -f "$$BASE_ENV" ]; then \
					val="$$(read_env "$$BASE_ENV" "$$key")"; \
					if [ -n "$$val" ]; then printf "%s" "$$val"; return 0; fi; \
				fi; \
				if [ -f "$$EXAMPLE_ENV" ]; then \
					val="$$(read_env "$$EXAMPLE_ENV" "$$key")"; \
					if [ -n "$$val" ]; then printf "%s" "$$val"; return 0; fi; \
				fi; \
			done; \
			return 1; \
		}; \
		export RPC_URL="$${SEPOLIA_RPC_URL:-$$(get_first SEPOLIA_RPC_URL || true)}"; \
		export RELAYER_PRIVATE_KEY="$${SEPOLIA_PRIVATE_KEY:-$$(get_first SEPOLIA_PRIVATE_KEY RELAYER_PRIVATE_KEY || true)}"; \
		export FACTORY="$${FACTORY:-$$(get_first FACTORY || true)}"; \
		export BUNDLER="$${BUNDLER:-$$(get_first BUNDLER || true)}"; \
		export TOKEN="$${TOKEN:-$$(get_first TOKEN || true)}"; \
		export RELAYER_ADDR="$${RELAYER_ADDR:-$$(get_first RELAYER_ADDR || true)}"; \
		export FIXED_FEE="$${FIXED_FEE:-$$(get_first FIXED_FEE VITE_FIXED_FEE_RAW || true)}"; \
		export MARKET_ADDRESS="$${MARKET_ADDRESS:-$$(get_first MARKET_ADDRESS VITE_MARKET_ADDRESS || true)}"; \
		export ALLOWED_ORIGINS="$${ALLOWED_ORIGINS:-$$(get_first ALLOWED_ORIGINS || true)}"; \
		export HOST="$${HOST:-$$(get_first HOST || true)}"; \
		export PORT="$${PORT:-$$(get_first PORT || true)}"; \
		test -n "$$RPC_URL" || { echo "Missing SEPOLIA_RPC_URL"; exit 1; }; \
		test -n "$$RELAYER_PRIVATE_KEY" || { echo "Missing SEPOLIA_PRIVATE_KEY"; exit 1; }; \
		test -n "$$FACTORY" || { echo "Missing FACTORY"; exit 1; }; \
		test -n "$$BUNDLER" || { echo "Missing BUNDLER"; exit 1; }; \
		test -n "$$TOKEN" || { echo "Missing TOKEN"; exit 1; }; \
		test -n "$$RELAYER_ADDR" || { echo "Missing RELAYER_ADDR"; exit 1; }; \
		test -n "$$FIXED_FEE" || { echo "Missing FIXED_FEE"; exit 1; }; \
		export ALLOWED_ORIGINS="$${ALLOWED_ORIGINS:-http://localhost:4321}"; \
		export HOST="$${HOST:-0.0.0.0}"; \
		export PORT="$${PORT:-3000}"; \
		npx ts-node tokenization-relayer/src/server.ts; \
	'
