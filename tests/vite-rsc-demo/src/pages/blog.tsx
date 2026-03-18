import type {
  Middleware,
  HandlerContext,
  Revalidate,
  RevalidateParams,
} from "@rangojs/router";
import { Outlet, ParallelOutlet, Link } from "@rangojs/router/client";
import { DebugSegmentWrapper } from "../components/DebugSegmentWrapper.js";
import { SegmentTimer } from "../components/SegmentTimer.js";
import { CurrentURL } from "../components/CurrentURL.js";
import {
  blogPostsMeta,
  getAuthor,
  getPostAuthor,
} from "../handlers/blog/data/mock-data.js";
import { getBlogActionProbe } from "../handlers/blog/data/action-probe.js";
import { submitBlogProbeAction } from "../handlers/blog/actions/probe.js";
import { ActionProbeForm } from "../handlers/blog/components/ActionProbeForm.js";
import { href } from "@rangojs/router/client";

export function BlogLayout() {
  return (
    <div>
      <h1>Blog</h1>
      <p className="segment-id">Segment: BlogLayout</p>
      <div style={{ display: "flex", gap: "2rem" }}>
        <main style={{ flex: 1 }}>
          <Outlet />
        </main>
        <ParallelOutlet name="@sidebar" />
      </div>
      <Outlet name="@modal" />
    </div>
  );
}

export function BlogSidebarContent() {
  // This would normally use ctx.use(BlogSidebarLoader) but for now we return placeholder
  return (
    <aside
      style={{
        padding: "1rem",
        backgroundColor: "#f5f5f5",
        borderRadius: "8px",
        minWidth: "250px",
      }}
    >
      <p className="segment-id">Segment: BlogSidebar (parallel)</p>

      <section style={{ marginBottom: "1.5rem" }}>
        <h3 style={{ margin: "0 0 0.75rem 0", fontSize: "1rem" }}>
          Recent Posts
        </h3>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          <li style={{ marginBottom: "0.5rem" }}>
            <a
              href="/blog/hello-world"
              style={{ color: "#0066cc", textDecoration: "none" }}
            >
              Hello World
            </a>
          </li>
          <li style={{ marginBottom: "0.5rem" }}>
            <a
              href="/blog/react-server-components"
              style={{ color: "#0066cc", textDecoration: "none" }}
            >
              React Server Components
            </a>
          </li>
        </ul>
      </section>
    </aside>
  );
}

export function BlogSidebarSkeleton() {
  return (
    <aside
      style={{
        padding: "1rem",
        backgroundColor: "#f5f5f5",
        borderRadius: "8px",
        minWidth: "250px",
      }}
    >
      <p className="segment-id" style={{ color: "#999" }}>
        Loading Sidebar...
      </p>
    </aside>
  );
}

export function BlogIndexPage() {
  return (
    <DebugSegmentWrapper type="route" name="Blog Index">
      <div>
        <h2>Blog Posts</h2>
        <p className="segment-id">Segment: Blog Index Route</p>
        <ul>
          {blogPostsMeta.map((post) => {
            const author = getAuthor(post.authorSlug);
            return (
              <li key={post.slug} style={{ marginBottom: "0.5rem" }}>
                <Link to={`/blog/${post.slug}`}>{post.title}</Link>
                {author && (
                  <span style={{ color: "#666", fontSize: "0.85rem" }}>
                    {" "}
                    by{" "}
                    <Link
                      to={`/blog/author/${author.slug}`}
                      style={{ color: "#3b82f6", textDecoration: "none" }}
                    >
                      {author.name}
                    </Link>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </DebugSegmentWrapper>
  );
}

export function BlogPostPage(ctx: HandlerContext<{ slug: string }>) {
  const renderTime = new Date().toISOString();
  const queryParams: [string, string][] = Array.from(
    ctx.searchParams.entries(),
  );
  const previousClientUrl = ctx.request.headers.get("X-RSC-Router-Client-Path");
  const actionProbe = getBlogActionProbe(ctx.params.slug);

  return (
    <DebugSegmentWrapper type="route" name="Blog Post">
      <div>
        <h2>
          {ctx.params.slug
            .split("-")
            .map((w: string) => w[0].toUpperCase() + w.slice(1))
            .join(" ")}
        </h2>
        <p className="segment-id">Segment: Blog Post Route</p>
        <p>
          <strong>Slug (route param):</strong> <code>{ctx.params.slug}</code>
        </p>

        <CurrentURL />

        <div
          style={{
            background: "#fff3cd",
            padding: "0.75rem",
            borderRadius: "4px",
            marginTop: "0.5rem",
            border: "2px solid #856404",
          }}
        >
          <div
            style={{
              marginBottom: "0.25rem",
              fontSize: "0.85rem",
              fontWeight: "bold",
              color: "#856404",
            }}
          >
            Server Snapshot (at render time: {renderTime})
          </div>
          <div style={{ fontSize: "0.8rem", marginBottom: "0.5rem" }}>
            <strong>Query Params (ctx.searchParams):</strong>{" "}
            {queryParams.length > 0 ? (
              <code>{queryParams.map(([k, v]) => `${k}=${v}`).join("&")}</code>
            ) : (
              <em style={{ color: "#666" }}>none</em>
            )}
          </div>
          {previousClientUrl && (
            <div
              style={{
                fontSize: "0.75rem",
                color: "#856404",
                marginTop: "0.5rem",
                paddingTop: "0.5rem",
                borderTop: "1px solid #856404",
              }}
            >
              <strong>Previous URL (from header):</strong>
              <br />
              <code style={{ fontSize: "0.7rem" }}>{previousClientUrl}</code>
            </div>
          )}
        </div>

        <SegmentTimer serverRenderTime={renderTime} />

        <div
          style={{
            marginTop: "1rem",
            padding: "1rem",
            background: "#f8fafc",
            borderRadius: "8px",
            border: "1px solid #cbd5e1",
          }}
        >
          <h4 style={{ marginTop: 0 }}>Server Action Snapshot</h4>
          <div style={{ fontSize: "0.9rem", color: "#334155" }}>
            <div>
              <strong>Action count for this post:</strong> {actionProbe.count}
            </div>
            <div>
              <strong>Last submitted at:</strong>{" "}
              {actionProbe.lastSubmittedAt ?? "No action yet"}
            </div>
            <div>
              <strong>Last message:</strong>{" "}
              {actionProbe.lastMessage ?? "No action yet"}
            </div>
          </div>
        </div>

        <ActionProbeForm
          slug={ctx.params.slug}
          action={submitBlogProbeAction}
        />

        <div
          style={{
            marginTop: "1rem",
            padding: "1rem",
            background: "#f8f9fa",
            borderRadius: "4px",
          }}
        >
          <h4 style={{ marginTop: 0 }}>Test Revalidation:</h4>
          <ul style={{ margin: 0, paddingLeft: "1.5rem" }}>
            <li>
              <a href="/blog/hello-world">Navigate to hello-world</a> (slug
              changes - timer resets)
            </li>
            <li>
              <Link scroll={false} to={`/blog/${ctx.params.slug}?tab=1`}>
                Add ?tab=1 (no scroll)
              </Link>{" "}
              (query only - timer keeps running)
            </li>
            <li>
              <Link scroll={false} to={`/blog/${ctx.params.slug}?tab=2`}>
                Change to ?tab=2 (no scroll)
              </Link>{" "}
              (query change - timer keeps running)
            </li>
          </ul>
        </div>

        {(() => {
          const author = getPostAuthor(ctx.params.slug);
          if (!author) return null;
          return (
            <p style={{ marginTop: "1rem", color: "#475569" }}>
              Written by{" "}
              <Link
                to={`/blog/author/${author.slug}`}
                style={{ color: "#3b82f6", textDecoration: "none" }}
              >
                {author.name}
              </Link>
            </p>
          );
        })()}

        <p style={{ marginTop: "1rem" }}>
          <a href="/blog">Back to blog</a>
        </p>
      </div>
    </DebugSegmentWrapper>
  );
}

// Logger middleware
export const blogLoggerMiddleware: Middleware[] = [
  (_ctx, next) => {
    console.log("Blog route accessed");
    next();
  },
];

// Post revalidation - only revalidate when slug changes, not on search param changes
export const postRevalidation: Revalidate<{ slug: string }, RSCRouter.Env> = ({
  currentParams,
  nextParams,
  actionId,
  defaultShouldRevalidate,
}) => {
  console.log(
    `[Blog] Checking revalidation: ${currentParams.slug} → ${nextParams.slug}`,
    {
      actionId,
      defaultShouldRevalidate,
    },
  );
  const isBlogProbeAction = actionId?.includes("handlers/blog/actions/probe");
  return isBlogProbeAction ?? defaultShouldRevalidate;
};
