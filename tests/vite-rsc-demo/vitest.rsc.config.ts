/**
 * Flight (RSC) test project for vite-rsc-demo — real RSC rendering via
 * `@rangojs/router/testing/flight` under the `react-server` condition. Pure leaf
 * server components only (no router alias).
 */
import { defineConfig } from "vitest/config";

process.env.NODE_ENV = "production";

export default defineConfig({
  resolve: {
    conditions: ["react-server"],
  },
  test: {
    globals: true,
    include: ["test/**/*.rsc-test.{ts,tsx}"],
    exclude: ["node_modules", "dist", "e2e"],
    pool: "forks",
    execArgv: ["--conditions=react-server"],
  },
});
