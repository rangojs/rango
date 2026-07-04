import { Link } from "@rangojs/router/client";
import type { AnchorHTMLAttributes, ReactNode } from "react";

import { Pre } from "@/components/code-block";
import { CartBrowser } from "@/components/fake-browser/cart-browser";
import { ContentBrowser } from "@/components/fake-browser/content-browser";
import { HomeBrowser } from "@/components/fake-browser/home-browser";
import { PDPBrowser } from "@/components/fake-browser/pdp-browser";
import { PLPBrowser } from "@/components/fake-browser/plp-browser";

/** `a` mapping: internal links use Rango's client Link, externals/hashes are plain. */
function DocLink({
  href,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (href?.startsWith("/")) {
    return (
      <Link to={href} {...rest}>
        {children}
      </Link>
    );
  }
  const external = href?.startsWith("http");
  return (
    <a
      href={href}
      rel={external ? "noopener noreferrer" : undefined}
      target={external ? "_blank" : undefined}
      {...rest}
    >
      {children}
    </a>
  );
}

export function Card({
  children,
  href,
  title,
}: {
  children?: ReactNode;
  href?: string;
  title: string;
}) {
  const inner = (
    <div className="h-full rounded-lg border border-neutral-200 p-4 transition-colors hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:border-neutral-700 dark:hover:bg-neutral-900">
      <p className="font-medium text-neutral-900 dark:text-neutral-100">
        {title}
      </p>
      {children ? (
        <div className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {children}
        </div>
      ) : null}
    </div>
  );
  if (!href) return inner;
  return href.startsWith("/") ? (
    <Link className="no-underline" to={href}>
      {inner}
    </Link>
  ) : (
    <a className="no-underline" href={href}>
      {inner}
    </a>
  );
}

export function Cards({ children }: { children?: ReactNode }) {
  return <div className="not-prose grid gap-3 sm:grid-cols-2">{children}</div>;
}

export const mdxComponents = {
  a: DocLink,
  Card,
  CartBrowser,
  Cards,
  ContentBrowser,
  HomeBrowser,
  PDPBrowser,
  PLPBrowser,
  pre: Pre,
} as const;
