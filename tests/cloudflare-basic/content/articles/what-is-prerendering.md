---
title: What is Pre-rendering?
excerpt: Pre-rendering generates HTML at build time instead of on every request.
author: Docs Team
publishedAt: 2025-06-01
---

Pre-rendering is a technique where route segments are rendered at build time and stored as static Flight payloads. At runtime the server serves the pre-built payload without executing the handler — no cold starts, no build-only dependencies shipped to production.

This is ideal for content that exists at build time: documentation, marketing pages, blog posts, changelogs. Parent layouts stay live (user data, A/B tests, cart) while only the route's own subtree is pre-rendered.

## Why Pre-render?

- **No runtime cost** — the handler doesn't run on each request
- **No build-only deps in production** — markdown parsers, file system reads stay out of the server bundle
- **Instant first response** — no cold start penalty for the first visitor

## How It Works

In dev mode, pre-render handlers run on every request just like normal handlers so you get instant feedback while developing. At build time, the handler is executed once per parameter set and the RSC Flight output is stored.
