#!/usr/bin/env bash
set -euo pipefail

BASE_URL=${BASE_URL:-http://localhost:3000}
TIMEOUT=${TIMEOUT:-5}

log() {
  printf "\033[1;34m[smoke]\033[0m %s\n" "$*"
}

check() {
  local name=$1
  local url=$2
  local expect=${3:-200}
  local status

  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$url" || true)

  # Support comma-separated acceptable statuses, e.g. "401,307"
  if [[ "$expect" == *","* ]]; then
    IFS="," read -r -a codes <<< "$expect"
    for code in "${codes[@]}"; do
      if [[ "$status" == "$code" ]]; then
        log "PASS $name ($url) -> $status"
        return 0
      fi
    done
    printf "\033[1;31m[smoke]\033[0m FAIL %s (%s) expected one of [%s] got %s\n" "$name" "$url" "$expect" "$status"
    exit 1
  fi

  if [[ "$status" == "$expect" ]]; then
    log "PASS $name ($url) -> $status"
  else
    printf "\033[1;31m[smoke]\033[0m FAIL %s (%s) expected %s got %s\n" "$name" "$url" "$expect" "$status"
    exit 1
  fi
}

log "Base URL: $BASE_URL"

# public endpoints
check "healthz" "$BASE_URL/api/healthz" 200
check "sign-in page" "$BASE_URL/auth/signin" 200

# authenticated endpoints should block anonymous access
check "orders unauthorized" "$BASE_URL/api/orders" 401
# Note: NextAuth/middleware may 307-redirect unauthorized users to /auth/signin
check "admin dashboard unauthorized" "$BASE_URL/api/admin/dashboard" 401,307

log "Smoke tests completed successfully."
