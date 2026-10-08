#!/bin/sh
S=/private/tmp/claude-501/-Users-ivotodorov-Development-vite-rsc/55996600-e4ca-4a29-aa5e-264bd325632a/scratchpad/base-cost
cd /Users/ivotodorov/Development/vite-rsc/.claude/worktrees/agent-a7749c70d4162b3b4/packages/rangojs-router
C=e2e/base-cost/base-cost2.config.ts
for m in production dev; do
  if [ $m = production ]; then B=http://localhost:47319; else B=http://localhost:47318; fi
  export BASE=$B MODE=$m N=5
  for f in wl slot rs; do
    SCEN=$f OUT=$S/wl-$m.jsonl LABEL=:1-prefetched-a PREFIX=/bc3-q PREFETCH=1 ./node_modules/.bin/playwright test --config $C > $S/wl-$m-$f-1.log 2>&1
    SCEN=$f OUT=$S/wl-$m.jsonl LABEL=:2-plain-a PREFIX=/bc3-a PREFETCH=0 ./node_modules/.bin/playwright test --config $C > $S/wl-$m-$f-2.log 2>&1
    SCEN=$f-b OUT=$S/wl-$m.jsonl LABEL=:3-doc-a PREFIX=/bc3-a START=/$f/a PREFETCH=0 ./node_modules/.bin/playwright test --config $C > $S/wl-$m-$f-3.log 2>&1
  done
done
echo done > $S/progress4
