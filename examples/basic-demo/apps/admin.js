/**
 * Admin Application
 * Served on admin.* subdomain
 * Demonstrates host-specific middleware
 */

export default function handler(request, context) {
  const url = new URL(request.url);

  return new Response(
    `
<!DOCTYPE html>
<html>
<head>
  <title>Admin Panel - Host Router Demo</title>
  <style>
    body { font-family: system-ui; max-width: 800px; margin: 50px auto; padding: 20px; background: #fef2f2; }
    h1 { color: #dc2626; }
    .info { background: #fff; padding: 20px; border-radius: 8px; margin: 20px 0; border: 2px solid #fca5a5; }
    .badge { background: #dc2626; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px; }
    a { color: #dc2626; }
    .code { background: #1e293b; color: #e2e8f0; padding: 15px; border-radius: 6px; font-family: monospace; }
  </style>
</head>
<body>
  <h1>🔐 Admin Panel <span class="badge">Protected</span></h1>

  <div class="info">
    <p><strong>Current URL:</strong> ${url.href}</p>
    <p><strong>Hostname:</strong> ${url.hostname}</p>
    <p><strong>Path:</strong> ${url.pathname}</p>
    <p><strong>Middleware:</strong> ${context.adminAuth ? '✅ Executed' : '❌ Not executed'}</p>
    <p><strong>User:</strong> ${context.user ? JSON.stringify(context.user) : 'Not authenticated'}</p>
  </div>

  <h2>Admin Features</h2>
  <ul>
    <li>User Management</li>
    <li>System Settings</li>
    <li>Analytics Dashboard</li>
  </ul>

  <h2>How You Got Here</h2>
  <p>This admin app is served when:</p>
  <ul>
    <li>Domain matches pattern: <code>admin.*</code> (admin.example.com, admin.localhost)</li>
    <li>Cookie override: <code>x-requested-host=admin.localhost</code> on allowed hosts</li>
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
