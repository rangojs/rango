---
title: Parallel Routes
excerpt: Render multiple independent route segments simultaneously within a single layout.
author: Engineering Team
publishedAt: 2025-09-05
---

Parallel routes enable multiple segments of a page to load and render independently, each with their own loading and error states. This pattern is useful for dashboards, split views, and modal overlays where different parts of the UI fetch different data. Each parallel segment can be wrapped in its own Suspense boundary to avoid blocking the rest of the page.
