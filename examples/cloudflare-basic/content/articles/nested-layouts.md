---
title: Nested Layouts
excerpt: Build complex UIs with nested layout segments that persist across navigations.
author: Engineering Team
publishedAt: 2025-08-25
---

Nested layouts allow different sections of a page to have their own layout wrappers that remain mounted during navigation. When a user navigates between sibling routes, only the changed segment re-renders while parent layouts stay intact. This preserves UI state like scroll position and input focus, resulting in a smoother user experience.
