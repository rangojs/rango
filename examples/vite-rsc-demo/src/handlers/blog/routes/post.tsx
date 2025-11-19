import type { RouteHandler } from "rsc-router/server";
import type { blogRoutes } from "@/routes.js";
import { DebugSegmentWrapper } from "@/components/DebugSegmentWrapper.js";
import { SegmentTimer } from "@/components/SegmentTimer.js";
import { CurrentURL } from "@/components/CurrentURL.js";

export const PostRoute: RouteHandler<typeof blogRoutes, "post"> = (ctx) => {
  const renderTime = new Date().toISOString();
  const queryParams: [string, string][] = Array.from(
    ctx.searchParams.entries()
  );

  // Get previous URL from request header (sent by client during partial navigation)
  const previousClientUrl = ctx.request.headers.get(
    "X-RSC-Router-Client-Path"
  );

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
            📸 Server Snapshot (at render time: {renderTime})
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
          <p
            style={{
              fontSize: "0.7rem",
              color: "#856404",
              marginTop: "0.5rem",
              marginBottom: 0,
              fontStyle: "italic",
            }}
          >
            ↑ Frozen server data. Won't update if segment not revalidated!
          </p>
        </div>

        <SegmentTimer
          segmentId="R2.1 (Blog Post)"
          serverRenderTime={renderTime}
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
              changes → timer resets)
            </li>
            <li>
              <a href={`/blog/${ctx.params.slug}?tab=1`}>Add ?tab=1</a> (query
              only → timer keeps running)
            </li>
            <li>
              <a href={`/blog/${ctx.params.slug}?tab=2`}>Change to ?tab=2</a>{" "}
              (query change → timer keeps running)
            </li>
          </ul>
          <p
            style={{
              fontSize: "0.85rem",
              color: "#666",
              marginTop: "0.5rem",
              marginBottom: 0,
            }}
          >
            <strong>Expected:</strong> Timer resets only when slug changes, not
            when query params change.
          </p>
        </div>

        <p style={{ marginTop: "1rem" }}>
          <a href="/blog">← Back to blog</a>
        </p>
      </div>
    </DebugSegmentWrapper>
  );
};
