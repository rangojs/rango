#!/bin/sh
S=/private/tmp/claude-501/-Users-ivotodorov-Development-vite-rsc/55996600-e4ca-4a29-aa5e-264bd325632a/scratchpad/base-cost
cd /Users/ivotodorov/Development/vite-rsc/.claude/worktrees/agent-a7749c70d4162b3b4/packages/rangojs-router
C=e2e/base-cost/base-cost.config.ts
MAIN=skeleton,bare,nested,vt,vt-off,vt-bare
EXTRA=vt-two,vt-two-off,vt-inner,vt-inner-off,inner
echo "main-prod" > $S/progress
BASE=http://localhost:47319 MODE=production OUT=$S/prod.jsonl ROUTES=$MAIN RS=0,100 DELAYS=0,50,100,200,280,320,400,500 N=5 ./node_modules/.bin/playwright test --config $C > $S/prod-main.log 2>&1
echo "extra-prod" > $S/progress
BASE=http://localhost:47319 MODE=production OUT=$S/prod.jsonl ROUTES=$EXTRA RS=0,100 DELAYS=100,300,500 N=5 ./node_modules/.bin/playwright test --config $C > $S/prod-extra.log 2>&1
echo "main-dev" > $S/progress
BASE=http://localhost:47318 MODE=dev OUT=$S/dev.jsonl ROUTES=$MAIN RS=0,100 DELAYS=0,50,100,200,280,320,400,500 N=5 ./node_modules/.bin/playwright test --config $C > $S/dev-main.log 2>&1
echo "extra-dev" > $S/progress
BASE=http://localhost:47318 MODE=dev OUT=$S/dev.jsonl ROUTES=$EXTRA RS=0,100 DELAYS=100,300,500 N=5 ./node_modules/.bin/playwright test --config $C > $S/dev-extra.log 2>&1
echo "done" > $S/progress
