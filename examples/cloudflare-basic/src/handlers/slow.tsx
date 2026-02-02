import { map } from "@ivogt/rsc-router/server";
import { Link, href } from "@ivogt/rsc-router/client";
import type { slowRoutes } from "../routes.js";
import { RootLayout } from "../components/SlowRootLayout.js";

// Simulate slow data fetching
async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function SlowContent({
  name,
  delayMs,
}: {
  name: string;
  delayMs: number;
}) {
  const start = Date.now();
  await delay(delayMs);
  const elapsed = Date.now() - start;

  return (
    <div>
      <h1>Slow Page {name}</h1>
      <p>
        This page took {elapsed}ms to load (simulated {delayMs}ms delay).
      </p>
      <p style={{ marginTop: "1rem", color: "#666" }}>
        Navigate between pages to see the loading indicator appear after 400ms.
      </p>
      <nav style={{ marginTop: "2rem", display: "flex", gap: "1rem" }}>
        <Link to={href("/slow/1")} style={{ color: "#0070f3" }}>
          Slow 1
        </Link>
        <Link to={href("/slow/2")} style={{ color: "#0070f3" }}>
          Slow 2
        </Link>
        <Link to={href("/slow/fast")} style={{ color: "#22c55e" }}>
          Fast
        </Link>
        <Link to={href("/")} style={{ color: "#666" }}>
          Home
        </Link>
      </nav>
    </div>
  );
}

function FastContent() {
  return (
    <div>
      <h1>Fast Page</h1>
      <p>This page loads instantly (no delay).</p>
      <p style={{ marginTop: "1rem", color: "#666" }}>
        The progress bar should NOT appear when navigating here.
      </p>
      <nav style={{ marginTop: "2rem", display: "flex", gap: "1rem" }}>
        <Link to={href("/slow/1")} style={{ color: "#0070f3" }}>
          Slow 1
        </Link>
        <Link to={href("/slow/2")} style={{ color: "#0070f3" }}>
          Slow 2
        </Link>
        <Link to={href("/slow/fast")} style={{ color: "#22c55e" }}>
          Fast
        </Link>
        <Link to={href("/")} style={{ color: "#666" }}>
          Home
        </Link>
      </nav>
    </div>
  );
}

export default map<typeof slowRoutes>(({ route, layout }) => [
  layout(<RootLayout />, () => [
    route("slow1", () => <SlowContent name="1" delayMs={5000} />),
    route("slow2", () => <SlowContent name="2" delayMs={5000} />),
    route("fast", () => <FastContent />),
  ]),
]);
