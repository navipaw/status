#!/usr/bin/env bash
# Moves recorded measurements between the workspace and the orphan `data` branch.
#
# Orphaned so ~2,880 machine commits a month never touch main's history and can
# be squashed or rebuilt without rewriting anything anyone has pulled.
#
#   restore  data branch -> data/history.json   (tolerates the branch not existing)
#   save     data/history.json -> data branch   (creates it on first run)
#
# Usage: bash scripts/data-branch.sh restore|save
set -euo pipefail

BRANCH="data"
FILE="data/history.json"
WORKTREE=".data-branch"

restore() {
  git fetch origin "$BRANCH" --depth=1 2>/dev/null || {
    echo "no $BRANCH branch yet — starting from empty history"
    return 0
  }
  mkdir -p data
  # Read the blob straight out of the fetched ref: no checkout, no worktree, and
  # no chance of leaving the repo on the wrong branch if a later step fails.
  if git show "origin/$BRANCH:history.json" > "$FILE" 2>/dev/null; then
    echo "restored $FILE ($(wc -c < "$FILE") bytes) from origin/$BRANCH"
  else
    echo "$BRANCH branch has no history.json yet — starting from empty history"
  fi
}

save() {
  if [ ! -f "$FILE" ]; then
    echo "no $FILE to save"
    return 0
  fi

  git config user.name  "navipaw-status[bot]"
  git config user.email "status@navipaw.com"

  rm -rf "$WORKTREE"
  if git fetch origin "$BRANCH" --depth=1 2>/dev/null; then
    git worktree add --detach "$WORKTREE" "origin/$BRANCH" >/dev/null
    git -C "$WORKTREE" switch -c "$BRANCH" >/dev/null 2>&1 || true
  else
    # First ever run: an orphan branch, deliberately sharing no history with main.
    git worktree add --detach "$WORKTREE" >/dev/null
    git -C "$WORKTREE" checkout --orphan "$BRANCH" >/dev/null
    git -C "$WORKTREE" rm -rf . >/dev/null 2>&1 || true
  fi

  cp "$FILE" "$WORKTREE/history.json"
  cat > "$WORKTREE/README.md" <<'EOF'
# data

Recorded check results. Machine-written. Delete this branch to reset the window.
EOF

  git -C "$WORKTREE" add history.json README.md
  if git -C "$WORKTREE" diff --cached --quiet; then
    echo "history unchanged — nothing to commit"
  else
    git -C "$WORKTREE" commit -q -m "probe: $(date -u +%Y-%m-%dT%H:%MZ)"
    # Retry rather than fail: a race with the incident workflow must not leave
    # the page stale, and losing one cycle of measurements is not worth a red run.
    for _ in 1 2 3; do
      if git -C "$WORKTREE" push origin "HEAD:$BRANCH" 2>/dev/null; then
        echo "pushed to $BRANCH"; break
      fi
      echo "push raced; refetching"
      git -C "$WORKTREE" fetch origin "$BRANCH" --depth=1 || true
      git -C "$WORKTREE" reset --soft "origin/$BRANCH" || true
      git -C "$WORKTREE" commit -q --amend --no-edit || true
      sleep 3
    done
  fi

  git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
}

case "${1:-}" in
  restore) restore ;;
  save)    save ;;
  *) echo "usage: $0 restore|save" >&2; exit 2 ;;
esac
