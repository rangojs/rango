export const meta = {
  name: "rango-gap-review",
  description:
    "Targeted review of surfaces the main review missed: testing module, security, cross-seam, self-diff",
  phases: [
    { title: "Review", detail: "4 focused reviewers" },
    { title: "Verify", detail: "adversarial check of high/critical findings" },
  ],
};

const ROOT = "/Users/ivotodorov/Development/vite-rsc-2";
const PKG = "packages/rangojs-router";

const REVIEWS = [
  {
    key: "testing-module",
    label: "@rangojs/router/testing module (#533, never reviewed)",
    prompt: `Review the NEW consumer testing module that landed on main AFTER the original 54-reviewer pass, so it has had ZERO stabilization review.
TARGETS: ${PKG}/src/testing/** (renderRoute, dispatch, runLoader/runLoaderResult, runMiddleware, collectHandle, renderHandler, flight/flight-matchers, generated-routes, vitest preset, e2e harness) and its public export map entries (./testing, ./testing/vitest, ./testing/dom, ./testing/e2e, ./testing/flight, ./testing/flight-matchers).
LENSES: public API ergonomics & type-safety; correctness (do the primitives faithfully reproduce real runtime behavior, or can a test go green while proving nothing?); leaky internals; mismatches between docs/testing.md + skills/testing and the actual code. Read docs/testing.md to judge against intent.`,
  },
  {
    key: "security",
    label: "Security: actions / origin / redirect / nonce / PE",
    prompt: `Focused SECURITY review of the highest-risk request-handling surfaces (the original review's correctness lens touched these but no dedicated security pass ran).
TARGETS: ${PKG}/src/rsc/server-action.ts, ${PKG}/src/rsc/origin-guard.ts, ${PKG}/src/rsc/progressive-enhancement.ts, ${PKG}/src/rsc/response-route-handler.ts, ${PKG}/src/rsc/nonce.ts, ${PKG}/src/browser/validate-redirect-origin.ts, ${PKG}/src/route-definition/redirect.ts, ${PKG}/src/router/content-negotiation.ts.
HUNT: CSRF / origin-check bypass on actions and PE form POSTs; open-redirect (redirect target validation); SSRF; header/response splitting & smuggling; nonce/CSP weaknesses; action-argument tampering / deserialization; auth checks that can be skipped on the PE path but not JS (or vice versa); information disclosure in error responses. Cite exact file:line and a concrete attack scenario for each finding.`,
  },
  {
    key: "cross-seam",
    label: "Cross-subsystem seam interactions",
    prompt: `The original review was per-subsystem (9 silos), so bugs at the SEAMS between subsystems are under-covered. Hunt for interaction bugs where two correct-in-isolation subsystems combine incorrectly.
TARGETS & COMBINATIONS: cache x prerender x revalidate (a cached segment under a Passthrough route, a revalidate() that crosses a cache boundary, prerender artifact + runtime cache); middleware x actions x revalidation (post-action revalidation render middleware scope, action vs route-middleware visibility); intercept x parallel x loading (an intercept slot with its own loader + loading() inside a parallel slot); loader caching x SWR x tag invalidation. Read ${PKG}/docs/internal/execution-model.md and docs/design/cache-tags-flow.md for the intended contracts, then look for combinations the contracts do not actually cover.`,
  },
  {
    key: "self-diff",
    label: "Adversarial self-review of the stabilization diff",
    prompt: `Adversarially review the stabilization changes on this branch for regressions, missed edge cases, or broken invariants. Run \`git -C ${ROOT} diff origin/main...HEAD\` to see the full diff (3 commits). For EACH non-trivial change, ask: does it fully fix the finding, or only the happy path? Did it introduce a regression, change an unintended behavior, or break an invariant (handler-first ordering, dev/prod parity, bundle hygiene, cache scope)? Specifically scrutinize: the trie constraintsSatisfied backtracking (does it still match every previously-matching route? any new shadowing?), the loader wrap-before-await on the loading:false path (ordering/metrics preserved?), detectPrerenderPassthrough (does awaiting thenable components change build timing or swallow a real error?), the loud loader-cache errors (no double-report?), and the dead-export removals (truly zero consumers?).`,
  },
];

const FINDINGS = {
  type: "object",
  additionalProperties: false,
  properties: {
    area: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low", "info"],
          },
          file: { type: "string" },
          lines: { type: "string" },
          description: { type: "string" },
          evidence: { type: "string" },
          suggestion: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: [
          "title",
          "severity",
          "file",
          "lines",
          "description",
          "suggestion",
          "confidence",
        ],
      },
    },
    notes: { type: "string" },
  },
  required: ["area", "findings", "notes"],
};

const VERDICT = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: {
      type: "string",
      enum: ["confirmed", "partial", "refuted", "needs-info"],
    },
    adjustedSeverity: {
      type: "string",
      enum: ["critical", "high", "medium", "low", "info"],
    },
    reasoning: { type: "string" },
    evidence: { type: "string" },
  },
  required: ["verdict", "adjustedSeverity", "reasoning", "evidence"],
};

phase("Review");
const reviewed = await pipeline(
  REVIEWS,
  (r) =>
    agent(
      `You are a senior engineer. REPO ROOT: ${ROOT}. ${r.prompt}\n\nActually read the cited files (Read/Grep). Ground every finding in a file+line you read; quote it in 'evidence'. Report 3-12 highest-signal findings; reporting a clean bill is a valid outcome. Set area="${r.key}".`,
      { label: `review:${r.key}`, phase: "Review", schema: FINDINGS },
    ),
  // verify high/critical findings adversarially
  (res, r) => {
    if (!res) return { area: r.key, verified: [] };
    const toVerify = (res.findings || []).filter(
      (f) => f.severity === "critical" || f.severity === "high",
    );
    const kept = (res.findings || []).filter(
      (f) => f.severity !== "critical" && f.severity !== "high",
    );
    return parallel(
      toVerify.map(
        (f, i) => () =>
          agent(
            `Adversarial verifier. REPO ROOT: ${ROOT}. Default to REFUTE unless the code clearly confirms it. Open ${f.file} (lines ${f.lines}), read it and callers/callees, decide confirmed/partial/refuted/needs-info and the true severity.\nCLAIM: ${f.title}\n${f.description}\nEvidence: ${f.evidence}`,
            { label: `verify:${r.key}#${i}`, phase: "Verify", schema: VERDICT },
          )
            .then((v) => ({ ...f, verdict: v }))
            .catch(() => ({ ...f, verdict: null })),
      ),
    ).then((vs) => ({
      area: r.key,
      notes: res.notes,
      verified: [
        ...vs,
        ...kept.map((f) => ({
          ...f,
          verdict: { verdict: "unverified-lowsev" },
        })),
      ],
    }));
  },
);

return { areas: reviewed.filter(Boolean) };
