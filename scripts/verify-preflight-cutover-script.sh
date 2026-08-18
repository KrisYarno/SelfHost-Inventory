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

# The haystack here is a 270-line SQL runbook; echoing it back buries the label that
# says WHICH pin broke. Report the needle, not the hay.
assert_contains() {
  case "$2" in
    *"$3"*) ;;
    *) fail "$1" "output does not contain [$3]" ;;
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

EXPECTED_SQL="SELECT (SELECT COUNT(*) FROM inbound_shipments WHERE status='OPEN'), (SELECT COUNT(*) FROM staging_items WHERE status='RECEIVED');"

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
# THE MECHANICAL GUARDS (rehearsal finding: a human-read `SELECT ROW_COUNT();`
# checkpoint is not a guard — re-running (a) on an already-DISCARDED row inserted a
# SECOND audit row). Every guarded write captures its outcome into a flag, and every
# later write is gated on the accumulated flags.
assert_contains "runbook (a) captures rc1" "$RUNBOOK_OUT" "SET @rc1 = ROW_COUNT();"
assert_contains "runbook (b) captures rc2" "$RUNBOOK_OUT" "SET @rc2 = ROW_COUNT();"
assert_contains "runbook (b) captures rc3" "$RUNBOOK_OUT" "SET @rc3 = ROW_COUNT();"
assert_contains "runbook (a) gates its audit row" "$RUNBOOK_OUT" " WHERE @rc1 = 1;"
assert_contains "runbook (b) validates the source as a flag" "$RUNBOOK_OUT" "SELECT COUNT(*) INTO @okSource"
assert_contains "runbook (b) validates the order as a flag" "$RUNBOOK_OUT" "SELECT COUNT(*) INTO @okOrder"
assert_contains "runbook (b) validates the product as a flag" "$RUNBOOK_OUT" "SELECT COUNT(*) INTO @okProduct"
assert_contains "runbook (b) gates the new line on all three flags" "$RUNBOOK_OUT" "   AND @okSource  = 1"
assert_contains "runbook (b) gates the register row" "$RUNBOOK_OUT" "   AND @rc1 = 1;"
assert_contains "runbook (b) gates the source close" "$RUNBOOK_OUT" "   AND @rc2 = 1;"
assert_contains "runbook (b) gates both audit rows" "$RUNBOOK_OUT" " WHERE @rc1 = 1 AND @rc2 = 1 AND @rc3 = 1;"
# Three gated INSERT ... SELECT writes in all: (a)'s audit row, (b)'s two.
DUAL_GATES=$(printf '%s\n' "$RUNBOOK_OUT" | grep -c "FROM DUAL")
[ "$DUAL_GATES" -ge 3 ] || fail "runbook gated inserts" "expected at least 3 FROM DUAL gates, found $DUAL_GATES"
# NO human-only checkpoint may come back: this is the exact regression the
# rehearsal found, and prose is where it would reappear.
assert_not_contains "runbook has no human-read row-count checkpoint" "$RUNBOOK_OUT" "MUST be 1"
assert_not_contains "runbook has no human-read validation checkpoint" "$RUNBOOK_OUT" "MUST return exactly"
# THE VERDICT ROW — the last thing read before COMMIT, in both procedures.
assert_contains "runbook (a) verdict ok" "$RUNBOOK_OUT" "'OK — commit',"
assert_contains "runbook (a) verdict refusal" "$RUNBOOK_OUT" \
  "'NOTHING CHANGED — precondition failed (row not RECEIVED); COMMIT is a no-op'"
assert_contains "runbook (b) verdict refusal" "$RUNBOOK_OUT" \
  "'NOTHING CHANGED — precondition failed (row not RECEIVED / order not a RECEIVING|CLOSED supply order / product not eligible); COMMIT is a no-op'"
assert_contains "runbook (b) verdict is gated on every flag" "$RUNBOOK_OUT" "SELECT IF(@rc1 = 1 AND @rc2 = 1 AND @rc3 = 1,"
assert_contains "runbook new line is VERIFIED" "$RUNBOOK_OUT" "SELECT p.name, 'VERIFIED', @targetOrder,"
assert_contains "runbook verified count is the COUNT" "$RUNBOOK_OUT" "s.countedQuantity, @actor, UTC_TIMESTAMP(3), @choice,"
assert_contains "runbook captures the new line id only on success" "$RUNBOOK_OUT" \
  "SET @newLine = IF(@rc1 = 1, LAST_INSERT_ID(), NULL);"
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

# --------------------------------------------------------------------------
# 7. ROW_COUNT ADJACENCY (rehearsal 2026-08-18): the MySQL 8 client sends a comment-only
#    line to the server as its own statement, which resets ROW_COUNT() to 0. So the line
#    right BEFORE every `SET @rcN = ROW_COUNT();` must be the write's terminating `;`
#    line — never a comment, never blank.
# --------------------------------------------------------------------------
RUNBOOK_TEXT=$("$PREFLIGHT" --print-runbook)
ADJ_BAD=$(printf '%s\n' "$RUNBOOK_TEXT" | awk '
  /^SET @rc[0-9]+ = ROW_COUNT\(\);/ { if (prev !~ /;[[:space:]]*$/ || prev ~ /^[[:space:]]*--/) { print NR": "prev } }
  { prev = $0 }')
if [ -n "$ADJ_BAD" ]; then
  fail "ROW_COUNT capture adjacency" "a comment/blank line precedes a SET @rcN capture: $ADJ_BAD"
fi
ADJ_COUNT=$(printf '%s\n' "$RUNBOOK_TEXT" | grep -c '^SET @rc[0-9]* = ROW_COUNT();')
if [ "$ADJ_COUNT" -lt 4 ]; then
  fail "ROW_COUNT captures present" "expected >= 4 captures, found $ADJ_COUNT"
fi

# --------------------------------------------------------------------------
# 8. THE PREDICATE MUST RUN ON *LIVE* (codex CR-3, spec REV-10 clause 5). The mandated
#    order is fence -> preflight -> `migrate deploy`, so the counting SQL runs against
#    the PRE-migration schema: naming a column this lane ADDS would fail "Unknown
#    column" exactly when the check matters most. A NEGATIVE pin, because that failure
#    mode reads perfectly well in review — the column exists everywhere the author looks.
# --------------------------------------------------------------------------
for COLUMN in orderedAt supplier feesCents feesNote resolution bookingKey \
    receiptCostCents stagingItemId disposedQuantity labelingRequired lineTotalCents \
    orderedProductId orderedQuantity stockedQuantity verifiedAt verifiedBy \
    verifiedQuantity; do
  assert_not_contains "runtime SQL is pre-migration safe" "$SQL_OUT" "$COLUMN"
done

if [ "$FAILURES" -ne 0 ]; then
  echo "PREFLIGHT SELF-TEST: $FAILURES check(s) FAILED" >&2
  exit 1
fi

echo "PREFLIGHT SELF-TEST: PASS (print-sql, pre-migration-safe predicate, print-runbook + mechanical guards + ROW_COUNT adjacency, compose argv, GO/NO-GO parse, fail-closed, secret hygiene)"
