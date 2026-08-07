#!/usr/bin/env bash
# One-shot deploy for MyRJ Schedule Cleaner -> GitHub Pages.
# Run from the repo root on a machine with `gh` authenticated as RJEdTech.
set -euo pipefail

REPO="MyRJ-Schedule-Cleaner"
OWNER="RJEdTech"

gh repo create "$OWNER/$REPO" --public \
  --description "Fix MyRJ calendar exports so importing your schedule into Outlook doesn't mark you busy all day, every school day." \
  --homepage "https://$OWNER.github.io/$REPO/" || echo "repo already exists, continuing"

git init -b main 2>/dev/null || true
git add -A
git commit -m "MyRJ Schedule Cleaner v1.0" || echo "nothing to commit"
git remote add origin "https://github.com/$OWNER/$REPO.git" 2>/dev/null || \
  git remote set-url origin "https://github.com/$OWNER/$REPO.git"
git push -u origin main

# Serve the repo root of main as Pages
gh api -X POST "repos/$OWNER/$REPO/pages" \
  -f 'source[branch]=main' -f 'source[path]=/' 2>/dev/null || \
gh api -X PUT "repos/$OWNER/$REPO/pages" \
  -f 'source[branch]=main' -f 'source[path]=/'

gh api -X PUT "repos/$OWNER/$REPO/pages" -F 'https_enforced=true' >/dev/null 2>&1 || true

echo
echo "Deployed. Live in ~1 minute at:"
echo "  https://$OWNER.github.io/$REPO/"
