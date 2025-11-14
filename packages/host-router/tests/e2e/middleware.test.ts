import { test, expect } from '@playwright/test';

test.describe('Middleware Execution', () => {
  test('should execute host-specific middleware', async ({ request }) => {
    const response = await request.get('http://admin.localhost:3100/');
    const data = await response.json();

    expect(data.middleware).toBe('admin-auth');
  });

  test('should not execute host-specific middleware on other hosts', async ({
    request,
  }) => {
    const response = await request.get('http://localhost:3100/');
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

    const response = await page.goto('http://localhost:3100/');
    const data = await response?.json();

    // Should execute admin middleware because of cookie override
    expect(data.middleware).toBe('admin-auth');
  });
});
