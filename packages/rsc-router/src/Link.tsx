'use client';

import React from 'react';

export type LinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  prefetch?: boolean;
};

/**
 * RouterLink component for client-side navigation
 * Automatically intercepted by the browser entry navigation listener
 */
export function Link({ prefetch = false, ...props }: LinkProps) {
  // The click handling is done by the global listener in entry.browser.tsx
  // This component just ensures proper anchor rendering

  React.useEffect(() => {
    if (prefetch && props.href) {
      // Prefetch the route on mount or when href changes
      // This could trigger a background fetch to warm the cache
      const url = new URL(props.href, window.location.origin);
      if (url.origin === window.location.origin) {
        // Add prefetch logic here if needed
        console.log(`[Link] Prefetch enabled for ${props.href}`);
      }
    }
  }, [prefetch, props.href]);

  return <a {...props} />;
}

/**
 * NavLink component that adds active state
 */
export function NavLink({
  className,
  activeClassName = 'active',
  ...props
}: LinkProps & { activeClassName?: string }) {
  const isActive = props.href === window.location.pathname;

  return (
    <Link
      {...props}
      className={`${className || ''} ${isActive ? activeClassName : ''}`.trim()}
    />
  );
}