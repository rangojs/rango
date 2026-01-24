import type { DocumentProps } from "@ivogt/rsc-router";

export default function Document({ children }: DocumentProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>RSC Router - Cloudflare CSP Example</title>
        <style
          dangerouslySetInnerHTML={{
            __html: `
              * { box-sizing: border-box; margin: 0; padding: 0; }
              body { font-family: system-ui, sans-serif; line-height: 1.6; padding: 2rem; max-width: 800px; margin: 0 auto; }
              nav { margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #eee; }
              nav a { margin-right: 1rem; color: #0070f3; text-decoration: none; }
              nav a:hover { text-decoration: underline; }
              h1 { margin-bottom: 1rem; }
              button { padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; background: #0070f3; color: white; border: none; border-radius: 4px; }
              button:hover { background: #0051a8; }
              .counter { font-size: 2rem; margin: 1rem 0; }
            `,
          }}
        />
      </head>
      <body>
        <div id="root">{children}</div>
      </body>
    </html>
  );
}
