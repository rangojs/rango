import type { Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { HrefTestClient } from "../components/HrefTestClient.js";

export const HrefIndexHandler: Handler<"href.index"> = (ctx) => {
  // Server-side ctx.reverse tests
  // Using absolute names for type safety (local names work at runtime but aren't type-safe)
  const localIndexHref = ctx.reverse("href.index"); // Absolute name for /href
  const localDetailHref = ctx.reverse("href.detail", { id: "123" }); // Absolute name for /href/123
  const absoluteBlogHref = ctx.reverse("blog.index"); // Absolute name for /blog
  const pathBasedHref = ctx.reverse("/about"); // Path-based (always allowed)

  return (
    <div data-testid="href-index-page">
      <h1 data-testid="href-page-title">Href Test Page</h1>

      <section data-testid="server-href-section">
        <h2>Server-side ctx.reverse</h2>
        <ul>
          <li data-testid="server-local-index">
            Local index: <code>{localIndexHref}</code>
          </li>
          <li data-testid="server-local-detail">
            Local detail: <code>{localDetailHref}</code>
          </li>
          <li data-testid="server-absolute-blog">
            Absolute blog.index: <code>{absoluteBlogHref}</code>
          </li>
          <li data-testid="server-path-based">
            Path-based /about: <code>{pathBasedHref}</code>
          </li>
        </ul>

        <h3>Server-rendered Links</h3>
        <div data-testid="server-links">
          <Link to={localIndexHref} data-testid="server-link-local-index">
            Local Index Link
          </Link>
          {" | "}
          <Link to={localDetailHref} data-testid="server-link-local-detail">
            Local Detail Link
          </Link>
          {" | "}
          <Link to={absoluteBlogHref} data-testid="server-link-absolute-blog">
            Blog Link
          </Link>
        </div>
      </section>

      <section data-testid="client-href-section">
        <h2>Client-side href + useMount</h2>
        <HrefTestClient />
      </section>

      <section data-testid="navigation-section">
        <h2>Navigation Links</h2>
        <div>
          <Link to="/" data-testid="back-home-link">
            ← Back to Home
          </Link>
          {" | "}
          <Link to="/href/item-abc" data-testid="goto-detail-link">
            Go to Detail (item-abc)
          </Link>
          {" | "}
          <Link to="/href/nested" data-testid="goto-nested-link">
            Go to Nested
          </Link>
        </div>
      </section>
    </div>
  );
};

export const HrefDetailHandler: Handler<"href.detail"> = (ctx) => {
  // Test ctx.reverse inside detail route
  // Using absolute names for type safety
  const backToIndex = ctx.reverse("href.index");
  const siblingDetail = ctx.reverse("href.detail", { id: "sibling-item" });

  return (
    <div data-testid="href-detail-page">
      <h1 data-testid="detail-title">Detail: {ctx.params.id}</h1>

      <section data-testid="detail-server-href">
        <h2>Server-side ctx.reverse (from detail route)</h2>
        <ul>
          <li data-testid="detail-server-back-index">
            Back to index: <code>{backToIndex}</code>
          </li>
          <li data-testid="detail-server-sibling">
            Sibling detail: <code>{siblingDetail}</code>
          </li>
        </ul>
      </section>

      <section data-testid="detail-client-href">
        <h2>Client-side href + useMount (from detail route)</h2>
        <HrefTestClient isDetailPage />
      </section>

      <nav>
        <Link to={backToIndex} data-testid="detail-back-link">
          ← Back to Index
        </Link>
        {" | "}
        <Link to={siblingDetail} data-testid="detail-sibling-link">
          Go to Sibling
        </Link>
      </nav>
    </div>
  );
};
