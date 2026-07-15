# Render Cache Adoption Fixture

## Broken State

The scoped storefront route has PPR plus both baked and live DSL loaders, but an
accidental `cache(false)` disables its reusable render tier. The route remains
correct while every request misses the intended composed cache path.

Apply `setup.patch` from the repository root before starting. Run `verify.mjs`
before and after the repair; it must fail red, then pass Node and Cloudflare in
both development and production.

## Expected Diagnosis

Use cold/warm browser evidence and `explain_render` to distinguish the disabled
segment tier from the PPR document and loader-data tiers. Confirm the price
loader is a request-generation live consumer and the settled loader remains a
capture-generation baked consumer before changing the boundary.

## Required Edit

Replace `cache(false)` with the route's bounded inherited cache policy. Preserve
PPR, the live price loader and `loading()` hole, and the baked settled loader.

## Dev Verification

Prove an inherited render-cache hit, a PPR shell hit, and both live and baked
loader consumers in the exact correlated request.

## Production Verification

Run the paired production cold/warm flow and assert real shell hits reuse the
same handler execution marker, with the expected page output and no diagnostic
header. The shared verifier checks the same composed contract in Cloudflare
development and production.
