---
title: The Flight Protocol
excerpt: A look at how React serializes server component output for the client.
author: Engineering Team
publishedAt: 2025-07-30
---

The Flight protocol is React's wire format for transmitting server component output to the client. It serializes the component tree into a streamable format that the client runtime can incrementally parse and render. This protocol enables features like selective hydration and out-of-order streaming without requiring the client to re-execute server logic.
