"use client";
import {
  type ForwardRefExoticComponent,
  type NamedExoticComponent,
  type ReactElement,
  type RefAttributes,
  forwardRef,
  memo,
  useState,
} from "react";

// memo(...) and forwardRef(...) exports are OBJECTS at runtime, not functions —
// the fixture that pins down memo/forwardRef boundary handling.
export const MemoBadge: NamedExoticComponent<{ count: number }> = memo(
  function MemoBadge(props: { count: number }): ReactElement {
    const [open] = useState(false);
    return (
      <span data-testid="memo-badge">
        {props.count}
        {open ? "!" : ""}
      </span>
    );
  },
);

export const RefInput: ForwardRefExoticComponent<
  { label: string } & RefAttributes<HTMLInputElement>
> = forwardRef(function RefInput(
  props: { label: string },
  ref: React.Ref<HTMLInputElement>,
): ReactElement {
  return <input ref={ref} aria-label={props.label} data-testid="ref-input" />;
});
