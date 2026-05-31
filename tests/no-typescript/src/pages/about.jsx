// Handler form (receives ctx) so it can demonstrate named-route reverse.
// ctx.reverse resolves names from the router's RUNTIME route table — it does
// not import the generated router.named-routes.gen.ts. That generated file is
// TypeScript and only provides compile-time name/param checking (irrelevant to
// a JS app); reverse/href work at runtime without it.
export function AboutPage(ctx) {
  const aboutHref = ctx.reverse("about");
  const postHref = ctx.reverse("blog.post", { slug: "hello-world" });
  return (
    <div data-testid="about-page">
      <h1 data-testid="about-title">About</h1>
      <p data-testid="about-description">
        Built with @rangojs/router using urls(), path(), layout(), and include()
        - all in plain JavaScript.
      </p>
      <ul data-testid="reverse-demo">
        <li>
          reverse(&quot;about&quot;) ={" "}
          <span data-testid="reverse-about">{aboutHref}</span>
        </li>
        <li>
          reverse(&quot;blog.post&quot;, &#123; slug &#125;) ={" "}
          <span data-testid="reverse-post">{postHref}</span>
        </li>
      </ul>
    </div>
  );
}
