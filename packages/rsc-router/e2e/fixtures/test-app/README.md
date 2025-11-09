# E2E Test App

Minimal RSC application for E2E testing with Playwright.

## Purpose

This app is used by Playwright E2E tests to validate:
- Real browser RSC streaming
- SPA navigation behavior
- Partial rendering
- Segment management
- Framework integration

## Setup

Uses RSC Router framework out-of-the-box:

**entry.rsc.tsx** (3 lines)
**entry.browser.tsx** (1 line)
**entry.ssr.tsx** (1 line)

Total: 5 lines of framework code!

## Running

```bash
npm install
npm run dev
# Open: http://localhost:3002
```

## Routes

- `/` - Home page (test ID: `home-page`)
- `/about` - About page (test ID: `about-page`)
- `/blog` - Blog index (test ID: `blog-index`)
- `/blog/:slug` - Blog post (test ID: `blog-post`)
- `/dashboard` - Dashboard (test ID: `dashboard-page`)

All pages have `data-testid` attributes for Playwright selectors.
