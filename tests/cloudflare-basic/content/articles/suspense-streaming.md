---
title: Suspense and Streaming
excerpt: Combine Suspense boundaries with streaming to build responsive loading experiences.
author: Performance Team
publishedAt: 2025-11-18
---

Suspense boundaries define the loading units of your application, and streaming delivers each unit as soon as it resolves. The server sends the shell and fallback content immediately, then streams in the resolved content for each Suspense boundary as data becomes available. This eliminates the waterfall pattern where the entire page waits for the slowest data source before anything is displayed.
