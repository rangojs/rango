---
title: Server Components vs SSR
excerpt: Understand the key differences between React Server Components and traditional server-side rendering.
author: Docs Team
publishedAt: 2025-07-18
---

Traditional SSR renders the full component tree on the server, sends HTML, then hydrates the entire page on the client. React Server Components take a different approach by keeping server-only components out of the client bundle entirely. This means less JavaScript shipped to the browser and a clearer separation between server and client concerns.
