import { map, Meta } from "@ivogt/rsc-router/server";
import type { counterRoutes } from "../routes.js";
import { Counter } from "../components/Counter.js";
import { getCounter } from "../actions/counter.js";

export default map<typeof counterRoutes>(({ route }) => [
  route("index", async (ctx) => {
    const meta = ctx.use(Meta);
    meta({ title: "Counter - RSC Router CSP Example" });
    meta({ name: "description", content: "Interactive counter with CSP-protected Server Actions" });

    const initialCount = await getCounter();

    return (
      <main data-testid="counter-page">
        <h1 data-testid="counter-title">Counter Demo with CSP</h1>
        <p style={{ marginBottom: "1rem" }}>
          Server Actions work seamlessly with CSP nonce protection.
        </p>
        <Counter initialCount={initialCount} />
        <div style={{ marginTop: "2rem", color: "#666", fontSize: "0.9rem" }}>
          <p>How it works with CSP:</p>
          <ul style={{ marginLeft: "1.5rem", marginTop: "0.5rem" }}>
            <li>All inline scripts have nonce attributes</li>
            <li>Server Actions are protected by CSP</li>
            <li>RSC streaming payload is nonce-protected</li>
            <li>No 'unsafe-inline' needed for scripts</li>
          </ul>
        </div>
      </main>
    );
  }),
]);
