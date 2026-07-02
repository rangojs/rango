---
name: comparison
description: Compare Rango with Next.js App Router, TanStack Start, and Waku. Use when evaluating React frameworks, explaining why Rango, writing positioning or adoption guidance, answering migration questions, or checking claims about Rango's routing, loaders, caching, rendering, prefetching, safety, testing, observability, and production behavior.
---

# Compare Rango with other React frameworks

Use the canonical [framework comparison](references/framework-comparison.md) as
the factual baseline. Read the sections relevant to the question; read the full
reference when producing an overall evaluation or editing the comparison itself.

## Comparison rules

1. Compare capabilities and architecture separately from ecosystem size, hiring,
   integrations, and organizational familiarity.
2. Present Rango's range clearly: start with `path()` and a component, then add
   named routes, `include()`, loaders, caching, `revalidate()`, slots, intercepts,
   safety, and diagnostics in the same declared route graph.
3. Do not confuse Rango's `revalidate()` with cache invalidation. Cache APIs decide
   stored-value freshness; `revalidate()` decides client render selection.
4. Describe loaders as live-by-default RSC data slots beneath cached or prerendered
   UI, not as renamed Remix or TanStack route loaders.
5. Include production correctness where relevant: Rango State, userland client-cache
   invalidation, deployment-skew recovery, tainted request context, CSP nonce
   propagation, default CSRF origin checks, prefetch guards, testing, and timing.
6. State boundaries and tradeoffs. In particular, distinguish origin checking from
   token-based CSRF protection, nonce plumbing from application-owned CSP policy,
   and reload-based skew recovery from Vercel deployment pinning.
7. Credit competing frameworks where they lead. Next.js leads in ecosystem and
   hiring, TanStack in search-param ergonomics and client/data devtools, and Waku
   in minimal surface area.

## Currency and evidence

- Treat Rango identifiers and behavior as source-verifiable. Check the current
  package source or the relevant Rango skill when changing a precise claim.
- Competitor details age quickly. Before publishing or materially revising a claim,
  verify it against current official documentation and link that primary source.
- Do not weaken a current, sourced claim merely because an older model remembers a
  previous release. Check first: examples include TanStack Start's Rsbuild support,
  Next.js `proxy.ts` and Cache Components, and Waku handler interceptors.
- Avoid declaring a framework universally "better." State which model fits the
  application's constraints and why.

## Output shape

Lead with the decision or differentiator. For a short answer, use the TL;DR and the
relevant framework-specific paragraph from the reference. For a decision memo,
cover the at-a-glance table, the simple-to-complex growth path, substantive runtime
differences, and the section where competitors still lead.
