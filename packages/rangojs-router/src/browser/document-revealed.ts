/** Poll interval; setTimeout so a tab hidden after first paint still settles. */
const REVEAL_POLL_MS = 50;

/**
 * A Suspense boundary of the document React has not revealed yet: Fizz marks
 * one `$?` while its content streams and `$~` once its reveal is queued.
 */
function isUnrevealed(node: Comment): boolean {
  return node.isConnected && (node.data === "$?" || node.data === "$~");
}

function unrevealedBoundaries(): Comment[] {
  const found: Comment[] = [];
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (isUnrevealed(node as Comment)) found.push(node as Comment);
  }
  return found;
}

/**
 * Resolves once the document has finished parsing and no Suspense boundary of
 * it is unrevealed.
 *
 * Parsing ends with the stream, but React reveals a streamed boundary in
 * batches up to 300 ms later (Fizz's $RC marks it `$~` and reveals it from a
 * timer), so the boundary is still pending at DOMContentLoaded. A transition
 * then would make React client-render it over its server HTML.
 *
 * A reveal rewrites the same comment's data, or React removes the node; a
 * boundary nested in revealed content joins the document only then, so it
 * resolves only once a full walk finds none. Polls with setTimeout, not
 * requestAnimationFrame: a hidden tab never runs rAF, which would hold late
 * handle pushes and location state until the tab is shown again. A tab hidden
 * from load still waits: Fizz reveals boundaries from a rAF-gated script.
 */
export function awaitDocumentRevealed(): Promise<void> {
  return new Promise<void>((resolve) => {
    const start = (): void => {
      let pending = unrevealedBoundaries();
      const check = (): void => {
        pending = pending.filter(isUnrevealed);
        if (pending.length === 0) pending = unrevealedBoundaries();
        if (pending.length > 0) setTimeout(check, REVEAL_POLL_MS);
        else resolve();
      };
      check();
    };
    if (document.readyState !== "loading") start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  });
}
