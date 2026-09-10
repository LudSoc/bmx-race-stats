#!/bin/sh
# Propager le theme.css canonique (sqorz_stats) vers les dépôts frères.
# Usage : tools/sync-theme.sh   (depuis la racine sqorz_stats)
# Puis commiter dans chaque dépôt (1 commit par dépôt, sans push sauf demande).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$(dirname "$ROOT")"
SRC="$ROOT/theme.css"
for d in club_stats h2h_stats category_stats sqorz_hub ranking_stats; do
  if [ -d "$BASE/$d" ]; then
    cp "$SRC" "$BASE/$d/theme.css"
    echo "OK  $d/theme.css"
  else
    echo "SKIP $d (introuvable)"
  fi
done
