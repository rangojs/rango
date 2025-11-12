/**
 * Host Router Demo Server
 *
 * Demonstrates all host router features:
 * - Multiple apps on different domains/subdomains
 * - Cookie-based host override
 * - Middleware execution
 * - Path-based routing
 * - Fallback handler
 */

import { createServer } from 'node:http';
import { createHostRouter, defineHosts } from 'host-router';

const PORT = 3000;

// Define hosts with type safety
const hosts = defineHosts({
  admin: ['admin.*', 'admin.localhost'],
  api: ['api.*', 'api.localhost'],
  blog: ['./blog', 'localhost/blog'],
  main: ['.', 'localhost'],
  catchAll: ['**'],
});

// Create router with cookie override
const router = createHostRouter({
  debug: true,
  hostOverride: {
    cookieName: 'x-requested-host',
    allowedHosts: ['localhost', '127.0.0.1'],
    validate: (request, cookieValue, context) => {
      console.log(`Validating cookie: ${cookieValue}`);

      // Example: Only allow specific hosts
      const validHosts = [
        'admin.localhost',
        'api.localhost',
        'localhost',
      ];

      if (!validHosts.includes(cookieValue)) {
        throw new Error(`Host not allowed: ${cookieValue}`);
      }

      return cookieValue;
    },
  },
});

// Global middleware (runs for all hosts)
router.use(async (request, context, next) => {
  console.log(`[Global Middleware] ${request.method} ${request.url}`);
  context.timestamp = Date.now();

  const response = await next();

  const duration = Date.now() - context.timestamp;
  console.log(`[Global Middleware] Response ${response.status} (${duration}ms)`);

  return response;
});

// Fallback handler for invalid cookie on localhost
router.fallback().map(() => import('./apps/host-selector.js'));

// Admin app with middleware
router
  .host(hosts.admin)
  .use(async (request, context, next) => {
    console.log('[Admin Middleware] Checking auth...');
    context.adminAuth = true;
    context.user = { id: 1, name: 'Admin User', role: 'admin' };
    return next();
  })
  .map(() => import('./apps/admin.js'));

// API app
router.host(hosts.api).map(() => import('./apps/api.js'));

// Blog app (path-based)
router.host(hosts.blog).map(() => import('./apps/blog.js'));

// Main app
router.host(hosts.main).map(() => import('./apps/main.js'));

// Catch-all for unmatched
router.host(hosts.catchAll).map((request) => {
  const url = new URL(request.url);
  return new Response(
    `
<!DOCTYPE html>
<html>
<head>
  <title>Catch-All - Host Router Demo</title>
  <style>
    body { font-family: system-ui; max-width: 800px; margin: 50px auto; padding: 20px; }
    h1 { color: #7c3aed; }
  </style>
</head>
<body>
  <h1>🌐 Catch-All Handler</h1>
  <p><strong>Hostname:</strong> ${url.hostname}</p>
  <p><strong>Path:</strong> ${url.pathname}</p>
  <p>This catches any domain/path not matched by other patterns.</p>
  <a href="http://localhost:3000">← Back to Main App</a>
</body>
</html>
    `.trim(),
    {
      headers: { 'Content-Type': 'text/html' },
    }
  );
});

// Create HTTP server
const server = createServer(async (req, res) => {
  try {
    // Convert Node.js request to Web API Request
    const url = `http://${req.headers.host}${req.url}`;
    const headers = new Headers();

    // Copy headers (including cookies)
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) {
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
    }

    const request = new Request(url, {
      method: req.method,
      headers,
    });

    // Route the request
    const response = await router.match(request, { env: 'development' });

    // Send response
    res.statusCode = response.status;

    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    const body = await response.text();
    res.end(body);
  } catch (error) {
    console.error('Server error:', error);

    res.statusCode = error.name === 'NoRouteMatchError' ? 404 : 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        {
          error: error.message,
          name: error.name,
          cause: error.cause,
        },
        null,
        2
      )
    );
  }
});

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║     Host Router Demo Server                        ║
╚════════════════════════════════════════════════════╝

🚀 Server running on http://localhost:${PORT}

Available endpoints:
  • http://localhost:${PORT}              → Main App
  • http://admin.localhost:${PORT}        → Admin Panel
  • http://api.localhost:${PORT}          → API
  • http://localhost:${PORT}/blog         → Blog

Cookie Override (on localhost):
  document.cookie = "x-requested-host=admin.localhost; path=/"

Press Ctrl+C to stop
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\nShutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
