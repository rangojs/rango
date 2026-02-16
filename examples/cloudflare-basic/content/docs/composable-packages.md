---
title: Composable Packages
excerpt: Build reusable route packages that can be mounted anywhere with include().
---

Composable packages export `urls()` patterns that consumers mount via `include()`. The package uses local route names and doesn't know its mount prefix — the router resolves names through the include chain at runtime.

## The Factory Pattern

Export a factory function that takes configuration and returns `urls()` patterns. This lets consumers provide content, authentication, or other app-specific concerns without the package depending on them directly.

## Local Route Names

Inside a composable package, use local names like "index" and "detail" instead of fully-qualified names. When the consumer mounts the package with `include("/docs", patterns, { name: "docs" })`, the router prefixes names automatically.

## Example

A documentation package might export a `createDocsPatterns` factory that accepts an array of articles. The consumer provides the content and the package provides the routes, components, and search API.
