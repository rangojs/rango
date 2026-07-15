# Dev Loop Fixture

## Broken State

A route edit throws for `/blog/mcp-phase-2`, so the browser receives an error
instead of the post. The task is to identify the exact failing request, repair
the regression, and prove the intended document interaction.

Apply `setup.patch` from the repository root before starting. Run `verify.mjs`
before and after the repair; it must fail red, then pass Node and Cloudflare in
both development and production.

## Expected Diagnosis

Use the browser response and `X-Rango-Request-Id` to select `get_errors` and
`get_request_trace`. Confirm the error belongs to the blog route before editing;
do not diagnose from an unrelated terminal stack or retained browser output.

## Required Edit

Remove only the fixture's request-time throw. Do not clear diagnostics, weaken
the test, or add a diagnostic production surface.

## Dev Verification

Run the focused development browser case, assert the intended blog response,
then prove `get_request_trace` selects the response observed by the browser.

## Production Verification

Run the paired production case and assert the same response, with no MCP endpoint
and no `X-Rango-Request-Id` response header. The shared verifier also checks the
equivalent Cloudflare request contract in development and production.
