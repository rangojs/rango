import { cookies } from "@rangojs/router";
import { cache, lazy, type ReactElement, type ReactNode } from "react";

/**
 * Request-scoped (React.cache): the page warms it before it calls
 * getReturnedLazySession, so the page's render passes ConfigGate at once.
 */
export const getReturnedTreeConfig = cache(async (): Promise<string> => {
  await new Promise((resolve) => setTimeout(resolve, 30));
  return "cfg";
});

async function ConfigGate({
  children,
}: {
  children: ReactNode;
}): Promise<ReactElement> {
  await getReturnedTreeConfig();
  return <>{children}</>;
}

/**
 * Returns a lazy component that reads the session cookie behind ConfigGate.
 * When the page rendered the returned value itself, its render reached the
 * lazy before the value's encode did (the encode's React.cache is its own,
 * still cold), read the cookie outside the "use cache" guard, and the entry
 * stored the first visitor's session for the next.
 */
export async function getReturnedLazySession(
  probe: string,
): Promise<ReactElement> {
  "use cache";
  const Session = lazy(async () => {
    const session = cookies().get("session")?.value ?? "none";
    return {
      default: () => (
        <span data-testid="returned-lazy-session">{`session=${session}:${probe}`}</span>
      ),
    };
  });
  return (
    <ConfigGate>
      <Session />
    </ConfigGate>
  );
}
