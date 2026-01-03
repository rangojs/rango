import { map, Meta } from "rsc-router/server";
import type { counterRoutes } from "../routes.js";
import { Counter } from "../components/Counter.js";
import { getCounter } from "../actions/counter.js";
import { Breadcrumbs } from "../handles/breadcrumbs.js";

export default map<typeof counterRoutes>(({ route }) => [
  route("index", async (ctx) => {
    const meta = ctx.use(Meta);
    meta({ title: "Counter - RSC Router Cloudflare" });
    meta({ name: "description", content: "Interactive counter demo with Server Actions on Cloudflare Workers" });

    const breadcrumb = ctx.use(Breadcrumbs);
    breadcrumb({ label: "Home", href: "/" });
    breadcrumb({ label: "Counter", href: "/counter" });

    const initialCount = await getCounter();

    return (
      <main data-testid="counter-page">
        <h1 data-testid="counter-title">Counter Demo</h1>
        <p style={{ marginBottom: "1rem" }}>
          This demonstrates Server Actions with client-side state management.
        </p>
        <Counter initialCount={initialCount} />
        <div style={{ marginTop: "2rem", color: "#666", fontSize: "0.9rem" }}>
          <p>How it works:</p>
          <ul style={{ marginLeft: "1.5rem", marginTop: "0.5rem" }}>
            <li>Counter state lives on the client (useState)</li>
            <li>Increment/decrement call Server Actions</li>
            <li>Server Actions run on Cloudflare Workers</li>
            <li>useTransition provides pending state</li>
          </ul>
        </div>
      </main>
    );
  }),
]);
