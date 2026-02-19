import type { Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { DebugSegmentWrapper } from "@/components/DebugSegmentWrapper.js";
import { blogPostsMeta, getAuthor } from "../data/mock-data.js";

export const IndexRoute: Handler<"/"> = () => (
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
