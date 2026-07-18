# Render Cache Optimizer Fixture

## Broken State

A segment-cached route is correct in development and production, but its PPR
option was removed. Warmed document requests therefore retain segment-cache
behavior while losing the reusable HTML shell.

Apply `setup.patch` from the repository root before starting. Run `verify.mjs`
before and after the repair; it must fail red, then pass Node and Cloudflare in
both development and production.

## Expected Diagnosis

Compare cold and warm shell headers and exact `explain_render` traces. Identify
the missing PPR boundary while confirming the inherited render-cache tier and
live loader lane still behave correctly.

## Required Edit

Restore the route's PPR policy while preserving the inherited cache boundary and
all loader consumer lanes. The edit must produce an actual shell hit.

## Dev Verification

Compare the same correlated cold/warm sequence before and after. Assert a PPR
document hit, unchanged inherited cache hit, and unchanged live-loader lane.

## Production Verification

Run the paired production sequence and require a real shell hit with unchanged
browser output and no diagnostic header. The shared verifier checks the same
contract in Cloudflare development and production.
