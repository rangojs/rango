/**
 * Host Selector Application
 * Shown on allowed hosts (localhost) when no valid cookie is set
 */

export default function handler(request, context) {
  const url = new URL(request.url);
  const error = context.error;

  const availableHosts = [
    { name: 'Main App', host: '', description: 'Clear cookie to use main app' },
    {
      name: 'Admin Panel',
      host: 'admin.localhost',
      description: 'Admin dashboard with authentication',
    },
    { name: 'API', host: 'api.localhost', description: 'REST API endpoints' },
    { name: 'Blog', host: '', path: '/blog', description: 'Path-based blog app' },
  ];

  return new Response(
    `
<!DOCTYPE html>
<html>
<head>
  <title>Host Selector - Host Router Demo</title>
  <style>
    body { font-family: system-ui; max-width: 800px; margin: 50px auto; padding: 20px; background: #fefce8; }
    h1 { color: #ca8a04; }
    .info { background: #fff; padding: 20px; border-radius: 8px; margin: 20px 0; border: 2px solid #fde047; }
    .error { background: #fee; padding: 15px; border-radius: 6px; color: #991b1b; margin: 20px 0; }
    .host-card { background: #fff; padding: 20px; margin: 15px 0; border-radius: 8px; border-left: 4px solid #ca8a04; cursor: pointer; transition: all 0.2s; }
    .host-card:hover { transform: translateX(5px); box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
    .host-card h3 { margin-top: 0; color: #ca8a04; }
    .code { background: #1e293b; color: #e2e8f0; padding: 10px; border-radius: 4px; font-family: monospace; font-size: 14px; }
    button { background: #ca8a04; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; margin: 5px; }
    button:hover { background: #a16207; }
    .custom { margin: 20px 0; }
    input { padding: 10px; border: 2px solid #fde047; border-radius: 6px; width: 300px; }
  </style>
</head>
<body>
  <h1>🎯 Host Selector</h1>

  ${
    error
      ? `
  <div class="error">
    <strong>⚠️ Error:</strong> ${error.message || 'Unknown error'}
  </div>
  `
      : ''
  }

  <div class="info">
    <p><strong>You're on:</strong> ${url.hostname}</p>
    <p>This is a development helper that lets you choose which app to route to.</p>
    <p>Set the <code>x-requested-host</code> cookie to override routing!</p>
  </div>

  <h2>Available Apps</h2>

  ${availableHosts
    .map(
      (app) => `
  <div class="host-card" onclick="setCookie('${app.host}', '${app.path || ''}')">
    <h3>${app.name}</h3>
    <p>${app.description}</p>
    ${app.host ? `<div class="code">x-requested-host=${app.host}</div>` : ''}
    ${app.path ? `<div class="code">Path: ${app.path}</div>` : ''}
  </div>
  `
    )
    .join('')}

  <div class="custom">
    <h3>Custom Host</h3>
    <input type="text" id="customHost" placeholder="Enter hostname (e.g., admin.example.com)" />
    <button onclick="setCustomCookie()">Set Custom Host</button>
  </div>

  <button onclick="clearCookie()">Clear Cookie</button>

  <script>
    function setCookie(host, path = '') {
      if (host) {
        document.cookie = \`x-requested-host=\${host}; path=/\`;
        window.location.href = 'http://localhost:3000' + path;
      } else {
        clearCookie();
      }
    }

    function setCustomCookie() {
      const host = document.getElementById('customHost').value;
      if (host) {
        document.cookie = \`x-requested-host=\${host}; path=/\`;
        window.location.reload();
      }
    }

    function clearCookie() {
      document.cookie = 'x-requested-host=; path=/; max-age=0';
      window.location.href = 'http://localhost:3000';
    }
  </script>
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
