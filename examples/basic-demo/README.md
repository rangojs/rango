# Host Router - Basic Demo

A complete demonstration of the host-router package showcasing all major features.

## Features Demonstrated

- ✅ **Host-based routing** - Multiple apps on different domains/subdomains
- ✅ **Path-based routing** - Apps served on specific paths
- ✅ **Cookie override** - Test different apps locally without DNS changes
- ✅ **Middleware** - Global and host-specific middleware
- ✅ **Lazy loading** - Apps loaded on-demand
- ✅ **Fallback handler** - Host selector UI for development
- ✅ **Type-safe patterns** - Using `defineHosts()`
- ✅ **Error handling** - Custom error types with debugging context

## Setup

```bash
# From the examples/basic-demo directory
pnpm install

# Or from monorepo root
pnpm install
```

## Running the Demo

```bash
# Start the server
pnpm start

# Or with auto-reload
pnpm dev
```

The server will start on `http://localhost:3000`

## Available Apps

### Main App
- **URL**: http://localhost:3000
- **Pattern**: `.` (apex domain) or `localhost`
- **Description**: Landing page with links to other apps

### Admin Panel
- **URL**: http://admin.localhost:3000
- **Pattern**: `admin.*`, `admin.localhost`
- **Description**: Admin dashboard with authentication middleware
- **Features**: Host-specific middleware that adds user context

### API
- **URL**: http://api.localhost:3000
- **Pattern**: `api.*`, `api.localhost`
- **Description**: REST API that returns JSON
- **Try**: http://api.localhost:3000/users

### Blog
- **URL**: http://localhost:3000/blog
- **Pattern**: `./blog`, `localhost/blog`
- **Description**: Path-based blog application
- **Features**: Matches any apex domain with /blog path

### Host Selector (Fallback)
- **Triggered**: When invalid cookie is set on localhost
- **Description**: UI to select which app to route to
- **Features**: Sets cookie and reloads

## Testing Cookie Override

### Method 1: Browser DevTools

1. Visit http://localhost:3000
2. Open DevTools Console
3. Run:
   ```javascript
   document.cookie = "x-requested-host=admin.localhost; path=/"
   ```
4. Reload the page - you'll be routed to Admin Panel!

### Method 2: Use the Host Selector

1. Set an invalid cookie or visit http://localhost:3000 first time
2. You'll see the Host Selector UI
3. Click on any app to set the cookie and route to it

### Method 3: Direct Links with Buttons

Visit http://localhost:3000 and use the "Override to Admin/API" buttons

## Architecture

```
server.js
├── createHostRouter({ hostOverride, debug })
├── Global Middleware (logging, timing)
├── Fallback Handler → apps/host-selector.js
└── Routes:
    ├── admin.* → apps/admin.js (with auth middleware)
    ├── api.* → apps/api.js
    ├── ./blog → apps/blog.js
    ├── . → apps/main.js
    └── ** → catch-all handler
```

## Pattern Examples in Code

```javascript
// Type-safe host definitions
const hosts = defineHosts({
  admin: ['admin.*', 'admin.localhost'],
  api: ['api.*', 'api.localhost'],
  blog: ['./blog', 'localhost/blog'],
  main: ['.', 'localhost'],
  catchAll: ['**'],
});

// Use in router
router.host(hosts.admin).map(() => import('./apps/admin.js'));
```

## Middleware Examples

### Global Middleware
```javascript
router.use(async (request, context, next) => {
  context.timestamp = Date.now();
  const response = await next();
  console.log(`Duration: ${Date.now() - context.timestamp}ms`);
  return response;
});
```

### Host-Specific Middleware
```javascript
router
  .host(['admin.*'])
  .use(async (request, context, next) => {
    context.user = await authenticate(request);
    return next();
  })
  .map(() => import('./apps/admin.js'));
```

## Cookie Override Validation

The demo server validates cookie values:

```javascript
validate: (request, cookieValue, context) => {
  const validHosts = ['admin.localhost', 'api.localhost', 'localhost'];

  if (!validHosts.includes(cookieValue)) {
    throw new Error(`Host not allowed: ${cookieValue}`);
  }

  return cookieValue;
}
```

## Error Handling

All errors extend `HostRouterError`:

```javascript
try {
  await router.match(request);
} catch (error) {
  if (error instanceof HostRouterError) {
    console.log('Router error:', error.message);
    console.log('Cause:', error.cause); // Debugging context
  }
}
```

## Testing Different Hosts Locally

Since browsers don't resolve `*.localhost` consistently, you can:

1. **Use Cookie Override** (recommended):
   - Visit http://localhost:3000
   - Set cookie: `x-requested-host=admin.localhost`
   - Reload to test admin app

2. **Edit `/etc/hosts`** (alternative):
   ```
   127.0.0.1 admin.localhost
   127.0.0.1 api.localhost
   ```

3. **Use curl**:
   ```bash
   # Test admin with cookie
   curl -H "Cookie: x-requested-host=admin.localhost" http://localhost:3000

   # Test API
   curl http://api.localhost:3000

   # Test blog path
   curl http://localhost:3000/blog
   ```

## Next Steps

- Modify `apps/*.js` to add your own functionality
- Add more routes in `server.js`
- Try different pattern combinations
- Test middleware chains
- Explore error handling

## Troubleshooting

**Cookie not working?**
- Make sure you're on localhost (not 127.0.0.1)
- Check cookie is set: DevTools → Application → Cookies
- Verify cookie value matches a valid host

**Subdomain not resolving?**
- Some browsers don't resolve `*.localhost` automatically
- Use cookie override instead
- Or add entries to `/etc/hosts`

**Port already in use?**
- Change PORT variable in `server.js`
- Or kill the existing process: `lsof -ti:3000 | xargs kill`
