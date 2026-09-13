#!/usr/bin/env bash
# scripts/env-doctor.sh — Compare .env.local against .env.local.example.
#
# For every variable line in .env.local.example, print one of:
#   ✓ SET     — key present in .env.local with a non-empty value (value NEVER echoed)
#   ○ BLANK   — key present but value empty (marked "(may be intentional)" if OPTIONAL)
#   ✗ MISSING — key absent from .env.local
#
# Flags:
#   --fix     append placeholder lines (KEY=) to .env.local for MISSING vars only
#   --quiet   suppress per-key output; only the summary line prints
#   --help    show usage
#
# Exit:
#   0  all REQUIRED vars are set
#   1  one or more REQUIRED vars MISSING or BLANK
#
# Constraints:
#   - bash 3.2 safe (macOS default)
#   - NEVER reads or echoes a value back to stdout/stderr
#   - --fix only appends placeholders for MISSING; never overwrites existing lines
#   - The description shown for each key is the LAST comment line immediately
#     above the KEY=... line in .env.local.example (truncated to one line).

set -u

# ── Locations ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXAMPLE_FILE="$REPO_ROOT/.env.local.example"
ENV_FILE="$REPO_ROOT/.env.local"

# ── Colors (no-op when not a TTY) ────────────────────────────────────────────
if [ -t 1 ]; then
  RED="$(printf '\033[31m')"
  YEL="$(printf '\033[33m')"
  GRN="$(printf '\033[32m')"
  DIM="$(printf '\033[2m')"
  BLD="$(printf '\033[1m')"
  RST="$(printf '\033[0m')"
else
  RED=""; YEL=""; GRN=""; DIM=""; BLD=""; RST=""
fi

# ── CLI parsing ──────────────────────────────────────────────────────────────
FIX=0
QUIET=0

usage() {
  cat <<'USAGE'
Usage: scripts/env-doctor.sh [--fix] [--quiet] [--help]

Compares .env.local against .env.local.example and reports SET / BLANK / MISSING
for every variable in the example file. Values are NEVER echoed.

Flags:
  --fix     Append placeholder lines (KEY=) to .env.local for MISSING keys only.
            BLANK keys are left alone (they may be intentional).
  --quiet   Suppress per-key lines; print summary line only.
  --help    Show this message.

Exit codes:
  0  all REQUIRED vars are set
  1  one or more REQUIRED vars MISSING or BLANK

Recognized markers in .env.local.example comments:
  # REQUIRED  — Sepolia push cannot proceed without this
  # OPTIONAL  — feature works without it, or has a safe default
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --fix)    FIX=1; shift ;;
    --quiet)  QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown flag: %s (try --help)\n' "$1" >&2; exit 2 ;;
  esac
done

# ── Sanity ───────────────────────────────────────────────────────────────────
if [ ! -f "$EXAMPLE_FILE" ]; then
  printf '%s.env.local.example not found at %s%s\n' "$RED" "$EXAMPLE_FILE" "$RST" >&2
  exit 2
fi
if [ ! -f "$ENV_FILE" ]; then
  printf '%s.env.local not found at %s%s\n' "$RED" "$ENV_FILE" "$RST" >&2
  printf '%shint: cp .env.local.example .env.local && ./scripts/env-doctor.sh --fix%s\n' "$DIM" "$RST" >&2
  exit 1
fi

emit() {
  if [ "$QUIET" -eq 0 ]; then
    printf '%s\n' "$*"
  fi
}

# ── Pass 1: parse .env.local.example into parallel arrays ────────────────────
# bash 3.2 lacks associative arrays, so we keep parallel indexed arrays.
KEYS=()           # ordered key names from .env.local.example
DESCS=()          # one-line description (last comment line above KEY=)
OPTIONAL_FLAGS=() # 1 if OPTIONAL, 0 otherwise
EXAMPLE_LINES=()  # full original "KEY=..." line (used for --fix placeholder)

last_comment=""
last_section_is_optional=0

while IFS= read -r raw || [ -n "$raw" ]; do
  # Strip a single leading carriage return (CRLF safety)
  line="${raw%$'\r'}"
  case "$line" in
    "")
      last_comment=""
      ;;
    \#*)
      # Track section-level OPTIONAL markers (e.g. "=== DECOY SCHEDULER (OPTIONAL ...) ===")
      case "$line" in
        *OPTIONAL*) last_section_is_optional=1 ;;
        *REQUIRED*) last_section_is_optional=0 ;;
      esac
      # Capture single-line description = the comment line above the KEY=
      # Strip leading "# " and trailing whitespace.
      stripped="${line#\#}"
      stripped="${stripped# }"
      # Skip pure-decoration lines (--- or === or empty after strip)
      case "$stripped" in
        ---*|===*|"") ;;
        *) last_comment="$stripped" ;;
      esac
      ;;
    [A-Z]*=*|export\ [A-Z]*=*)
      # Variable line
      lhs="${line%%=*}"
      lhs="${lhs#export }"
      key="$(printf '%s' "$lhs" | tr -d '[:space:]')"
      # Validate key looks like A-Z/0-9/_
      case "$key" in
        *[!A-Z0-9_]*) last_comment=""; continue ;;
      esac

      # Determine OPTIONAL/REQUIRED. Per-key marker wins over section default.
      opt=$last_section_is_optional
      case "$last_comment" in
        *OPTIONAL*) opt=1 ;;
        *REQUIRED*) opt=0 ;;
      esac

      # Description: trim to ~100 chars on one line.
      desc="$last_comment"
      if [ -z "$desc" ]; then
        desc="(no description)"
      fi
      desc_len="${#desc}"
      if [ "$desc_len" -gt 100 ]; then
        desc="$(printf '%s' "$desc" | cut -c1-97)..."
      fi

      KEYS=("${KEYS[@]}" "$key")
      DESCS=("${DESCS[@]}" "$desc")
      OPTIONAL_FLAGS=("${OPTIONAL_FLAGS[@]}" "$opt")
      EXAMPLE_LINES=("${EXAMPLE_LINES[@]}" "$line")

      last_comment=""
      ;;
    *)
      last_comment=""
      ;;
  esac
done < "$EXAMPLE_FILE"

# ── Pass 2: check each key against .env.local ────────────────────────────────
# Helper: classify a key as MISSING / BLANK / SET without echoing its value.
#   prints one of: MISSING | BLANK | SET
classify_key() {
  k="$1"
  # Match "KEY=" optionally prefixed by "export " and surrounding whitespace.
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${k}[[:space:]]*=" "$ENV_FILE" 2>/dev/null | head -n1 || true)"
  if [ -z "$line" ]; then
    printf 'MISSING'
    return
  fi
  # Extract everything after the first =, strip surrounding quotes/whitespace.
  val="${line#*=}"
  # Strip leading whitespace
  while [ "${val# }" != "$val" ]; do val="${val# }"; done
  # Strip a single trailing CR (CRLF safety)
  val="${val%$'\r'}"
  # Strip wrapping single or double quotes
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
  esac
  if [ -z "$val" ]; then
    printf 'BLANK'
  else
    printf 'SET'
  fi
  val=""
}

REQ_SET=0
REQ_MISSING=0
REQ_BLANK=0
OPT_SET=0
OPT_BLANK=0
OPT_MISSING=0
APPENDED=0

# Track which keys we appended in --fix mode to avoid double-appends within
# this run (in case .env.local.example has a duplicate key, which it does:
# ZBASE_API appears twice).
APPENDED_KEYS=" "

i=0
n="${#KEYS[@]}"
while [ "$i" -lt "$n" ]; do
  key="${KEYS[$i]}"
  desc="${DESCS[$i]}"
  opt="${OPTIONAL_FLAGS[$i]}"
  status="$(classify_key "$key")"

  case "$status" in
    SET)
      if [ "$opt" = "1" ]; then
        OPT_SET=$((OPT_SET + 1))
      else
        REQ_SET=$((REQ_SET + 1))
      fi
      emit "  ${GRN}✓ SET${RST}     $key"
      ;;
    BLANK)
      if [ "$opt" = "1" ]; then
        OPT_BLANK=$((OPT_BLANK + 1))
        emit "  ${YEL}○ BLANK${RST}   $key  — $desc ${DIM}(may be intentional)${RST}"
      else
        REQ_BLANK=$((REQ_BLANK + 1))
        emit "  ${YEL}○ BLANK${RST}   $key  — $desc"
      fi
      ;;
    MISSING)
      if [ "$opt" = "1" ]; then
        OPT_MISSING=$((OPT_MISSING + 1))
      else
        REQ_MISSING=$((REQ_MISSING + 1))
      fi
      emit "  ${RED}✗ MISSING${RST} $key  — $desc"
      if [ "$FIX" -eq 1 ]; then
        # Skip if already appended this run (handles duplicate keys in example).
        case "$APPENDED_KEYS" in
          *" $key "*) ;;
          *)
            # Append placeholder. Use KEY= form (value blank) — even if the
            # example had a value, we never copy values verbatim (some examples
            # contain placeholder URLs or addresses; safer to leave blank so
            # the operator must fill it consciously).
            {
              printf '\n# Auto-appended by scripts/env-doctor.sh on %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
              printf '%s=\n' "$key"
            } >> "$ENV_FILE"
            APPENDED_KEYS="$APPENDED_KEYS$key "
            APPENDED=$((APPENDED + 1))
            emit "    ${DIM}→ appended placeholder for $key${RST}"
            ;;
        esac
      fi
      ;;
  esac
  i=$((i + 1))
done

# ── Summary ──────────────────────────────────────────────────────────────────
TOTAL_REQ=$((REQ_SET + REQ_BLANK + REQ_MISSING))
TOTAL_OPT=$((OPT_SET + OPT_BLANK + OPT_MISSING))

if [ "$QUIET" -eq 0 ]; then
  printf '\n'
  printf '%s── env-doctor summary ──%s\n' "$BLD" "$RST"
  printf '  required: %s%d set%s / %s%d missing%s / %s%d blank%s   (of %d)\n' \
    "$GRN" "$REQ_SET" "$RST" \
    "$RED" "$REQ_MISSING" "$RST" \
    "$YEL" "$REQ_BLANK" "$RST" \
    "$TOTAL_REQ"
  printf '  optional: %s%d set%s / %s%d missing%s / %s%d blank%s   (of %d)\n' \
    "$GRN" "$OPT_SET" "$RST" \
    "$RED" "$OPT_MISSING" "$RST" \
    "$YEL" "$OPT_BLANK" "$RST" \
    "$TOTAL_OPT"
  if [ "$FIX" -eq 1 ]; then
    printf '  appended placeholders: %d\n' "$APPENDED"
  fi
fi

# Quiet mode: still print one compact summary line.
if [ "$QUIET" -eq 1 ]; then
  printf 'env-doctor: required %d/%d set, %d missing, %d blank · optional %d/%d set, %d missing, %d blank\n' \
    "$REQ_SET" "$TOTAL_REQ" "$REQ_MISSING" "$REQ_BLANK" \
    "$OPT_SET" "$TOTAL_OPT" "$OPT_MISSING" "$OPT_BLANK"
fi

# Exit 0 iff every required var is SET. BLANK required vars also fail.
if [ "$REQ_MISSING" -eq 0 ] && [ "$REQ_BLANK" -eq 0 ]; then
  exit 0
else
  exit 1
fi
