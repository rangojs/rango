<!-- BEGIN:rango-agent-rules -->

# Rango: read the version-matched skills before coding

This application uses `@rangojs/router`, not Next.js. Do not infer routing,
caching, revalidation, middleware, or rendering behavior from Next.js APIs.

Before Rango work, load `/rango` when that skill is installed. Otherwise read
`node_modules/@rangojs/router/skills/rango/SKILL.md`, then open the relevant
sibling skill under `node_modules/@rangojs/router/skills/`. These files match the
installed router version and are the source of truth over training data.

After adding, removing, or renaming routes, run `npx rango generate src/` and
commit every regenerated `*.gen.ts` file with the route change.

<!-- END:rango-agent-rules -->
