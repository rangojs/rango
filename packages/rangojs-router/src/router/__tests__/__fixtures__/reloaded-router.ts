import { createRouter } from "../../../router.js";

// dev-reload-handoff.test.ts: the router module a runner full reload
// re-evaluates. Its fetch is stubbed so the test reads which router answered.
export const router = createRouter({ id: "reload-handoff" });
router.fetch = async () => new Response("re-created router");
