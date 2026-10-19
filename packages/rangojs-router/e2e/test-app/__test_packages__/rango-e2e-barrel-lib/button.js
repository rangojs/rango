import { createElement } from "react";

export function Button(props) {
  return createElement(
    "button",
    { type: "button", "data-testid": props["data-testid"] },
    props.children,
  );
}
