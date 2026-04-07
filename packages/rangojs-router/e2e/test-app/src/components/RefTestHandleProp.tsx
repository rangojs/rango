"use client";

import { useHandle, Link, type Breadcrumbs } from "@rangojs/router/client";

/**
 * Client component that receives a handle as a prop (passed from server component).
 * Tests that handle refs survive RSC serialization via toJSON, and that
 * the collect function is recovered from the registry.
 *
 * Uses `typeof Breadcrumbs` for the prop type -- this infers the full generic
 * from the handle definition, so the accumulated data type is automatically type-checked.
 */
export function RefTestHandleProp({ handle }: { handle: typeof Breadcrumbs }) {
  const breadcrumbs = useHandle(handle);
  return (
    <div data-testid="ref-test-handle-page">
      <Link to="/" data-testid="back-link">
        &larr; Back to Home
      </Link>
      <h1 data-testid="ref-test-handle-title">Handle Ref as Prop</h1>
      <div data-testid="ref-test-handle-data">
        {breadcrumbs.length === 0 ? (
          <p data-testid="ref-test-handle-empty">No breadcrumbs</p>
        ) : (
          <ul data-testid="ref-test-handle-list">
            {breadcrumbs.map((crumb, i) => (
              <li key={i} data-testid={`ref-test-handle-item-${i}`}>
                <Link to={crumb.href}>{crumb.label}</Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
