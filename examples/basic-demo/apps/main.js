/**
 * Main Application
 * Served on apex domains (example.com, www.example.com)
 */

export default function handler(request, context) {
  const url = new URL(request.url);

  return new Response(
    `
<!DOCTYPE html>
<html>
<head>
  <title>Main App - Host Router Demo</title>
  <style>
    body { font-family: system-ui; max-width: 800px; margin: 50px auto; padding: 20px; }
    h1 { color: #2563eb; }
    .info { background: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0; }
    .code { background: #1e293b; color: #e2e8f0; padding: 15px; border-radius: 6px; overflow-x: auto; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    ul { line-height: 1.8; }
  </style>
</head>
<body>
  <h1>🏠 Main Application</h1>

  <div class="info">
    <p><strong>Current URL:</strong> ${url.href}</p>
    <p><strong>Hostname:</strong> ${url.hostname}</p>
    <p><strong>Path:</strong> ${url.pathname}</p>
    <p><strong>Context:</strong> ${JSON.stringify(context, null, 2)}</p>
  </div>

  <h2>Try Other Apps</h2>
  <ul>
    <li><a href="http://admin.localhost:3000">Admin Panel</a> (subdomain)</li>
    <li><a href="http://api.localhost:3000">API</a> (subdomain)</li>
    <li><a href="http://localhost:3000/blog">Blog</a> (path-based)</li>
  </ul>

  <h2>Test Cookie Override</h2>
  <p>Set a cookie to override the host:</p>
  <div class="code">
document.cookie = "x-requested-host=admin.localhost; path=/"
  </div>
  <p>Then reload this page to route to admin app!</p>

  <button onclick="document.cookie = 'x-requested-host=admin.localhost; path=/'; location.reload()">
    Override to Admin
  </button>
  <button onclick="document.cookie = 'x-requested-host=api.localhost; path=/'; location.reload()">
    Override to API
  </button>
  <button onclick="document.cookie = 'x-requested-host=; path=/; max-age=0'; location.reload()">
    Clear Override
  </button>
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
