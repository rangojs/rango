import type { RouteHandler } from "@ivogt/rsc-router/server";
import type { blogRoutes } from "@/routes.js";
import { DebugSegmentWrapper } from "@/components/DebugSegmentWrapper.js";

export const IndexRoute: RouteHandler<typeof blogRoutes, "blog.index"> = () => (
  <DebugSegmentWrapper type="route" name="Blog Index">
    <div>
      <h2>Blog Posts</h2>
      <p className="segment-id">Segment: Blog Index Route</p>
      <ul>
        <li>
          <a href="/blog/hello-world">Hello World</a>
        </li>
        <li>
          <a href="/blog/react-server-components">React Server Components</a>
        </li>
        <li>
          <a href="/blog/router-design">Router Design</a>
        </li>
      </ul>
    </div>
  </DebugSegmentWrapper>
);
