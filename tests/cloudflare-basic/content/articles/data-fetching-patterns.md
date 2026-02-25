---
title: Data Fetching Patterns
excerpt: Common approaches to loading data in server component architectures.
author: Docs Team
publishedAt: 2025-09-20
---

Server components simplify data fetching by allowing you to query databases and call APIs directly in your component code without exposing credentials to the client. Colocating data requirements with the components that use them eliminates the need for separate API route layers in many cases. Request deduplication and caching at the framework level prevent redundant fetches when multiple components need the same data.
