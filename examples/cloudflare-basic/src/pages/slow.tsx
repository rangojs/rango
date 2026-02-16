import { Link } from "@rangojs/router/client";
import { reverse } from "../router.js";

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function SlowPage1() {
  const start = Date.now();
  await delay(5000);
  const elapsed = Date.now() - start;

  return (
    <div>
      <h1>Slow Page 1</h1>
      <p>This page took {elapsed}ms to load (simulated 5000ms delay).</p>
      <p style={{ marginTop: "1rem", color: "#666" }}>
        Navigate between pages to see the loading indicator appear after 400ms.
      </p>
      <nav style={{ marginTop: "2rem", display: "flex", gap: "1rem" }}>
        <Link to={reverse("slow1")} style={{ color: "#0070f3" }}>
          Slow 1
        </Link>
        <Link to={reverse("slow2")} style={{ color: "#0070f3" }}>
          Slow 2
        </Link>
        <Link to={reverse("fast")} style={{ color: "#22c55e" }}>
          Fast
        </Link>
        <Link to={reverse("home")} style={{ color: "#666" }}>
          Home
        </Link>
      </nav>
    </div>
  );
}

export async function SlowPage2() {
  const start = Date.now();
  await delay(5000);
  const elapsed = Date.now() - start;

  return (
    <div>
      <h1>Slow Page 2</h1>
      <p>This page took {elapsed}ms to load (simulated 5000ms delay).</p>
      <p style={{ marginTop: "1rem", color: "#666" }}>
        Navigate between pages to see the loading indicator appear after 400ms.
      </p>
      <nav style={{ marginTop: "2rem", display: "flex", gap: "1rem" }}>
        <Link to={reverse("slow1")} style={{ color: "#0070f3" }}>
          Slow 1
        </Link>
        <Link to={reverse("slow2")} style={{ color: "#0070f3" }}>
          Slow 2
        </Link>
        <Link to={reverse("fast")} style={{ color: "#22c55e" }}>
          Fast
        </Link>
        <Link to={reverse("home")} style={{ color: "#666" }}>
          Home
        </Link>
      </nav>
    </div>
  );
}

export function FastPage() {
  return (
    <div>
      <h1>Fast Page</h1>
      <p>This page loads instantly (no delay).</p>
      <p style={{ marginTop: "1rem", color: "#666" }}>
        The progress bar should NOT appear when navigating here.
      </p>
      <nav style={{ marginTop: "2rem", display: "flex", gap: "1rem" }}>
        <Link to={reverse("slow1")} style={{ color: "#0070f3" }}>
          Slow 1
        </Link>
        <Link to={reverse("slow2")} style={{ color: "#0070f3" }}>
          Slow 2
        </Link>
        <Link to={reverse("fast")} style={{ color: "#22c55e" }}>
          Fast
        </Link>
        <Link to={reverse("home")} style={{ color: "#666" }}>
          Home
        </Link>
      </nav>
    </div>
  );
}
