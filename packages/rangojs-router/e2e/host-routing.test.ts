import { test, expect } from '@playwright/test';
import { useFixture } from './fixture';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fixture = useFixture({
  root: path.resolve(__dirname, '..'),
  mode: 'dev',
  command: 'npx tsx e2e/host-router/test-server.ts',
});

test.describe('Host Router - Basic Routing', () => {
  test('should route to main app on apex domain', async ({ request }) => {
    const response = await request.get(fixture.url('/'));
    const data = await response.json();

    expect(data.app).toBe('main');
    expect(response.status()).toBe(200);
  });

  test('should route to admin subdomain', async ({ request }) => {
    const url = fixture.url('/').replace('localhost', 'admin.localhost');
    const response = await request.get(url);
    const data = await response.json();

    expect(data.app).toBe('admin');
    expect(data.middleware).toBe('admin-auth');
  });

  test('should route to API subdomain', async ({ request }) => {
    const url = fixture.url('/users').replace('localhost', 'api.localhost');
    const response = await request.get(url);
    const data = await response.json();

    expect(data.app).toBe('api');
    expect(data.url).toContain('/users');
  });

  test('should route to blog path on apex', async ({ request }) => {
    const response = await request.get(fixture.url('/blog'));
    const data = await response.json();

    expect(data.app).toBe('blog');
  });

  test('should route blog sub-path', async ({ request }) => {
    const response = await request.get(fixture.url('/blog/post-1'));
    const data = await response.json();

    expect(data.app).toBe('blog');
    expect(data.url).toContain('/blog/post-1');
  });

  test('should match patterns in order (first match wins)', async ({
    request,
  }) => {
    const response = await request.get(fixture.url('/'));
    const data = await response.json();

    expect(data.app).toBe('main');
  });

  test('should catch unknown subdomains', async ({ request }) => {
    const url = fixture.url('/').replace('localhost', 'unknown.localhost');
    const response = await request.get(url);
    const data = await response.json();

    expect(data.app).toBe('main');
  });
});

test.describe('Host Router - Pattern Matching', () => {
  test('should match apex domain pattern', async ({ request }) => {
    const response = await request.get(fixture.url('/'));
    const data = await response.json();

    expect(data.app).toBe('main');
  });

  test('should match subdomain pattern', async ({ request }) => {
    const url = fixture.url('/').replace('localhost', 'admin.localhost');
    const response = await request.get(url);
    const data = await response.json();

    expect(data.app).toBe('admin');
  });

  test('should match path prefix pattern', async ({ request }) => {
    const response = await request.get(fixture.url('/blog/my-post'));
    const data = await response.json();

    expect(data.app).toBe('blog');
    expect(data.url).toContain('/blog/my-post');
  });

  test('should not match wrong path', async ({ request }) => {
    const blogResponse = await request.get(fixture.url('/blog'));
    const blogData = await blogResponse.json();
    expect(blogData.app).toBe('blog');

    const adminResponse = await request.get(fixture.url('/admin'));
    const adminData = await adminResponse.json();
    expect(adminData.app).toBe('main');
  });

  test('should match multi-level subdomain to catch-all', async ({
    request,
  }) => {
    const url = fixture.url('/').replace('localhost', 'a.b.localhost');
    const response = await request.get(url);
    const data = await response.json();

    expect(data.app).toBe('catch-all');
  });
});

test.describe('Host Router - Cookie Override', () => {
  test('should override host using cookie on localhost', async ({ page }) => {
    await page.context().addCookies([
      {
        name: 'x-requested-host',
        value: 'admin.localhost',
        domain: 'localhost',
        path: '/',
      },
    ]);

    const response = await page.goto(fixture.url('/'));
    expect(response?.status()).toBe(200);

    const data = await response?.json();
    expect(data.app).toBe('admin');
    expect(data.middleware).toBe('admin-auth');
  });

  test('should override to API using cookie', async ({ page }) => {
    await page.context().addCookies([
      {
        name: 'x-requested-host',
        value: 'api.localhost',
        domain: 'localhost',
        path: '/',
      },
    ]);

    const response = await page.goto(fixture.url('/users'));
    const data = await response?.json();

    expect(data.app).toBe('api');
    expect(data.url).toContain('/users');
  });

  test('should preserve path when using cookie override', async ({ page }) => {
    await page.context().addCookies([
      {
        name: 'x-requested-host',
        value: 'admin.localhost',
        domain: 'localhost',
        path: '/',
      },
    ]);

    const response = await page.goto(fixture.url('/dashboard'));
    const data = await response?.json();

    expect(data.app).toBe('admin');
    expect(data.url).toContain('/dashboard');
  });

  test('should work without cookie (use actual host)', async ({ page }) => {
    const response = await page.goto(fixture.url('/'));
    const data = await response?.json();

    expect(data.app).toBe('main');
  });

  test('should trigger fallback on invalid cookie value', async ({ page }) => {
    await page.context().addCookies([
      {
        name: 'x-requested-host',
        value: 'http://invalid',
        domain: 'localhost',
        path: '/',
      },
    ]);

    const response = await page.goto(fixture.url('/'));
    const data = await response?.json();

    expect(data.type).toBe('fallback');
    expect(data.error).toContain('Invalid hostname');
  });

  test('should trigger fallback with invalid hostname header', async ({
    request,
  }) => {
    const response = await request.get(fixture.url('/'), {
      headers: {
        Cookie: 'x-requested-host=http://invalid',
      },
    });

    const data = await response.json();
    expect(data.type).toBe('fallback');
  });
});

test.describe('Host Router - Middleware', () => {
  test('should execute host-specific middleware', async ({ request }) => {
    const url = fixture.url('/').replace('localhost', 'admin.localhost');
    const response = await request.get(url);
    const data = await response.json();

    expect(data.middleware).toBe('admin-auth');
  });

  test('should not execute host-specific middleware on other hosts', async ({
    request,
  }) => {
    const response = await request.get(fixture.url('/'));
    const data = await response.json();

    expect(data.middleware).toBeUndefined();
  });

  test('should execute middleware with cookie override', async ({ page }) => {
    await page.context().addCookies([
      {
        name: 'x-requested-host',
        value: 'admin.localhost',
        domain: 'localhost',
        path: '/',
      },
    ]);

    const response = await page.goto(fixture.url('/'));
    const data = await response?.json();

    expect(data.middleware).toBe('admin-auth');
  });
});
