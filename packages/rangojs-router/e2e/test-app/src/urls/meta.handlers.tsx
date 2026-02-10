import { Meta } from "@rangojs/router";
import type { Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { Breadcrumbs } from "../handles.js";
import { ChildMetaSetter } from "../components/ChildMetaSetter.js";
import { AsyncChildMetaSetter } from "../components/AsyncChildMetaSetter.js";
import type { routes } from "./meta.gen.js";

// --- metaTemplatePatterns handlers ---

export const MetaTemplateIndexHandler: Handler<"index", routes> = () => (
  <div data-testid="meta-template-index-page">
    <h1 data-testid="meta-template-index-title">Template Index</h1>
    <p data-testid="meta-template-index-description">
      This page uses the default title from the template.
    </p>
  </div>
);

export const MetaTemplateChildHandler: Handler<"child", routes> = (ctx) => {
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
};

export const MetaTemplateAbsoluteHandler: Handler<"absolute", routes> = (ctx) => {
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
};

export const MetaTemplateNestedHandler: Handler<"nested", routes> = () => (
  <div data-testid="meta-template-nested-page">
    <h1 data-testid="meta-template-nested-title">Nested Index</h1>
    <p data-testid="meta-template-nested-description">
      Uses nested template default.
    </p>
  </div>
);

export const MetaTemplateNestedChildHandler: Handler<"nestedChild", routes> = (ctx) => {
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
};

// --- metaUnsetPatterns handlers ---

export const MetaUnsetIndexHandler: Handler<"index", routes> = () => (
  <div data-testid="meta-unset-index-page">
    <h1 data-testid="meta-unset-index-title">Unset Index</h1>
    <p data-testid="meta-unset-index-description">
      This page inherits all parent meta.
    </p>
  </div>
);

export const MetaUnsetChildHandler: Handler<"child", routes> = (ctx) => {
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
};

export const MetaUnsetThenSetHandler: Handler<"unsetThenSet", routes> = (ctx) => {
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
};

// --- metaMergePatterns handlers ---

export const MetaMergeIndexHandler: Handler<"index", routes> = () => (
  <div data-testid="meta-merge-index-page">
    <h1 data-testid="meta-merge-index-title">Merge Index</h1>
    <p data-testid="meta-merge-index-description">
      Inherits all root meta.
    </p>
  </div>
);

export const MetaMergeChildHandler: Handler<"child", routes> = (ctx) => {
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
};

export const MetaMergeDeepHandler: Handler<"deep", routes> = (ctx) => {
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
};

// --- handlePatterns handlers ---

export const HandlePassthroughHandler: Handler<"handlePassthrough", routes> = (ctx) => {
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
};

export const HandlePassthroughAsyncHandler: Handler<"handlePassthroughAsync", routes> = (ctx) => {
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
};

// --- hydrationPatterns handlers ---

export const HydrationTestHandler: Handler<"hydrationTest", routes> = async () => {
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
};

// --- trailingSlashPatterns handlers ---

export const TrailingSlashIgnoreHandler: Handler<"trailingSlash.ignore", routes> = () => (
  <div data-testid="ts-ignore-page">
    <Link to="/" data-testid="back-link">← Back to Home</Link>
    <h1 data-testid="ts-ignore-title">Trailing Slash: Ignore</h1>
    <p data-testid="ts-ignore-description">
      This route matches both /ts-ignore and /ts-ignore/ without redirect.
    </p>
  </div>
);

export const TrailingSlashAlwaysHandler: Handler<"trailingSlash.always", routes> = () => (
  <div data-testid="ts-always-page">
    <Link to="/" data-testid="back-link">← Back to Home</Link>
    <h1 data-testid="ts-always-title">Trailing Slash: Always</h1>
    <p data-testid="ts-always-description">
      This route redirects /ts-always to /ts-always/ (308).
    </p>
  </div>
);

export const TrailingSlashNeverHandler: Handler<"trailingSlash.never", routes> = () => (
  <div data-testid="ts-never-page">
    <Link to="/" data-testid="back-link">← Back to Home</Link>
    <h1 data-testid="ts-never-title">Trailing Slash: Never</h1>
    <p data-testid="ts-never-description">
      This route redirects /ts-never/ to /ts-never (308).
    </p>
  </div>
);
