"use client";

import { useActionState, type ReactNode } from "react";
import { Link, MetaTags, href } from "@rangojs/router/client";

export function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <MetaTags />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              * { box-sizing: border-box; margin: 0; padding: 0; }
              body { font-family: system-ui, sans-serif; line-height: 1.6; padding: 2rem; max-width: 760px; margin: 0 auto; }
              nav { margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #eee; }
              nav a { margin-right: 1rem; color: #0070f3; text-decoration: none; }
              nav a:hover { text-decoration: underline; }
              h1 { margin-bottom: 1rem; }
              time { font-variant-numeric: tabular-nums; font-weight: 600; }
            `,
          }}
        />
      </head>
      <body>
        <nav data-testid="nav">
          <Link to={href("/")} data-testid="nav-home">
            Home
          </Link>
          <Link to={href("/about")} data-testid="nav-about">
            About
          </Link>
          <Link to={href("/cached")} data-testid="nav-cached">
            Cached
          </Link>
          <Link
            to={href("/ppr-inline-action")}
            data-testid="nav-ppr-inline-action"
          >
            PPR Action
          </Link>
        </nav>
        {children}
      </body>
    </html>
  );
}

interface PprInlineActionState {
  captured: string;
  submitted: string;
}

export function PprInlineActionForm({
  action,
  renderedCaptured,
}: {
  action: (
    previous: PprInlineActionState,
    formData: FormData,
  ) => Promise<PprInlineActionState>;
  renderedCaptured: string;
}) {
  const [state, formAction] = useActionState(action, {
    captured: "none",
    submitted: "none",
  });

  return (
    <form action={formAction} data-testid="ppr-inline-action-page">
      <p data-testid="ppr-inline-action-rendered">
        {`rendered:${renderedCaptured}`}
      </p>
      <input name="value" defaultValue="from-client" />
      <button type="submit" data-testid="ppr-inline-action-submit">
        Submit
      </button>
      <p data-testid="ppr-inline-action-captured">
        {`captured:${state.captured}`}
      </p>
      <p data-testid="ppr-inline-action-submitted">
        {`submitted:${state.submitted}`}
      </p>
    </form>
  );
}
