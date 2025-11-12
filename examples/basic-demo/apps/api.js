/**
 * API Application
 * Served on api.* subdomain
 */

export default function handler(request, context) {
  const url = new URL(request.url);

  // API response
  return new Response(
    JSON.stringify(
      {
        app: 'API',
        version: '1.0.0',
        request: {
          method: request.method,
          url: url.href,
          hostname: url.hostname,
          pathname: url.pathname,
        },
        context: context,
        endpoints: [
          { method: 'GET', path: '/users', description: 'List users' },
          { method: 'GET', path: '/posts', description: 'List posts' },
          { method: 'POST', path: '/users', description: 'Create user' },
        ],
        message: 'API is running! Try: /users, /posts',
      },
      null,
      2
    ),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Version': '1.0.0',
      },
    }
  );
}
