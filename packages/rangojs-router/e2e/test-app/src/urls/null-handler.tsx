/**
 * Child component for the null-handler regression test.
 * Renders inside a parallel slot under a route whose handler returns null.
 */
export function NullHandlerChild({
  cached,
  useCache,
}: {
  cached?: boolean;
  useCache?: boolean;
}) {
  const variant = useCache ? "use-cache" : cached ? "cached" : "plain";
  return (
    <div data-testid={`null-handler-child-${variant}`}>
      <span data-testid={`null-handler-child-${variant}-text`}>
        parallel slot rendered ({variant})
      </span>
    </div>
  );
}
