---
title: Build-Time Optimization
excerpt: Shift work from runtime to build time for faster page loads.
author: Performance Team
publishedAt: 2025-11-30
---

Pre-rendering at build time lets you pay the rendering cost once during deployment rather than on every request. Static content and known routes can be rendered ahead of time, with the output stored as serialized payloads that the runtime serves directly. This approach pairs well with incremental builds where only changed routes are re-rendered, keeping deployment times short even for large sites.
