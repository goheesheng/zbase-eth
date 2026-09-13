# Git history scrub — checklist (run ONCE, at the OSS-public flip)

**Status:** DEFERRED (decided 2026-06-25). The repo is private + actively changing,
so a history rewrite now would likely be redone before going public. Run this
**once, deliberately, immediately before flipping the repo to public** — which is
a separate gated event (see [[project-oss-split-classification]]).

**What this scrubs:** old commits still contain pitch decks + the founder's
personal email, even though they're removed from HEAD. A force-push rewrite is the
only way to purge them from history before the repo is public.

> ⚠️ DESTRUCTIVE + IRREVERSIBLE. Rewrites every commit SHA, requires a force-push,
> and anyone who already cloned/forked keeps the old history. GitHub may also cache
> old SHAs (reachable via the API) for a while after force-push — for true removal
> you may need to contact GitHub support to purge cached views. Do NOT run casually.

---

## Pre-flight (verified 2026-06-25)

- **No real private keys in history.** All `PRIVATE_KEY=0x` literals are
  placeholders/docs (`0x...`, `0x<deployer>`, `0xabc`, empty `=0x`); longest real
  hex is 2 chars. Re-verify before scrub: `git log --all -p | grep -oE "PRIVATE_KEY=0x[a-fA-F0-9]+" | sort -u`
- **No `.env` files ever committed.** Re-verify:
  `git log --all --pretty=format: --name-only | grep -iE "^\.env"`
- History size: ~334 commits. Branch is pushed to `origin`.

## Target 1 — deck / pitch files (purge from all history)

```
PITCH.md
PITCH_CARD.md
PITCH_SCRIPT.md
PITCH_TEST.md
docs/zba-81-pitch-deck-2026-05-28.html
docs/zba-85-vc-pitch-guidance-and-zbase-narrative-2026-05-28.md
docs/zba-88-vc-deck-2026-05-28.html
docs/zba-88-vc-deck-2026-05-28.pdf
docs/zbase-yc-pitch-deck-2026-05-28.html
docs/zbase-yc-pitch-deck-2026-05-28.pdf
docs/zbase-yc-pitch-deck-v2-2026-05-29.html
docs/zbase-yc-pitch-deck-v2-2026-05-29.pdf
docs/zbase-yc-pitch-deck-v3-2026-05-29.html
docs/zbase-yc-pitch-deck-v3-2026-05-29.pdf
pitch-deck-20260509-170049.html
pitch-deck-zbase-1slide.html
zx402-pitch-deck.pdf
```
RE-RUN this query at scrub time (new decks may have been added since):
`git log --all --pretty=format: --name-only | grep -iE "pitch|deck|incubator" | grep -viE "openzeppelin|lib/" | sort -u`

## Target 2 — personal email in commit diffs

`<redacted>` appears in ~6 commits' diffs (incl. past "untrack
sensitive data" commits — the removal diff itself contains the email). Replace
with the brand contact (`@zbase__` / DM) or a redaction token.
RE-RUN: `git log --all -S "<redacted>" --oneline`

---

## Procedure (at the public-flip gate)

1. **Install the tool** (you, once): `brew install git-filter-repo`
2. **Fresh mirror clone** (filter-repo wants a clean clone; protects your working repo):
   ```bash
   cd /tmp && git clone --mirror https://github.com/goheesheng/zBase.git zbase-scrub.git
   cd zbase-scrub.git
   ```
3. **Purge deck files** (use a paths file `decks.txt` with the Target-1 list):
   ```bash
   git filter-repo --invert-paths --paths-from-file decks.txt
   ```
4. **Redact the email** (replacements file `redact.txt`:
   `<redacted>==>contact-via-@zbase__-DM`):
   ```bash
   git filter-repo --replace-text redact.txt
   ```
5. **Verify clean**:
   ```bash
   git log --all -S "<redacted>" --oneline      # expect empty
   git log --all --pretty=format: --name-only | grep -iE "pitch|deck" | grep -viE "openzeppelin|lib/"  # expect empty
   ```
6. **Force-push the rewritten history** (THE irreversible step — confirm twice):
   ```bash
   git push --force --mirror https://github.com/goheesheng/zBase.git
   ```
7. **Post-scrub**: ask all collaborators to re-clone (old clones hold the old
   history). Consider asking GitHub support to purge cached unreachable commits.
   Rotate anything that was ever sensitive in history as a precaution.

## Coordinate with the OSS split

Per [[project-oss-split-classification]], the public repo is `goheesheng/zbase`
(split from the private platform). If the split produces a NEW public repo, the
cleanest path is to **seed the public repo from a scrubbed snapshot** (or even a
squashed/fresh-history export) rather than force-pushing the existing one — that
sidesteps the GitHub-cache problem entirely. Decide split-vs-scrub at flip time.
