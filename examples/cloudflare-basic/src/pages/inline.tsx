import { Link } from "@rangojs/router/client";
import { reverse } from "../router.js";

export function InlineIndexPage() {
  return (
    <div className="max-w-2xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-4">Inline Routes Demo</h1>
      <p className="text-gray-600 mb-6">This page is defined inline in urls.tsx</p>
      <nav className="flex gap-4">
        <Link to={reverse("inlineDocs")} className="text-blue-600 hover:underline">Docs</Link>
        <Link to={reverse("inlinePricing")} className="text-blue-600 hover:underline">Pricing</Link>
      </nav>
    </div>
  );
}

export function InlineDocsPage() {
  return (
    <div className="max-w-2xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-4">Documentation</h1>
      <Link to={reverse("inlineIndex")} className="text-blue-600 hover:underline">&larr; Back</Link>
    </div>
  );
}

export function InlinePricingPage() {
  return (
    <div className="max-w-2xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-4">Pricing</h1>
      <Link to={reverse("inlineIndex")} className="text-blue-600 hover:underline">&larr; Back</Link>
    </div>
  );
}
