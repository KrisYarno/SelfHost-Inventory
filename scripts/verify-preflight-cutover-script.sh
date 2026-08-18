#!/usr/bin/env bash
# Self-test for scripts/preflight-overhaul-cutover.sh (contract pack C7b.3 "a bats-free
# shell self-test").
#
# The preflight is a script Kris runs ONCE, against PRODUCTION, at the one moment in
# this lane where being wrong is expensive: a mis-parsed "0" would wave a cutover
# through with pre-staging boxes still queued. So its two decisions — the SQL it sends
# and the GO/NO-GO it derives from the answer — are pinned here.
#
# NOTHING REAL IS CONTACTED. `PREFLIGHT_COMPOSE_CMD` points the preflight at a stub
# that records its argv, swallows the piped SQL and prints a canned two-count line.
# This test never runs `docker compose`, never touches a database and never needs one.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PREFLIGHT="$ROOT/scripts/preflight-overhaul-cutover.sh"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

FAILURES=0

fail() {
  echo "PREFLIGHT SELF-TEST: FAIL [$1] $2" >&2
  FAILURES=$((FAILURES + 1))
}

assert_eq() {
  [ "$2" = "$3" ] || fail "$1" "want=[$3] got=[$2]"
}

assert_contains() {
  case "$2" in
    *"$3"*) ;;
    *) fail "$1" "output does not contain [$3]; got=[$2]" ;;
  esac
}

assert_not_contains() {
  case "$2" in
    *"$3"*) fail "$1" "output unexpectedly contains [$3]" ;;
    *) ;;
  esac
}

# The stub compose command. It behaves like `docker compose ... exec -T db sh -lc ...`
# in the two ways the preflight depends on: it consumes stdin, and it writes the
# result to stdout.
cat >"$WORK/compose-stub" <<'STUB'
#!/usr/bin/env bash
set -eu
cat >"$STUB_DIR/stdin.txt"
printf '%s\n' "$@" >"$STUB_DIR/argv.txt"
[ "${STUB_EXIT:-0}" = "0" ] || exit "$STUB_EXIT"
printf '%s\n' "$STUB_OUTPUT"
STUB
chmod +x "$WORK/compose-stub"

# Run the preflight with the stub in front of it. Echoes "<exit code>|<output>".
run_preflight() {
  local output rc
  set +e
  output=$(
    PREFLIGHT_COMPOSE_CMD="$WORK/compose-stub" \
    STUB_DIR="$WORK" \
    STUB_OUTPUT="${STUB_OUTPUT:-}" \
    STUB_EXIT="${STUB_EXIT:-0}" \
    "$PREFLIGHT" "$@" 2>&1
  )
  rc=$?
  set -e
  printf '%s|%s' "$rc" "$output"
}

EXPECTED_SQL="SELECT (SELECT COUNT(*) FROM inbound_shipments WHERE status='OPEN' AND orderedAt IS NULL), (SELECT COUNT(*) FROM staging_items WHERE status='RECEIVED');"

# --------------------------------------------------------------------------
# 1. --print-sql prints the counting statement and NOTHING else.
# --------------------------------------------------------------------------
set +e
SQL_OUT=$("$PREFLIGHT" --print-sql 2>&1)
SQL_RC=$?
set -e
assert_eq "print-sql exit code" "$SQL_RC" "0"
assert_eq "print-sql output" "$SQL_OUT" "$EXPECTED_SQL"

# --------------------------------------------------------------------------
# 2. --print-runbook prints BOTH straggler procedures, verbatim SQL.
# --------------------------------------------------------------------------
set +e
RUNBOOK_OUT=$("$PREFLIGHT" --print-runbook 2>&1)
RUNBOOK_RC=$?
set -e
assert_eq "print-runbook exit code" "$RUNBOOK_RC" "0"
assert_contains "runbook (a) discard" "$RUNBOOK_OUT" "(a) DISCARD a cutover straggler"
assert_contains "runbook (b) hand-link" "$RUNBOOK_OUT" "(b) HAND-LINK a cutover straggler"
assert_contains "runbook discard guard" "$RUNBOOK_OUT" "AND status = 'RECEIVED'"
assert_contains "runbook discard note" "$RUNBOOK_OUT" "[cutover straggler discarded]"
assert_contains "runbook row-count check" "$RUNBOOK_OUT" "SELECT ROW_COUNT()"
assert_contains "runbook new line is VERIFIED" "$RUNBOOK_OUT" "SELECT p.name, 'VERIFIED', @targetOrder,"
assert_contains "runbook verified count is the COUNT" "$RUNBOOK_OUT" "s.countedQuantity, @actor, UTC_TIMESTAMP(3), @choice,"
assert_contains "runbook captures the new line id" "$RUNBOOK_OUT" "SET @newLine = LAST_INSERT_ID();"
assert_contains "runbook register row" "$RUNBOOK_OUT" "'recv-discrepancy',"
assert_contains "runbook unordered subject" "$RUNBOOK_OUT" "'expectedQty',       NULL,"
assert_contains "runbook audit fan-out (create)" "$RUNBOOK_OUT" "'STAGING_CREATE'"
assert_contains "runbook audit fan-out (discard)" "$RUNBOOK_OUT" "'STAGING_DISCARD'"
assert_contains "runbook commits" "$RUNBOOK_OUT" "COMMIT;"
# The two rules the runbook exists to keep: never infer the count, never invent money.
assert_contains "runbook never infers verifiedQuantity" "$RUNBOOK_OUT" "NEVER \`expectedQuantity\`"
assert_contains "runbook never fabricates a total" "$RUNBOOK_OUT" "a line total is NEVER fabricated"

# --------------------------------------------------------------------------
# 3. THE GO PARSE. "0\t0" is the ONLY output that clears the cutover.
# --------------------------------------------------------------------------
STUB_OUTPUT=$'0\t0' STUB_EXIT=0
RESULT=$(STUB_OUTPUT=$'0\t0' run_preflight -- -f docker-compose.yml -f compose.stack.yml --env-file .env)
GO_RC="${RESULT%%|*}"
GO_OUT="${RESULT#*|}"
assert_eq "GO exit code" "$GO_RC" "0"
assert_eq "GO output" "$GO_OUT" "PREFLIGHT: GO"

# The compose arguments after `--` reach compose verbatim, in order, followed by the
# exec form the pack froze.
ARGV=$(cat "$WORK/argv.txt")
EXPECTED_ARGV=$'-f\ndocker-compose.yml\n-f\ncompose.stack.yml\n--env-file\n.env\nexec\n-T\ndb\nsh\n-lc\nexport MYSQL_PWD="$MYSQL_PASSWORD"; exec mysql --batch --skip-column-names -u"$MYSQL_USER" "$MYSQL_DATABASE"'
assert_eq "compose argv" "$ARGV" "$EXPECTED_ARGV"

# The statement really did travel on stdin.
assert_eq "piped SQL" "$(cat "$WORK/stdin.txt")" "$EXPECTED_SQL"

# --------------------------------------------------------------------------
# 4. THE NO-GO PARSE. Non-zero counts are named and the runbook is pointed at.
# --------------------------------------------------------------------------
RESULT=$(STUB_OUTPUT=$'2\t1' run_preflight -- -f docker-compose.yml)
NOGO_RC="${RESULT%%|*}"
NOGO_OUT="${RESULT#*|}"
assert_eq "NO-GO exit code" "$NOGO_RC" "1"
assert_contains "NO-GO line" "$NOGO_OUT" "PREFLIGHT: NO-GO (open=2, received=1)"
assert_contains "NO-GO runbook pointer" "$NOGO_OUT" "--print-runbook"
assert_not_contains "NO-GO does not claim GO" "$NOGO_OUT" "PREFLIGHT: GO"

# A single non-zero count is still a NO-GO.
RESULT=$(STUB_OUTPUT=$'0\t3' run_preflight -- -f docker-compose.yml)
assert_eq "one non-zero count exits 1" "${RESULT%%|*}" "1"
assert_contains "one non-zero count is named" "${RESULT#*|}" "PREFLIGHT: NO-GO (open=0, received=3)"

# --------------------------------------------------------------------------
# 5. FAIL CLOSED. Unreadable output and a failing compose are exit 2 — never GO.
# --------------------------------------------------------------------------
RESULT=$(STUB_OUTPUT='ERROR 1045 (28000): Access denied' run_preflight -- -f docker-compose.yml)
assert_eq "garbage output exits 2" "${RESULT%%|*}" "2"
assert_not_contains "garbage output is not a GO" "${RESULT#*|}" "PREFLIGHT: GO"

RESULT=$(STUB_OUTPUT='' STUB_EXIT=7 run_preflight -- -f docker-compose.yml)
assert_eq "compose failure exits 2" "${RESULT%%|*}" "2"
assert_not_contains "compose failure is not a GO" "${RESULT#*|}" "PREFLIGHT: GO"

RESULT=$(STUB_OUTPUT=$'0\t0' run_preflight --nonsense)
assert_eq "unknown argument exits 2" "${RESULT%%|*}" "2"

# --------------------------------------------------------------------------
# 6. SECRET HYGIENE, statically. No inline -p<password>, no set -x, and the password
#    is only ever named inside the single-quoted in-container shell string.
# --------------------------------------------------------------------------
if grep -qE '(^|[^-])-p"?\$' "$PREFLIGHT"; then
  fail "secret hygiene" "the preflight passes a password on the mysql command line"
fi
if grep -qE '^[[:space:]]*set[[:space:]]+-x' "$PREFLIGHT"; then
  fail "secret hygiene" "the preflight enables set -x"
fi
if grep -qE 'echo .*MYSQL_(PASSWORD|PWD)|printf .*MYSQL_(PASSWORD|PWD)' "$PREFLIGHT"; then
  fail "secret hygiene" "the preflight prints a credential"
fi

if [ "$FAILURES" -ne 0 ]; then
  echo "PREFLIGHT SELF-TEST: $FAILURES check(s) FAILED" >&2
  exit 1
fi

echo "PREFLIGHT SELF-TEST: PASS (print-sql, print-runbook, compose argv, GO/NO-GO parse, fail-closed, secret hygiene)"
