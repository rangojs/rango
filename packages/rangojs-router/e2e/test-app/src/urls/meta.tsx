import { urls, Meta } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import {
  MetaTemplateLayout,
  MetaTemplateNestedLayout,
  MetaUnsetLayout,
  MetaMergeLayout,
  MetaMergeMiddleLayout,
} from "../components/layouts/index.js";
import { Breadcrumbs } from "../handles.js";
import { ChildMetaSetter } from "../components/ChildMetaSetter.js";
import { AsyncChildMetaSetter } from "../components/AsyncChildMetaSetter.js";

/**
 * Meta template routes URL patterns
 * Routes: metaTemplate.index, metaTemplate.child, metaTemplate.absolute, metaTemplate.nested, metaTemplate.nestedChild
 */
export const metaTemplatePatterns = urls(({ path, layout }) => [
  layout(MetaTemplateLayout, () => [
    // Index route - uses default title from template
    path(
      "/",
      () => (
        <div data-testid="meta-template-index-page">
          <h1 data-testid="meta-template-index-title">Template Index</h1>
          <p data-testid="meta-template-index-description">
            This page uses the default title from the template.
          </p>
        </div>
      ),
      { name: "index" }
    ),

    // Child route - string title gets template applied
    path(
      "/child",
      (ctx) => {
        const meta = ctx.use(Meta);
        meta({ title: "Child Page" }); // Should become "Child Page | Test Site"
        meta({ name: "description", content: "Child page description" });

        return (
          <div data-testid="meta-template-child-page">
            <h1 data-testid="meta-template-child-title">Template Child</h1>
            <p data-testid="meta-template-child-description">
              This page title should have template applied.
            </p>
          </div>
        );
      },
      { name: "child" }
    ),

    // Absolute route - bypasses template
    path(
      "/absolute",
      (ctx) => {
        const meta = ctx.use(Meta);
        meta({ title: { absolute: "Custom Absolute Title" } }); // No template
        meta({ name: "description", content: "Absolute page description" });

        return (
          <div data-testid="meta-template-absolute-page">
            <h1 data-testid="meta-template-absolute-title">Absolute Title</h1>
            <p data-testid="meta-template-absolute-description">
              This page title bypasses the template.
            </p>
          </div>
        );
      },
      { name: "absolute" }
    ),

    // Nested layout with its own template - overrides parent template
    layout(MetaTemplateNestedLayout, () => [
      // Nested index - uses nested default
      path(
        "/nested",
        () => (
          <div data-testid="meta-template-nested-page">
            <h1 data-testid="meta-template-nested-title">Nested Index</h1>
            <p data-testid="meta-template-nested-description">
              Uses nested template default.
            </p>
          </div>
        ),
        { name: "nested" }
      ),

      // Nested child - uses nested template
      path(
        "/nested/child",
        (ctx) => {
          const meta = ctx.use(Meta);
          meta({ title: "Nested Child" }); // Should become "Nested Child | Nested Section"

          return (
            <div data-testid="meta-template-nested-child-page">
              <h1 data-testid="meta-template-nested-child-title">Nested Child</h1>
              <p data-testid="meta-template-nested-child-description">
                Uses nested template.
              </p>
            </div>
          );
        },
        { name: "nestedChild" }
      ),
    ]),
  ]),
]);

/**
 * Meta unset routes URL patterns
 * Routes: metaUnset.index, metaUnset.child, metaUnset.unsetThenSet
 */
export const metaUnsetPatterns = urls(({ path, layout }) => [
  layout(MetaUnsetLayout, () => [
    // Index route - keeps all parent meta
    path(
      "/",
      () => (
        <div data-testid="meta-unset-index-page">
          <h1 data-testid="meta-unset-index-title">Unset Index</h1>
          <p data-testid="meta-unset-index-description">
            This page inherits all parent meta.
          </p>
        </div>
      ),
      { name: "index" }
    ),

    // Child route - unsets some parent meta
    path(
      "/child",
      (ctx) => {
        const meta = ctx.use(Meta);
        // Unset various meta tags
        meta({ unset: "name:robots" });
        meta({ unset: "property:og:image" });

        return (
          <div data-testid="meta-unset-child-page">
            <h1 data-testid="meta-unset-child-title">Unset Child</h1>
            <p data-testid="meta-unset-child-description">
              This page unsets robots and og:image meta.
            </p>
          </div>
        );
      },
      { name: "child" }
    ),

    // Route that unsets then sets same meta
    path(
      "/unset-then-set",
      (ctx) => {
        const meta = ctx.use(Meta);
        // Unset parent description, then set a new one
        meta({ unset: "name:description" });
        meta({ name: "description", content: "New description after unset" });
        // Unset title and set new one
        meta({ unset: "title" });
        meta({ title: "New Title After Unset" });

        return (
          <div data-testid="meta-unset-then-set-page">
            <h1 data-testid="meta-unset-then-set-title">Unset Then Set</h1>
            <p data-testid="meta-unset-then-set-description">
              This page unsets meta then sets new values.
            </p>
          </div>
        );
      },
      { name: "unsetThenSet" }
    ),
  ]),
]);

/**
 * Meta merge routes URL patterns
 * Routes: metaMerge.index, metaMerge.child, metaMerge.deep
 */
export const metaMergePatterns = urls(({ path, layout }) => [
  layout(MetaMergeLayout, () => [
    // Index - has all root meta
    path(
      "/",
      () => (
        <div data-testid="meta-merge-index-page">
          <h1 data-testid="meta-merge-index-title">Merge Index</h1>
          <p data-testid="meta-merge-index-description">
            Inherits all root meta.
          </p>
        </div>
      ),
      { name: "index" }
    ),

    // Child - overrides some, adds new
    path(
      "/child",
      (ctx) => {
        const meta = ctx.use(Meta);
        // Override title
        meta({ title: "Merge Child" });
        // Add new description (not set by parent)
        meta({ name: "description", content: "Child description" });
        // Override keywords
        meta({ name: "keywords", content: "child, override" });
        // Keep author and og:site_name from parent (don't set them)

        return (
          <div data-testid="meta-merge-child-page">
            <h1 data-testid="meta-merge-child-title">Merge Child</h1>
            <p data-testid="meta-merge-child-description">
              Overrides title and keywords, adds description, keeps author.
            </p>
          </div>
        );
      },
      { name: "child" }
    ),

    // Deep nested - multiple levels of overrides
    layout(MetaMergeMiddleLayout, () => [
      path(
        "/deep/nested",
        (ctx) => {
          const meta = ctx.use(Meta);
          // Deep page overrides title only
          meta({ title: "Deep Nested Page" });
          // Add og:title
          meta({ property: "og:title", content: "Deep OG Title" });
          // Middle author should be kept, not root author

          return (
            <div data-testid="meta-merge-deep-page">
              <h1 data-testid="meta-merge-deep-title">Deep Nested</h1>
              <p data-testid="meta-merge-deep-description">
                Has root keywords, middle author, own title and og:title.
              </p>
            </div>
          );
        },
        { name: "deep" }
      ),
    ]),
  ]),
]);

/**
 * Handle passthrough routes (not nested in meta layouts)
 * Routes: handlePassthrough, handlePassthroughAsync
 */
export const handlePatterns = urls(({ path, loading }) => [
  // Route for testing handle passthrough to child RSC components
  path(
    "/handle-passthrough",
    (ctx) => {
      const pushBreadcrumb = ctx.use(Breadcrumbs);
      const meta = ctx.use(Meta);

      // Push breadcrumb from parent
      pushBreadcrumb({ label: "Handle Passthrough Test", href: "/handle-passthrough" });

      return (
        <div data-testid="handle-passthrough-page">
          <Link to="/" data-testid="back-link">
            ← Back to Home
          </Link>
          <h1 data-testid="passthrough-title">Handle Passthrough Test</h1>
          <p data-testid="passthrough-description">
            Testing meta handle passed to child RSC component
          </p>
          {/* Pass meta function to child RSC component */}
          <ChildMetaSetter
            meta={meta}
            title="Child Set Title - RSC Router"
            description="Meta set by child RSC component"
          />
        </div>
      );
    },
    { name: "handlePassthrough" }
  ),

  // Route for testing async handle passthrough (meta set after delay)
  path(
    "/handle-passthrough-async",
    (ctx) => {
      const pushBreadcrumb = ctx.use(Breadcrumbs);
      const meta = ctx.use(Meta);

      // Push breadcrumb from parent
      pushBreadcrumb({ label: "Async Handle Passthrough", href: "/handle-passthrough-async" });

      return (
        <div data-testid="handle-passthrough-async-page">
          <Link to="/" data-testid="back-link">
            ← Back to Home
          </Link>
          <h1 data-testid="async-passthrough-title">Async Handle Passthrough Test</h1>
          <p data-testid="async-passthrough-description">
            Testing meta handle passed to async child RSC (2s delay)
          </p>
          {/* Pass meta function to async child RSC component */}
          <AsyncChildMetaSetter
            meta={meta}
            title="Async Child Title - RSC Router"
            description="Meta set by async child after 2s delay"
            delayMs={2000}
          />
        </div>
      );
    },
    { name: "handlePassthroughAsync" },
    () => [
      loading(
        <div data-testid="async-passthrough-loading">
          <p>Loading async child...</p>
        </div>
      ),
    ]
  ),
]);

/**
 * Hydration test route
 */
export const hydrationPatterns = urls(({ path }) => [
  path(
    "/hydration-test",
    async () => {
      const { HydrationMismatch } = await import("../components/HydrationMismatch.js");
      return (
        <div data-testid="hydration-test-page">
          <Link to="/" data-testid="back-link">
            ← Back to Home
          </Link>
          <h1 data-testid="hydration-test-title">Hydration Test</h1>
          <HydrationMismatch testId="hydration-mismatch" />
        </div>
      );
    },
    { name: "hydrationTest" }
  ),
]);

/**
 * Trailing slash routes
 */
export const trailingSlashPatterns = urls(({ path }) => [
  path(
    "/ts-ignore",
    () => (
      <div data-testid="ts-ignore-page">
        <Link to="/" data-testid="back-link">← Back to Home</Link>
        <h1 data-testid="ts-ignore-title">Trailing Slash: Ignore</h1>
        <p data-testid="ts-ignore-description">
          This route matches both /ts-ignore and /ts-ignore/ without redirect.
        </p>
      </div>
    ),
    { name: "trailingSlash.ignore", trailingSlash: "ignore" }
  ),

  path(
    "/ts-always",
    () => (
      <div data-testid="ts-always-page">
        <Link to="/" data-testid="back-link">← Back to Home</Link>
        <h1 data-testid="ts-always-title">Trailing Slash: Always</h1>
        <p data-testid="ts-always-description">
          This route redirects /ts-always to /ts-always/ (308).
        </p>
      </div>
    ),
    { name: "trailingSlash.always", trailingSlash: "always" }
  ),

  path(
    "/ts-never",
    () => (
      <div data-testid="ts-never-page">
        <Link to="/" data-testid="back-link">← Back to Home</Link>
        <h1 data-testid="ts-never-title">Trailing Slash: Never</h1>
        <p data-testid="ts-never-description">
          This route redirects /ts-never/ to /ts-never (308).
        </p>
      </div>
    ),
    { name: "trailingSlash.never", trailingSlash: "never" }
  ),
]);
