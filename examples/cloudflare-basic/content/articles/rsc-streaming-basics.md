---
title: RSC Streaming Basics
excerpt: Learn how React Server Components leverage streaming to deliver content progressively.
author: Engineering Team
publishedAt: 2025-06-01
---

React Server Components use streaming to send rendered chunks to the client as they become available, rather than waiting for the entire page to finish rendering. This approach significantly reduces Time to First Byte and allows users to see content sooner. Combined with Suspense boundaries, streaming gives developers fine-grained control over which parts of the UI load independently.
