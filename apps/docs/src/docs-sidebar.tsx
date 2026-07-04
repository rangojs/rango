import { Static } from "@rangojs/router";

import { pageTree, type TreeNode } from "./content";
import { SidebarLink } from "./sidebar-link";

// Inline SVG — lucide-react icons resolve to `undefined` inside Rango server
// components (they render only in "use client" modules), so this stays framework-safe.
function ChevronRight({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

// Collapsible groups use native <details> (no client JS), always open by
// default; the current-page highlight lives client-side in SidebarLink.
function NavNode({ depth, node }: { depth: number; node: TreeNode }) {
  if (node.url) {
    return (
      <li>
        <SidebarLink title={node.title} to={node.url} />
      </li>
    );
  }

  return (
    <li>
      <details className="group" open>
        <summary className="flex cursor-pointer list-none items-center justify-between py-1 text-gray-900 transition-colors hover:text-gray-1000 [&::-webkit-details-marker]:hidden">
          <span className={depth === 0 ? "font-medium text-gray-1000" : ""}>
            {node.title}
          </span>
          <ChevronRight className="size-3.5 text-gray-700 transition-transform group-open:rotate-90" />
        </summary>
        {node.children ? (
          <ul className="mt-1 ml-1 space-y-1 border-l border-gray-alpha-400 pl-3">
            {node.children.map((child, index) => (
              <NavNode
                depth={depth + 1}
                key={child.url ?? `${child.title}-${index}`}
                node={child}
              />
            ))}
          </ul>
        ) : null}
      </details>
    </li>
  );
}

/**
 * The left-hand pages nav as a Static segment: the tree is identical for
 * every docs page (always-open groups, live-pathname highlight), so it is
 * rendered once at build time and shared — mounted via the `@docsNav`
 * parallel slot on the docs routes.
 */
export const DocsNav = Static(() => (
  <ul className="space-y-1">
    {pageTree.map((node, index) => (
      <NavNode
        depth={0}
        key={node.url ?? `${node.title}-${index}`}
        node={node}
      />
    ))}
  </ul>
));
