#!/usr/bin/env bash
# scripts/test-crash-resume-drill.sh — Offline drill that proves the
# crash-resume fix (commit 866d625) works.
#
# What this does:
#   - Runs the existing offline test suite (scripts/test-seed-pools.ts) which
#     contains 3 regression tests for the resume helper:
#       Test  8: loadPriorNotesForResume returns [] when no file exists
#       Test  9: loadPriorNotesForResume round-trips a partial prior run
#       Test 10: loadPriorNotesForResume refuses to clobber with a wrong key
#   - Greps the suite output for those 3 PASS lines and reports a clear
#     drill-level pass/fail.
#   - Exits non-zero on any failure.
#
# This drill is COMPLETELY OFFLINE:
#   - No RPC calls
#   - No real signing keys (test uses a fixed 32-byte zero key)
#   - No chain interaction
#   - Synthetic seed notes built in-memory via makeNote() helper
#
# The drill is a thin wrapper — all the bug-scenario coverage lives in
# scripts/test-seed-pools.ts (testResumeReturnsEmptyWhenNoFile,
# testResumeLoadsPriorRun, testResumeRefusesWrongKey). We deliberately do not
# duplicate that logic here.
#
# Usage:
#   scripts/test-crash-resume-drill.sh
#
# Exit codes:
#   0  all 3 resume regression tests passed
#   1  one or more tests failed (or suite did not run cleanly)
#   2  pre-flight failure (missing tooling, wrong cwd)

set -u

if [ -t 2 ]; then
  RED="$(printf '\033[31m')"; YEL="$(printf '\033[33m')"
  GRN="$(printf '\033[32m')"; BLU="$(printf '\033[34m')"
  BLD="$(printf '\033[1m')";  RST="$(printf '\033[0m')"
else
  RED=""; YEL=""; GRN=""; BLU=""; BLD=""; RST=""
fi

die()  { printf "%s[drill] FATAL:%s %s\n" "$RED$BLD" "$RST" "$1" >&2; exit "${2:-1}"; }
info() { printf "%s[drill]%s %s\n" "$BLU" "$RST" "$1" >&2; }
ok()   { printf "%s[drill] PASS:%s %s\n" "$GRN" "$RST" "$1" >&2; }
nok()  { printf "%s[drill] FAIL:%s %s\n" "$RED$BLD" "$RST" "$1" >&2; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Pre-flight ───────────────────────────────────────────────────────────────
if [ ! -f "$REPO_ROOT/scripts/test-seed-pools.ts" ]; then
  die "scripts/test-seed-pools.ts not found in $REPO_ROOT — wrong cwd?" 2
fi
if [ ! -f "$REPO_ROOT/scripts/seed-pools.ts" ]; then
  die "scripts/seed-pools.ts not found in $REPO_ROOT — wrong cwd?" 2
fi

if ! command -v node >/dev/null 2>&1; then
  die "node not on PATH" 2
fi
if ! command -v npx >/dev/null 2>&1; then
  die "npx not on PATH" 2
fi

info "OFFLINE crash-resume drill — proves commit 866d625 (allNotes resume fix)"
info "repo root: $REPO_ROOT"
info "running offline test suite (no RPC, no signing, synthetic notes only)"

# ── Run the suite, capture stdout ───────────────────────────────────────────
# We capture to a temp file so we can both stream it AND grep specific PASS lines.
TMP_OUT="$(mktemp -t zbase-drill-XXXXXX)"
# shellcheck disable=SC2064
trap "rm -f '$TMP_OUT'" EXIT

set +e
(cd "$REPO_ROOT" && npx --yes tsx scripts/test-seed-pools.ts) 2>&1 | tee "$TMP_OUT"
SUITE_EXIT="${PIPESTATUS[0]}"
set -e
set +e

printf '\n' >&2
info "suite exit code: $SUITE_EXIT"
info "extracting the 3 resume regression results..."
printf '\n' >&2

# ── Extract drill-relevant results ──────────────────────────────────────────
# test-seed-pools.ts emits PASS / FAIL lines like:
#   "  PASS  resume: empty when no file"
#   "  PASS  resume: loads prior partial run"
#   "  PASS  resume: wrong key refuses to clobber"

EXPECTED_TESTS="
resume: empty when no file
resume: loads prior partial run
resume: wrong key refuses to clobber
"

DRILL_FAILED=0

# POSIX-safe loop over the expected labels.
while IFS= read -r label; do
  case "$label" in
    "") continue ;;
  esac

  if grep -F -q "PASS  $label" "$TMP_OUT"; then
    ok "$label"
  elif grep -F -q "FAIL  $label" "$TMP_OUT"; then
    nok "$label  (suite reported FAIL — see output above)"
    DRILL_FAILED=$((DRILL_FAILED + 1))
  else
    nok "$label  (test did not run — suite may have aborted before reaching it)"
    DRILL_FAILED=$((DRILL_FAILED + 1))
  fi
done <<EOF
$EXPECTED_TESTS
EOF

# ── Drill verdict ───────────────────────────────────────────────────────────
printf '\n' >&2
printf "%s========== crash-resume drill verdict ==========%s\n" "$BLD" "$RST" >&2

if [ "$DRILL_FAILED" -eq 0 ] && [ "$SUITE_EXIT" -eq 0 ]; then
  printf "%sALL 3 RESUME REGRESSION TESTS PASSED%s\n" "$GRN$BLD" "$RST" >&2
  printf "Commit 866d625 (resume fix) is intact. Seed script will not double-deposit\n" >&2
  printf "on crash-restart.\n" >&2
  printf "%s================================================%s\n\n" "$BLD" "$RST" >&2
  exit 0
fi

if [ "$DRILL_FAILED" -gt 0 ]; then
  printf "%s%d OF 3 RESUME REGRESSION TESTS FAILED%s\n" "$RED$BLD" "$DRILL_FAILED" "$RST" >&2
  printf "The crash-resume safety property has REGRESSED. Do NOT run seed-pools.ts live.\n" >&2
  printf "Inspect $TMP_OUT (preserved on failure) and the suite output above.\n" >&2
  # Disarm the cleanup trap so the operator can inspect the temp file
  trap - EXIT
  printf "Suite output saved to: %s\n" "$TMP_OUT" >&2
  printf "%s================================================%s\n\n" "$BLD" "$RST" >&2
  exit 1
fi

# DRILL_FAILED == 0 but SUITE_EXIT != 0 means a NON-resume test failed.
printf "%sRESUME TESTS PASSED but suite exit was %d (other tests failed).%s\n" \
  "$YEL$BLD" "$SUITE_EXIT" "$RST" >&2
printf "The resume regression coverage is green, but the overall suite is red.\n" >&2
printf "Investigate the FAIL lines in the output above before continuing.\n" >&2
trap - EXIT
printf "Suite output saved to: %s\n" "$TMP_OUT" >&2
printf "%s================================================%s\n\n" "$BLD" "$RST" >&2
exit 1
