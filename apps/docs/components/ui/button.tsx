"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-gray-1000 text-background-100 hover:bg-gray-1000/90",
        destructive: "bg-red-800 text-background-100 hover:bg-red-800/90",
        secondary:
          "bg-background-100 text-gray-1000 shadow-[0_0_0_1px_var(--ds-gray-400)] hover:bg-gray-100",
        outline:
          "border border-gray-alpha-400 bg-background-100 text-gray-1000 hover:bg-gray-100",
        tertiary: "text-gray-1000 hover:bg-gray-alpha-200",
        ghost: "text-gray-1000 hover:bg-gray-alpha-200",
        link: "text-gray-1000 underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
}

// `render` swaps the rendered element (e.g. `render={<Link to="/docs" />}`)
// while keeping the button styling; this replaces the Radix `asChild` slot.
function Button({
  className,
  variant,
  size,
  render,
  ...props
}: ButtonProps): React.ReactElement {
  const defaultProps = {
    className: cn(buttonVariants({ variant, size, className })),
    "data-slot": "button",
  };
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export { Button, buttonVariants };
