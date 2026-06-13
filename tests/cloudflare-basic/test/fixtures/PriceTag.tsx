"use client";
import { type ReactElement, useState } from "react";

// A client island for the renderServerTree dogfood. Never executed
// (deserialize-only); it exists so a server component can pass typed props
// (number, Date) across the client boundary and we can assert they round-trip.
export function PriceTag(props: {
  amount: number;
  currency: string;
  asOf: Date;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <button data-testid="price-tag" onClick={() => setOpen(!open)}>
      {props.currency} {props.amount.toFixed(2)}
    </button>
  );
}
