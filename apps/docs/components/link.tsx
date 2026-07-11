"use client";

import { Link as RangoLink } from "@rangojs/router/client";
import {
  type AnchorHTMLAttributes,
  type ComponentProps,
  type ForwardedRef,
  forwardRef,
  type ReactNode,
} from "react";

type RangoLinkProps = ComponentProps<typeof RangoLink>;

export interface LinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> {
  href: string;
  prefetch?: boolean | RangoLinkProps["prefetch"];
  scroll?: boolean;
  replace?: boolean;
  children?: ReactNode;
}

function LinkImpl(
  { href, prefetch, scroll, replace, children, ...rest }: LinkProps,
  ref: ForwardedRef<HTMLAnchorElement>,
) {
  // External / hash links stay plain anchors.
  if (!href.startsWith("/")) {
    return (
      <a href={href} ref={ref} {...rest}>
        {children}
      </a>
    );
  }
  const prefetchStrategy: RangoLinkProps["prefetch"] =
    typeof prefetch === "boolean" ? (prefetch ? "hover" : "none") : prefetch;
  return (
    <RangoLink
      prefetch={prefetchStrategy}
      ref={ref}
      replace={replace}
      scroll={scroll}
      to={href}
      {...rest}
    >
      {children}
    </RangoLink>
  );
}

const Link = forwardRef(LinkImpl);
export default Link;
