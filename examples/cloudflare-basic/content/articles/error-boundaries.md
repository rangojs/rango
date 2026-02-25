---
title: Error Boundaries in RSC
excerpt: Handle server and client errors gracefully with structured error boundaries.
author: Docs Team
publishedAt: 2025-11-05
---

Error boundaries in a server component architecture must handle failures from both server rendering and client hydration. When a server component throws during rendering, the framework can catch it at the segment level and render a fallback without taking down the entire page. Pairing error boundaries with Suspense boundaries gives you fine-grained control over which sections degrade gracefully and which retry automatically.
