import { map } from "rsc-router/server";
import type { counterRoutes } from "../routes.js";
import { HtmlShell } from "../components/HtmlShell.js";
import { RootLayout } from "../components/RootLayout.js";
import { Counter } from "../components/Counter.js";
import { getCounter } from "../actions/counter.js";

export default map<typeof counterRoutes>(
  ({ route, layout }) => [
    layout(<RootLayout />),

  route("index", async () => {
    const initialCount = await getCounter();

    return (
      <main>
        <h1>Counter Demo</h1>
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
  ],
  { rootLayout: HtmlShell }
);
