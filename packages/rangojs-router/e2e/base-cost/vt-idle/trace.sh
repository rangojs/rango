#!/bin/sh
# Measurement fixture, not for merge. Records timelines of one cell
# (vt-trace.recorder.ts). With react-dom instrumented by patch-react-dev.py the
# row also carries React's scheduling log (window.__rlog).
#
# usage: trace.sh <out.jsonl> <mode: dev|production> <base-url> <route> <delay> [N] [previsit] [exp]
#   previsit: a hub link suffix (for example bare-0) visited first, so the
#   route's client component module is already loaded at the measured click.
set -e
cd "$(dirname "$0")/../../.."
OUT=$1
rm -f "$OUT"
BASE=$3 MODE=$2 ROUTE=$4 DELAY=$5 N=${6:-1} PREVISIT=$7 EXP=$8 OUT=$OUT \
  ./node_modules/.bin/playwright test --config e2e/base-cost/vt-trace.config.ts
