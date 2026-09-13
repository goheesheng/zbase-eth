#!/usr/bin/env bash
# forge-wrap.sh — auto-pick the right FOUNDRY_PROFILE based on args.
#
# 2026-05-31. Authored as a quality-of-life wrapper so the founder doesn't have
# to remember `FOUNDRY_PROFILE=threshold forge test --match-contract
# DeployThresholdEntrypoint -vv` every time. See `foundry.toml` for the two
# profiles this routes between.
#
# Routing rules:
#   --match-contract <ThresholdEntrypoint|DeployThresholdEntrypoint>  -> threshold
#   --match-path <path under zbase-protocol/pkg/contracts/test/...>   -> threshold
#   anything else                                                     -> default
#
# Honors an explicitly-set FOUNDRY_PROFILE in the environment — if you've
# already exported one we don't second-guess you.
#
# Echoes the chosen profile to stderr so it's visible in CI logs but doesn't
# pollute stdout (preserving forge's machine-readable output).
#
# macOS bash 3.2 safe (no associative arrays, no `[[ =~ ]]` with PCRE, no
# `${var,,}` lowercase expansion).
#
# Make executable once:   chmod +x scripts/forge-wrap.sh
# Invoke:                  scripts/forge-wrap.sh test --match-contract Foo -vv

set -eu

# Known contract names that live under the threshold profile's test path.
# Keep this list in sync with new contracts added to
# zbase-protocol/pkg/contracts/test/ over time.
#
# audit-sweep-2026-06-17: added UTXOPool + DeployStaging. They live ONLY under
# the threshold test path, so omitting them routed `--match-contract UTXOPool`
# to the DEFAULT profile, which found 0 tests and exited 0 — a silent false
# green that could "pass" the pool-safety suite while running nothing.
THRESHOLD_CONTRACTS="DeployThresholdEntrypoint ThresholdEntrypoint UTXOPool DeployStaging"

# Path prefix that signals the threshold profile.
THRESHOLD_PATH_PREFIX="zbase-protocol/pkg/contracts/test"

detect_profile() {
    # If user already set one, respect it.
    if [ "${FOUNDRY_PROFILE:-}" != "" ]; then
        printf '%s' "$FOUNDRY_PROFILE"
        return 0
    fi

    # Walk argv looking for --match-contract <name> or --match-path <path>.
    # bash 3.2: use positional shift loop, not arrays of arrays.
    prev=""
    for arg in "$@"; do
        case "$prev" in
            --match-contract)
                for known in $THRESHOLD_CONTRACTS; do
                    if [ "$arg" = "$known" ]; then
                        printf '%s' "threshold"
                        return 0
                    fi
                done
                ;;
            --match-path)
                # Prefix match — bash 3.2 safe (no =~).
                case "$arg" in
                    "$THRESHOLD_PATH_PREFIX"*)
                        printf '%s' "threshold"
                        return 0
                        ;;
                esac
                ;;
        esac

        # Also handle the --match-contract=Foo / --match-path=foo form.
        case "$arg" in
            --match-contract=*)
                val="${arg#--match-contract=}"
                for known in $THRESHOLD_CONTRACTS; do
                    if [ "$val" = "$known" ]; then
                        printf '%s' "threshold"
                        return 0
                    fi
                done
                ;;
            --match-path=*)
                val="${arg#--match-path=}"
                case "$val" in
                    "$THRESHOLD_PATH_PREFIX"*)
                        printf '%s' "threshold"
                        return 0
                        ;;
                esac
                ;;
        esac

        prev="$arg"
    done

    printf '%s' "default"
}

chosen="$(detect_profile "$@")"

# Announce on stderr so stdout stays clean for piping `forge ... --json` etc.
printf 'FOUNDRY_PROFILE=%s\n' "$chosen" >&2

# Exec so signals (Ctrl-C, SIGTERM) propagate directly to forge.
FOUNDRY_PROFILE="$chosen" exec forge "$@"
