import { Meta, Prerender } from "@rangojs/router";

import { HomeContent } from "@/components/home/home-content";
import { homeDescription, siteName } from "@/lib/site";

// Fully static marketing page — rendered once at build time, handler evicted
// from the production bundle. Runtime PPR shells serve the HTML on top.
export const HomePage = Prerender((ctx) => {
  const meta = ctx.use(Meta);
  meta({ title: siteName });
  meta({ content: homeDescription, name: "description" });
  return (
    <div className="shop-home pb-32 font-sans">
      <HomeContent />
    </div>
  );
});
