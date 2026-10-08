#!/bin/sh
S=/private/tmp/claude-501/-Users-ivotodorov-Development-vite-rsc/55996600-e4ca-4a29-aa5e-264bd325632a/scratchpad/base-cost
cd /Users/ivotodorov/Development/vite-rsc/.claude/worktrees/agent-a7749c70d4162b3b4/packages/rangojs-router
C=e2e/base-cost/base-cost2.config.ts
for pf in 0 1; do
  echo "prod-$pf" > $S/progress2
  BASE=http://localhost:47319 MODE=production PREFETCH=$pf OUT=$S/prod2.jsonl ./node_modules/.bin/playwright test --config $C > $S/prod2-$pf.log 2>&1
done
for pf in 0 1; do
  echo "dev-$pf" > $S/progress2
  BASE=http://localhost:47318 MODE=dev PREFETCH=$pf OUT=$S/dev2.jsonl ./node_modules/.bin/playwright test --config $C > $S/dev2-$pf.log 2>&1
done
echo done > $S/progress2
