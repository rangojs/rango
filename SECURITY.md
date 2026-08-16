# Security Policy

## Supported versions

`@rangojs/router` is pre-1.0 and under active development. Security fixes land
on `main` and ship in the next `latest` and/or `experimental` npm release.
Older 0.x lines are not patched.

## Reporting a vulnerability

Do **not** open a public issue for a security report.

Report privately through GitHub Security Advisories on this repository
(Security → Report a vulnerability). That keeps the report out of the public
issue tracker until a fix is published.

Please include:

- the affected package version (`@rangojs/router@…`)
- the execution path (document render, client navigation, Server Action, no-JS
  form / PE, loader fetch, middleware, prerender / cache hit)
- a minimal reproduction, or enough of the route tree and request to reconstruct
  one
- impact: auth bypass, cache leak of request-specific data, CSRF, header/cookie
  injection, XSS via nonce / script handles, or similar

## What is in scope

Anything that changes who can run an action, what a cache key can see, or which
`Response` the client receives, including:

- Server Action, loader, and no-JS form CSRF / origin checks
- request-context tainting and cache-key isolation
- middleware short-circuit vs render ordering (auth that can be skipped)
- cookie, header, and redirect handling across JS and PE
- CSP nonce propagation and document-rendered script handles
- host-router isolation between sibling apps

## What is out of scope

- Denial of service against an app that mounts the router
- Vulnerabilities in React, Vite, `@vitejs/plugin-rsc`, or a deployment
  platform, unless the router mishandles their contract
- Issues that require a malicious package already inside the app's dependency
  tree
- Missing application-level authorization (the router cannot invent your
  auth checks)

## Process

Reports are acknowledged as soon as they are seen. There is no SLA; this is a
solo-maintained project. Please do not disclose the issue publicly until a
release that contains the fix is out, or 90 days have passed, whichever is
sooner.
