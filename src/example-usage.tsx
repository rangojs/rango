/**
 * Example usage of GlobalTypedLink component
 *
 * This demonstrates how to use the global type-safe Link component
 * in your application without any factory functions or setup.
 */

import React from 'react';
import { GlobalTypedLink } from 'rsc-router';

export function NavigationMenu() {
  return (
    <nav style={{ display: 'flex', gap: '1rem', padding: '1rem' }}>
      {/* Simple routes without parameters */}
      <GlobalTypedLink to="/">Home</GlobalTypedLink>
      <GlobalTypedLink to="/about">About</GlobalTypedLink>
      <GlobalTypedLink to="/items">Items</GlobalTypedLink>

      {/* Routes with parameters - TypeScript enforces params */}
      <GlobalTypedLink to="/user/:id" params={{ id: "current" }}>
        My Profile
      </GlobalTypedLink>

      {/* Multiple parameters */}
      <GlobalTypedLink
        to="/post/:postId/comments/:commentId"
        params={{ postId: "123", commentId: "456" }}
      >
        View Comment
      </GlobalTypedLink>
    </nav>
  );
}

export function UserCard({ userId }: { userId: string }) {
  return (
    <div className="user-card">
      <h3>User {userId}</h3>
      {/* TypeScript ensures we provide the id parameter */}
      <GlobalTypedLink
        to="/user/:id"
        params={{ id: userId }}
        className="user-link"
      >
        View Profile
      </GlobalTypedLink>
    </div>
  );
}

export function ItemsList({ items }: { items: Array<{ id: string; name: string }> }) {
  return (
    <ul>
      {items.map(item => (
        <li key={item.id}>
          {item.name}
          {/* Type-safe link with dynamic params */}
          <GlobalTypedLink
            to="/items/:id"
            params={{ id: item.id }}
            style={{ marginLeft: '1rem' }}
          >
            View Details
          </GlobalTypedLink>
        </li>
      ))}
    </ul>
  );
}

// This component demonstrates TypeScript errors
export function InvalidExamples() {
  return (
    <div>
      {/* These would produce TypeScript errors at compile time: */}

      {/* ❌ Error: Type '"/invalid"' is not assignable to type 'AppRoutePaths' */}
      {/* <GlobalTypedLink to="/invalid">Invalid Route</GlobalTypedLink> */}

      {/* ❌ Error: Property 'params' is missing */}
      {/* <GlobalTypedLink to="/user/:id">Missing Params</GlobalTypedLink> */}

      {/* ❌ Error: Object literal may only specify known properties */}
      {/* <GlobalTypedLink to="/user/:id" params={{ wrong: "123" }}>Wrong Param</GlobalTypedLink> */}

      {/* ❌ Error: Type '{ extra: string; }' is not assignable */}
      {/* <GlobalTypedLink to="/about" params={{ extra: "not needed" }}>Extra Param</GlobalTypedLink> */}
    </div>
  );
}