#!/bin/sh
# Measurement fixture, not for merge. Runs the #1078 view-transition cells
# against servers you started yourself (vite / vite preview in e2e/test-app).
#
# usage: cells.sh <out-dir> <mode: dev|production> <base-url> [exp] [N]
#   exp: "" (main behavior) | a | b1 | b2 | c0 | c30 | c100 | d  (src/vt-experiment.ts)
# env: ROUTES_A (default vt,skeleton,vt-bare), DELAYS_A (default 100,280,400,500),
#      ROUTES_B (default vt-two; "none" skips the two-loader cell)
set -e
cd "$(dirname "$0")/../../.."
OUTDIR=$1
MODE=$2
BASE=$3
EXP=$4
N=${5:-5}
LABEL=${EXP:-base}
OUT=$OUTDIR/$LABEL-$MODE.jsonl
mkdir -p "$OUTDIR"
rm -f "$OUT" "$OUT.meta"
C=e2e/base-cost/base-cost.config.ts
BASE=$BASE MODE=$MODE EXP=$EXP OUT=$OUT ROUTES=${ROUTES_A:-vt,skeleton,vt-bare} RS=0 \
  DELAYS=${DELAYS_A:-100,280,400,500} N=$N \
  ./node_modules/.bin/playwright test --config $C > "$OUTDIR/$LABEL-$MODE-a.log" 2>&1
if [ "${ROUTES_B:-vt-two}" != none ]; then
  BASE=$BASE MODE=$MODE EXP=$EXP OUT=$OUT ROUTES=${ROUTES_B:-vt-two} RS=0 DELAYS=100 N=$N \
    ./node_modules/.bin/playwright test --config $C > "$OUTDIR/$LABEL-$MODE-b.log" 2>&1
fi
tail -1 "$OUTDIR/$LABEL-$MODE-a.log"
cat "$OUT.meta"
