/**
 * Blog Application
 * Served on /blog path
 */

export default function handler(request, context) {
  const url = new URL(request.url);

  return new Response(
    `
<!DOCTYPE html>
<html>
<head>
  <title>Blog - Host Router Demo</title>
  <style>
    body { font-family: system-ui; max-width: 800px; margin: 50px auto; padding: 20px; background: #f0fdf4; }
    h1 { color: #16a34a; }
    .info { background: #fff; padding: 20px; border-radius: 8px; margin: 20px 0; border: 2px solid #86efac; }
    .post { background: #fff; padding: 15px; margin: 15px 0; border-radius: 6px; border-left: 4px solid #16a34a; }
    a { color: #16a34a; }
  </style>
</head>
<body>
  <h1>📝 Blog</h1>

  <div class="info">
    <p><strong>Current URL:</strong> ${url.href}</p>
    <p><strong>Path:</strong> ${url.pathname}</p>
  </div>

  <h2>Recent Posts</h2>

  <div class="post">
    <h3>Getting Started with Host Router</h3>
    <p>Learn how to route multiple applications based on domain patterns...</p>
    <small>January 12, 2025</small>
  </div>

  <div class="post">
    <h3>Cookie-Based Development Workflow</h3>
    <p>Test different apps locally without modifying DNS...</p>
    <small>January 11, 2025</small>
  </div>

  <div class="post">
    <h3>Pattern Matching Deep Dive</h3>
    <p>Understanding wildcard patterns for flexible routing...</p>
    <small>January 10, 2025</small>
  </div>

  <h2>How You Got Here</h2>
  <p>This blog app is served when:</p>
  <ul>
    <li>Path matches: <code>./blog</code> (any apex domain with /blog path)</li>
    <li>Works on: localhost/blog, example.com/blog, etc.</li>
  </ul>

  <a href="http://localhost:3000">← Back to Main App</a>
</body>
</html>
    `.trim(),
    {
      headers: {
        'Content-Type': 'text/html',
      },
    }
  );
}
