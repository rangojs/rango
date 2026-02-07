/**
 * Test Server for Host Router E2E Tests
 *
 * Simple HTTP server that uses the host router to demonstrate routing.
 */

import { createServer } from 'node:http';
import { createHostRouter } from '../../src/host/router.js';

const PORT = 0; // Use dynamic port

// Create router with cookie override
const router = createHostRouter({
  debug: true,
  hostOverride: {
    cookieName: 'x-requested-host',
    allowedHosts: ['localhost', '127.0.0.1'],
  },
});

// Fallback handler for host selection
router.fallback().map((request, context) => {
  return new Response(
    JSON.stringify({
      type: 'fallback',
      error: context.error?.message,
      availableHosts: ['admin.localhost', 'api.localhost', 'localhost'],
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
});

// Admin host
router
  .host(['admin.*', 'admin.localhost'])
  .use(async (request, context, next) => {
    context.middleware = 'admin-auth';
    return next();
  })
  .map((request, context) => {
    return new Response(
      JSON.stringify({
        app: 'admin',
        url: request.url,
        middleware: context.middleware,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  });

// API host
router.host(['api.*', 'api.localhost']).map((request) => {
  return new Response(
    JSON.stringify({
      app: 'api',
      url: request.url,
      method: request.method,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
    }
  );
});

// Blog path on apex
router.host(['./blog', 'localhost/blog']).map((request) => {
  return new Response(
    JSON.stringify({
      app: 'blog',
      url: request.url,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
    }
  );
});

// Main app (apex domain)
router.host(['.', 'localhost']).map((request) => {
  return new Response(
    JSON.stringify({
      app: 'main',
      url: request.url,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
    }
  );
});

// Catch-all
router.host(['**']).map((request) => {
  return new Response(
    JSON.stringify({
      app: 'catch-all',
      url: request.url,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
    }
  );
});

// Create HTTP server
const server = createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host}${req.url}`;
    const headers = new Headers();

    for (const [key, value] of Object.entries(req.headers)) {
      if (value) {
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
    }

    const request = new Request(url, {
      method: req.method,
      headers,
    });

    const response = await router.match(request);

    res.statusCode = response.status;

    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    const body = await response.text();
    res.end(body);
  } catch (error: any) {
    console.error('Server error:', error);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: error.message,
        name: error.name,
      })
    );
  }
});

server.listen(PORT, () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`http://localhost:${port}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
