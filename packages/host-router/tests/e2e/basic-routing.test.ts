import { test, expect } from '@playwright/test';

test.describe('Basic Host Routing', () => {
  test('should route to main app on apex domain', async ({ request }) => {
    const response = await request.get('http://localhost:3100/');
    const data = await response.json();

    expect(data.app).toBe('main');
    expect(response.status()).toBe(200);
  });

  test('should route to admin subdomain', async ({ request }) => {
    const response = await request.get('http://admin.localhost:3100/');
    const data = await response.json();

    expect(data.app).toBe('admin');
    expect(data.middleware).toBe('admin-auth');
  });

  test('should route to API subdomain', async ({ request }) => {
    const response = await request.get('http://api.localhost:3100/users');
    const data = await response.json();

    expect(data.app).toBe('api');
    expect(data.url).toContain('/users');
  });

  test('should route to blog path on apex', async ({ request }) => {
    const response = await request.get('http://localhost:3100/blog');
    const data = await response.json();

    expect(data.app).toBe('blog');
  });

  test('should route blog sub-path', async ({ request }) => {
    const response = await request.get('http://localhost:3100/blog/post-1');
    const data = await response.json();

    expect(data.app).toBe('blog');
    expect(data.url).toContain('/blog/post-1');
  });

  test('should match patterns in order (first match wins)', async ({
    request,
  }) => {
    // localhost matches both '.' and 'localhost' patterns,
    // but should match 'localhost' first since it's more specific
    const response = await request.get('http://localhost:3100/');
    const data = await response.json();

    expect(data.app).toBe('main');
  });

  test('should catch unknown subdomains with catch-all', async ({
    request,
  }) => {
    // unknown.localhost is a single-level subdomain, doesn't match any specific pattern,
    // but matches '.' (apex) pattern in the route definition for 'localhost'
    const response = await request.get('http://unknown.localhost:3100/');
    const data = await response.json();

    // This matches the '.' pattern because localhost is in the apex pattern
    expect(data.app).toBe('main');
  });
});
