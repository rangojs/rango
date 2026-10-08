#!/bin/sh
S=/private/tmp/claude-501/-Users-ivotodorov-Development-vite-rsc/55996600-e4ca-4a29-aa5e-264bd325632a/scratchpad/base-cost
cd /Users/ivotodorov/Development/vite-rsc/.claude/worktrees/agent-a7749c70d4162b3b4/packages/rangojs-router
C=e2e/base-cost/base-cost2.config.ts
for m in production dev; do
  if [ $m = production ]; then B=http://localhost:47319; else B=http://localhost:47318; fi
  export BASE=$B MODE=$m N=5 SCEN=layout-a-then-b
  OUT=$S/seq-$m.jsonl LABEL=:s1-prefetched-a-then-plain-b PREFIX=/base-cost-q PREFETCH=1 ./node_modules/.bin/playwright test --config $C > $S/seq-$m-1.log 2>&1
  OUT=$S/seq-$m.jsonl LABEL=:i-plain-a-then-plain-b PREFIX=/base-cost-a PREFETCH=0 ./node_modules/.bin/playwright test --config $C > $S/seq-$m-2.log 2>&1
  SCEN=b-only OUT=$S/seq-$m.jsonl LABEL=:ii-doc-on-a-then-plain-b PREFIX=/base-cost-a START=/noloader-layout/a PREFETCH=0 ./node_modules/.bin/playwright test --config $C > $S/seq-$m-3.log 2>&1
done
echo done > $S/progress3
