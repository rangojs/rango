import { test, expect } from '@playwright/test';

test.describe('Pattern Matching', () => {
  test('should match apex domain pattern', async ({ request }) => {
    const response = await request.get('http://localhost:3100/');
    const data = await response.json();

    expect(data.app).toBe('main');
  });

  test('should match subdomain pattern', async ({ request }) => {
    const response = await request.get('http://admin.localhost:3100/');
    const data = await response.json();

    expect(data.app).toBe('admin');
  });

  test('should match path prefix pattern', async ({ request }) => {
    const response = await request.get('http://localhost:3100/blog/my-post');
    const data = await response.json();

    expect(data.app).toBe('blog');
    expect(data.url).toContain('/blog/my-post');
  });

  test('should not match wrong path', async ({ request }) => {
    // /blog should match blog app, /admin should not
    const blogResponse = await request.get('http://localhost:3100/blog');
    const blogData = await blogResponse.json();
    expect(blogData.app).toBe('blog');

    // /admin doesn't have a specific route, should hit main
    const adminResponse = await request.get('http://localhost:3100/admin');
    const adminData = await adminResponse.json();
    expect(adminData.app).toBe('main');
  });

  test('should match multi-level subdomain to catch-all', async ({
    request,
  }) => {
    const response = await request.get('http://a.b.localhost:3100/');
    const data = await response.json();

    expect(data.app).toBe('catch-all');
  });
});
