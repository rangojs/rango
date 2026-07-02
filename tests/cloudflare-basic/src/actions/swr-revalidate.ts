"use server";

import { cookies } from "@rangojs/router";

// Test-fixture server action that triggers a revalidation of the current page
// WITHOUT invalidating any cache tag. It performs a trivial mutation (a cookie
// write) so the action's revalidation render runs, exercising the
// foregroundOnAction cache-profile opt-in: a stale "use cache: swr-action" entry
// re-executes in the foreground during this render (fresh value in the action
// response) instead of being served stale. See pages/swr-ctx.tsx.
//
// Returns void so it can be a DIRECT `<form action={...}>` form action, which
// works under BOTH JS and no-JS progressive enhancement (the PE re-render must
// foreground too — JS/PE parity).
export async function triggerSwrRevalidation(): Promise<void> {
  cookies().set("swr-action-revalidated", "1", { path: "/", maxAge: 60 });
}
