/**
 * Server components for the /app group — an app-shaped slice (layout with a
 * live loader, dashboard with parallel loaders + client consumers, a cached
 * segment, a PE-postable action form) so the bench exercises the render
 * pipeline consumers actually run, not just raw-Response handlers.
 */
import type { Handler } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { submitFeedback } from "../app-actions.js";
import { ActivityFeed, DashboardStats, ShellNav } from "./app-client.js";

export const AppLayout = () => (
  <div data-testid="app-layout" style={{ padding: "1rem" }}>
    <ShellNav />
    <Outlet />
  </div>
);

export const DashboardPage: Handler<Record<string, any>> = async (ctx) => {
  return (
    <main>
      <h1>Dashboard {String(ctx.params.section ?? "")}</h1>
      <DashboardStats />
      <ActivityFeed />
    </main>
  );
};

export const CachedPage: Handler<Record<string, any>> = async (ctx) => {
  // No loaders, no side effects: the whole segment is cacheable. renderedAt
  // proves hit vs miss — a hit serves the stored timestamp.
  return (
    <main>
      <h1>Cached bucket {String(ctx.params.bucket ?? "")}</h1>
      <p data-testid="cached-rendered-at">{Date.now()}</p>
    </main>
  );
};

export const FeedbackPage = () => (
  <main>
    <h1>Feedback</h1>
    <form action={submitFeedback} data-testid="feedback-form">
      <input name="message" defaultValue="hello" />
      <button type="submit">Send</button>
    </form>
  </main>
);
