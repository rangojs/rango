Publish a preview experimental release of @rangojs/router from the current branch.

Steps:

1. Verify you are NOT on `main`. If on main, stop and tell the user to create/switch to a feature branch first.
2. Run typecheck (`pnpm exec tsc --noEmit`), unit tests (`pnpm run test:unit`), lint (`pnpm -w run lint`), and format (`pnpm -w run format`). Fix any failures before proceeding.
3. Stage and commit any uncommitted changes (ask the user for a commit message if needed).
4. Get the short commit hash: `git rev-parse --short HEAD`
5. Temporarily set the version in `packages/rangojs-router/package.json` to `0.0.0-experimental.<hash>` (e.g. `0.0.0-experimental.a1b2c3d4`).
6. Publish: `cd packages/rangojs-router && npm publish --tag preview`
7. Revert the version in `package.json` back to what it was before (do NOT commit the version bump).
8. Report the published version to the user.

IMPORTANT:

- Do NOT push to remote. Do NOT commit the version bump.
- Do NOT switch branches or modify `main`.
- The version bump is temporary — only for the publish, then reverted.
