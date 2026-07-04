"use client";

import { useLoader } from "@rangojs/router/client";
import { ActivityLoader, AppShellLoader, StatsLoader } from "../app-loaders.js";

export function ShellNav() {
  const { data } = useLoader(AppShellLoader);
  return (
    <nav data-testid="shell-nav">
      {data.nav.map((item) => (
        <span key={item} style={{ marginRight: "1rem" }}>
          {item}
        </span>
      ))}
      <span data-testid="shell-user">{data.user}</span>
    </nav>
  );
}

export function DashboardStats() {
  const { data } = useLoader(StatsLoader);
  return (
    <section data-testid="stats">
      <h2>Stats: {data.section}</h2>
      <p>
        visits {data.visits}, conversion {data.conversion}
      </p>
    </section>
  );
}

export function ActivityFeed() {
  const { data } = useLoader(ActivityLoader);
  return (
    <ul data-testid="activity">
      {data.events.map((e) => (
        <li key={e.id}>
          {e.type} #{e.id}
        </li>
      ))}
    </ul>
  );
}
