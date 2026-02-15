---
title: Routing Patterns
excerpt: Common patterns for organizing routes with layouts, includes, and middleware.
---

The router supports several patterns for organizing complex applications. Layouts, parallel routes, and includes let you compose route trees that scale with your app.

## Nested Layouts

Wrap routes in `layout()` to share UI chrome like navigation bars and sidebars. Layouts are server components that render an `Outlet` where child routes appear.

## Include for Modularity

Use `include()` to mount a set of routes under a URL prefix. Each included module is self-contained with its own route names. This is the foundation of the composable package pattern.

## Parallel Routes

Render multiple route segments simultaneously with `parallel()`. Each slot has its own loading and error boundaries. Useful for dashboards and split-pane layouts.
