---
title: Type-Safe Routing
excerpt: Leverage TypeScript to catch routing errors at compile time.
author: Docs Team
publishedAt: 2025-10-12
---

Type-safe routing generates TypeScript definitions from your route tree so that link targets and parameter access are checked at compile time. Mistyped route names or missing parameters become build errors rather than runtime bugs. This approach works especially well with file-system routing where the route structure is known statically and types can be generated automatically.
