#!/usr/bin/env bash
# Prep the demo-recording staging state from docs/demo-runbook.md (section 0).
#
# Everything before the actual recording, in one idempotent command:
#   1. prerequisites + build
#   2. deterministic seed (dry-run invariant check, then real seed if needed)
#   3. fresh audit file + demo env (plan TTL, caller id)
#   4. server up with the localhost approval UI
#   5. optional MCP baseline (search_products) matching runbook 0.6
#
# Usage (from the repo root, via `npm run demo:prep`):
#   bash scripts/demo-prep.sh [--force-reseed] [--skip-seed] [--skip-build]
#                             [--no-server] [--baseline] [--stop-server]
#                             [--store-domain <d>] [--audit-path <p>]
#
# --store-domain sets only SHOPIFY_STORE_DOMAIN; SHOPIFY_ADMIN_TOKEN comes
# exclusively from the environment or the gitignored .env file (which may use
# the legacy SHOPIFY_SHOP_DOMAIN name). The token is never committed.
#
# Idempotent: a re-run skips the seed when the store is already seeded and
# reuses a healthy server; the audit file is always reset to an empty chain.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\n==> %s\n' "$*"; }
ok() { printf '    ok: %s\n' "$*"; }
warn() { printf '    warn: %s\n' "$*" >&2; }
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# --- flags ------------------------------------------------------------------
FORCE_RESEED=0
SKIP_SEED=0
SKIP_BUILD=0
NO_SERVER=0
DO_BASELINE=0
STOP_SERVER=0
OPT_STORE_DOMAIN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force-reseed) FORCE_RESEED=1 ;;
    --skip-seed) SKIP_SEED=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --no-server) NO_SERVER=1 ;;
    --baseline) DO_BASELINE=1 ;;
    --stop-server) STOP_SERVER=1 ;;
    --store-domain) OPT_STORE_DOMAIN="${2:?--store-domain needs a value}"; shift ;;
    --audit-path) SHOPIFY_AUDIT_PATH="${2:?--audit-path needs a value}"; shift ;;
    -h|--help)
      sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument \"$1\" (see --help)" ;;
  esac
  shift
done

# --- credentials -------------------------------------------------------------
# Source the gitignored .env (domain/token) if present; allow the legacy
# SHOPIFY_SHOP_DOMAIN name the repo's .env uses.
if [[ -f .env ]]; then
  # The repo .env is CRLF; strip \r so values don't carry a trailing CR.
  set -a
  # shellcheck disable=SC1091
  source <(tr -d '\r' < .env)
  set +a
fi
if [[ -z "${SHOPIFY_STORE_DOMAIN:-}" && -n "${SHOPIFY_SHOP_DOMAIN:-}" ]]; then
  SHOPIFY_STORE_DOMAIN="$SHOPIFY_SHOP_DOMAIN"
fi
if [[ -n "$OPT_STORE_DOMAIN" ]]; then SHOPIFY_STORE_DOMAIN="$OPT_STORE_DOMAIN"; fi

if [[ "$STOP_SERVER" -ne 1 ]]; then
  [[ -n "${SHOPIFY_STORE_DOMAIN:-}" ]] || die "SHOPIFY_STORE_DOMAIN is not set (env, --store-domain, or .env)"
  [[ "$SHOPIFY_STORE_DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.myshopify\.com$ ]] \
    || die "SHOPIFY_STORE_DOMAIN must be a canonical *.myshopify.com hostname (got \"$SHOPIFY_STORE_DOMAIN\")"
  [[ -n "${SHOPIFY_ADMIN_TOKEN:-}" ]] || die "SHOPIFY_ADMIN_TOKEN is not set (env or .env)"
  export SHOPIFY_STORE_DOMAIN SHOPIFY_ADMIN_TOKEN
fi

# Demo env (runbook 0.3): comfortable approval window, attributable caller,
# fresh audit file per take.
export SHOPIFY_PLAN_TTL_MS="${SHOPIFY_PLAN_TTL_MS:-600000}"
export SHOPIFY_CALLER_ID="${SHOPIFY_CALLER_ID:-loom-demo}"
export SHOPIFY_AUDIT_PATH="${SHOPIFY_AUDIT_PATH:-/tmp/shopify-demo-audit.jsonl}"
PORT="${SHOPIFY_APPROVAL_SERVER_PORT:-4319}"
PIDFILE="${SHOPIFY_DEMO_PIDFILE:-/tmp/shopify-demo-server.pid}"
SERVER_LOG="${SHOPIFY_DEMO_LOG:-/tmp/shopify-demo-server.log}"

server_pid() { [[ -f "$PIDFILE" ]] && sed -n '1p' "$PIDFILE" || echo ""; }
server_started_at() { [[ -f "$PIDFILE" ]] && sed -n '2p' "$PIDFILE" || echo ""; }
# A stale PID reused by another process has a different start time, so the
# recorded start time is a stable identity that only the same process instance
# matches. Old single-line pidfiles have no start time and are treated as stale.
server_proc_is_demo() {
  local pid="$1" expected; expected="$(server_started_at)"
  [[ -n "$pid" && -n "$expected" ]] \
    && [[ "$expected" == "$(ps -p "$pid" -o lstart= 2>/dev/null)" ]]
}
server_alive() {
  local pid; pid="$(server_pid)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && server_proc_is_demo "$pid"
}
approval_up() { curl -sf --max-time 2 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; }

stop_server() {
  local pid; pid="$(server_pid)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    if ! server_proc_is_demo "$pid"; then
      warn "pid $pid in $PIDFILE is not the demo server; removing stale pidfile without signaling it"
      rm -f "$PIDFILE"
      return
    fi
    say "Stopping demo server (pid $pid)"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      # The pid must still be our process; if it was reused after the demo
      # process exited, stop waiting and leave the new process alone.
      server_proc_is_demo "$pid" || break
      sleep 0.5
    done
    if kill -0 "$pid" 2>/dev/null && server_proc_is_demo "$pid"; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$PIDFILE"
}

if [[ "$STOP_SERVER" -eq 1 ]]; then
  stop_server
  ok "server stopped; audit file left as-is at $SHOPIFY_AUDIT_PATH"
  exit 0
fi

# --- 1. prerequisites + build -------------------------------------------------
if [[ "$SKIP_BUILD" -eq 0 ]]; then
  say "Prerequisites and build"
  command -v node >/dev/null || die "node not found (needs Node 18+)"
  command -v npm >/dev/null || die "npm not found"
  node --version
  npm --version
  [[ -d node_modules ]] || npm install
  npm run build
  [[ -f dist/index.js ]] || die "build did not produce dist/index.js"
else
  ok "skipped build (--skip-build)"
fi

# --- 2. seed ------------------------------------------------------------------
# Dry-run first: asserts the sizing invariants with zero API calls.
SEED_DRY_OUT=""
if [[ "$SKIP_SEED" -eq 0 ]]; then
  say "Seed dry-run (no API calls; asserts 768 / 156 invariants)"
  SEED_DRY_OUT="$(npm run seed -- --seed 42 --dry-run 2>&1)"
  printf '%s\n' "$SEED_DRY_OUT"
  grep -qE 'variants:[[:space:]]+768' <<<"$SEED_DRY_OUT" \
    || die "dry run: expected 768 variants (see docs/demo-runbook.md 0.2)"
  grep -qE 'tagged "sale":[[:space:]]+156' <<<"$SEED_DRY_OUT" \
    || die "dry run: expected 156 sale-tagged variants (see docs/demo-runbook.md 0.2)"
  ok "dry run invariants hold"

  if [[ "$FORCE_RESEED" -eq 1 ]]; then
    say "Seeding the store (--force-reseed)"
    npm run seed -- --seed 42 --order-delay-ms 1200
  else
    say "Checking whether the store is already seeded"
    seeded="$(node --input-type=module -e '
      const { SHOPIFY_STORE_DOMAIN: domain, SHOPIFY_ADMIN_TOKEN: token } = process.env;
      const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-04";
      const res = await fetch(`https://${domain}/admin/api/${apiVersion}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token.trim() },
        body: JSON.stringify({
          query: "query($q: String!){ products(first: 250, query: $q) { edges { node { id } } pageInfo { hasNextPage } } }",
          variables: { q: "tag:seeded-store" },
        }),
      });
      if (!res.ok) { console.error(`HTTP ${res.status}: ${await res.text()}`); process.exit(3); }
      const body = await res.json();
      if (body.errors?.length) { console.error(JSON.stringify(body.errors)); process.exit(3); }
      console.log((body.data?.products?.edges ?? []).length);
    ')" || { echo "$seeded" >&2; die "could not query the store to check for an existing seed"; }
    printf '    seeded-store products found: %s\n' "$seeded"
    if [[ "$seeded" -ge 250 ]]; then
      ok "store already seeded (300 products expected) — skipping the ~24 min seed; use --force-reseed to regenerate"
    else
      say "Seeding the store (this takes ~24 min with --order-delay-ms 1200)"
      npm run seed -- --seed 42 --order-delay-ms 1200
    fi
  fi
else
  ok "skipped seeding (--skip-seed)"
fi

# --- 3. fresh audit file -------------------------------------------------------
say "Stage a fresh audit chain"
if [[ -e "$SHOPIFY_AUDIT_PATH" ]]; then
  # A take already wrote rows (or an earlier server created the file). Restart
  # the server so the fresh chain is the one its file descriptor writes to.
  if server_alive; then
    stop_server
  fi
  rm -f "$SHOPIFY_AUDIT_PATH"
fi
[[ ! -e "$SHOPIFY_AUDIT_PATH" ]] || die "could not clear audit file $SHOPIFY_AUDIT_PATH"
ok "audit chain reset (will be created on first write): $SHOPIFY_AUDIT_PATH"

# --- 4. server ------------------------------------------------------------------
if [[ "$NO_SERVER" -eq 1 ]]; then
  ok "skipped server (--no-server)"
else
  if server_alive && approval_up; then
    ok "server already running (pid $(server_pid))"
  else
    if server_alive; then
      warn "server pid $(server_pid) is alive but the approval UI on $PORT does not respond; restarting"
      stop_server
    fi
    if approval_up; then
      die "port $PORT is already in use by something else — stop it or set SHOPIFY_APPROVAL_SERVER_PORT (runbook Appendix C)"
    fi
    say "Starting server (node dist/index.js)"
    nohup node dist/index.js >"$SERVER_LOG" 2>&1 &
    printf '%s\n%s\n' "$!" "$(ps -p "$!" -o lstart= 2>/dev/null)" > "$PIDFILE"
    # disown so the server survives this script exiting
    disown "$!" 2>/dev/null || true
    for _ in $(seq 1 30); do
      if approval_up; then break; fi
      if ! server_alive; then
        cat "$SERVER_LOG" >&2
        die "server exited during startup — see $SERVER_LOG"
      fi
      sleep 1
    done
    approval_up || { cat "$SERVER_LOG" >&2; die "approval UI did not come up on port $PORT" ; }
    grep -q "localhost approval UI listening" "$SERVER_LOG" \
      || warn "startup log did not show the expected 'localhost approval UI listening' line — check $SERVER_LOG"
    ok "server running (pid $(server_pid)); approval UI on http://127.0.0.1:$PORT"
  fi
fi

# --- 5. baseline -----------------------------------------------------------------
if [[ "$DO_BASELINE" -eq 1 ]]; then
  say "Baseline MCP check: search_products (runbook 0.6)"
  node scripts/demo-baseline.mjs
fi

# --- summary ---------------------------------------------------------------------
say "Demo staging ready"
printf '    store:        %s\n' "$SHOPIFY_STORE_DOMAIN"
printf '    plan TTL:     %s ms\n' "$SHOPIFY_PLAN_TTL_MS"
printf '    caller id:    %s\n' "$SHOPIFY_CALLER_ID"
printf '    audit file:   %s (fresh)\n' "$SHOPIFY_AUDIT_PATH"
printf '    approval UI:  http://127.0.0.1:%s\n' "$PORT"
printf '    server pid:   %s\n' "$(server_pid)"
printf '    server log:   %s\n' "$SERVER_LOG"
printf '\nRemaining manual step: connect an MCP client (runbook 0.5), then record Beats 1-5.\n'
printf 'Stop the staged server afterwards with:  bash scripts/demo-prep.sh --stop-server\n'