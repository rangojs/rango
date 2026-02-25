---
title: Code Splitting with RSC
excerpt: How server components naturally reduce client bundle size through automatic code splitting.
author: Performance Team
publishedAt: 2025-10-28
---

Server components are never included in the client JavaScript bundle, which provides automatic code splitting at the component boundary. Only components marked with "use client" and their dependencies are shipped to the browser. This means adding server-only logic like data transformation or formatting never increases the amount of JavaScript your users download.
