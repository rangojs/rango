"use client";

// The only importer of ./actions.js: the server graph never reaches that
// module, only this client component does.
import { like } from "./actions.js";

export function LikeForm() {
  return (
    <form action={like}>
      <button type="submit">Like</button>
    </form>
  );
}
