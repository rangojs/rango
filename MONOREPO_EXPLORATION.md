# Monorepo Structure Analysis - Vite RSC

## Overview
This is a monorepo project using pnpm workspaces with Turbo for build orchestration. It contains packages for RSC (React Server Components) routing and example applications.

---

## 1. MONOREPO ORGANIZATION

### Workspace Structure
```
vite-rsc/
├── apps/                          # Application packages
│   └── web/                       # Main web application
├── packages/                      # Reusable packages
│   └── rsc-router/               # Core routing library
├── pnpm-workspace.yaml           # Workspace configuration
├── package.json                  # Root package.json (monorepo definition)
├── turbo.json                    # Build orchestration config
├── tsconfig.base.json            # Shared TypeScript config
└── ...
```

### Workspace Configuration
**File**: `/Users/ivotodorov/Development/temp/vite-rsc/pnpm-workspace.yaml`
```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

**Root Package.json** (`/Users/ivotodorov/Development/temp/vite-rsc/package.json`)
```json
{
  "name": "vite-rsc-monorepo",
  "version": "0.0.0",
  "private": true,
  "license": "MIT",
  "type": "module",
  "packageManager": "pnpm@10.12.1",
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "preview": "turbo run preview",
    "lint": "turbo run lint",
    "type-check": "turbo run type-check"
  },
  "devDependencies": {
    "turbo": "^2.6.0",
    "typescript": "^5.7.3"
  }
}
```

---

## 2. PACKAGE STRUCTURE - RSC-ROUTER (TEMPLATE)

### Location
`/Users/ivotodorov/Development/temp/vite-rsc/packages/rsc-router/`

### Package Configuration
**File**: `/Users/ivotodorov/Development/temp/vite-rsc/packages/rsc-router/package.json`

```json
{
  "name": "rsc-router",
  "version": "0.0.1",
  "license": "MIT",
  "type": "module",
  "main": "./src/index.ts",
  "module": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "files": ["src"],
  "scripts": {
    "type-check": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:e2e:headed": "playwright test --headed",
    "test:e2e:debug": "playwright test --debug",
    "test:e2e:report": "playwright show-report",
    "test:all": "pnpm test && pnpm test:e2e",
    "lint": "eslint src --ext .ts,.tsx",
    "lint:fix": "eslint src --ext .ts,.tsx --fix",
    "format": "prettier --write \"src/**/*.{ts,tsx,json,md}\"",
    "format:check": "prettier --check \"src/**/*.{ts,tsx,json,md}\"",
    "quality": "pnpm type-check && pnpm lint && pnpm format:check && pnpm test:all"
  },
  "peerDependencies": {
    "react": "^18.0.0 || ^19.0.0",
    "react-dom": "^18.0.0 || ^19.0.0"
  },
  "devDependencies": {
    "@eslint/js": "^9.39.1",
    "@playwright/test": "^1.56.1",
    "@types/react": "^19.2.2",
    "@types/react-dom": "^19.2.2",
    "@typescript-eslint/eslint-plugin": "^8.18.1",
    "@typescript-eslint/parser": "^8.18.1",
    "@vitejs/plugin-react": "^4.3.4",
    "@vitejs/plugin-rsc": "latest",
    "@vitest/coverage-v8": "^2.1.8",
    "@vitest/ui": "^2.1.8",
    "eslint": "^9.17.0",
    "eslint-config-prettier": "^9.1.0",
    "eslint-plugin-react": "^7.37.3",
    "eslint-plugin-react-hooks": "^5.1.0",
    "happy-dom": "^15.11.7",
    "playwright": "^1.56.1",
    "prettier": "^3.4.2",
    "rsc-html-stream": "^0.0.7",
    "typescript": "^5.7.3",
    "vite": "^7.1.10",
    "vitest": "^2.1.8"
  }
}
```

### Key Points:
- **No build step**: Uses TypeScript directly (main/module/types all point to src/index.ts)
- **File exports**: Only src/ directory is included in distribution
- **Peer dependencies**: React 18/19 support
- **Comprehensive test setup**: Unit tests + E2E tests
- **Code quality tools**: ESLint, Prettier, TypeScript strict mode

---

## 3. BUILD TOOLS & CONFIGURATION

### TypeScript Configuration

**Base Config** (`/Users/ivotodorov/Development/temp/vite-rsc/tsconfig.base.json`):
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "noEmit": true,
    "isolatedModules": true,
    "allowSyntheticDefaultImports": true
  }
}
```

**Package-specific Config** (`/Users/ivotodorov/Development/temp/vite-rsc/packages/rsc-router/tsconfig.json`):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "jsx": "react-jsx",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "types": ["react", "react-dom"],
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "noUncheckedIndexedAccess": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### NO Build Tools Used
- **NOT using**: tsup, tsdown, esbuild, or rollup
- **Distribution**: Direct source file export (TypeScript files)
- This approach is suitable for:
  - Monorepo internal packages (transpiled by consumer)
  - TypeScript-first projects
  - Direct imports with build tool handling

---

## 4. TEST SETUP

### Unit Tests with Vitest

**Config** (`/Users/ivotodorov/Development/temp/vite-rsc/packages/rsc-router/vitest.config.ts`):
```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./src/__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/__tests__/', '**/*.d.ts', '**/*.config.*', '**/dist/'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
  },
  resolve: {
    alias: { 'rsc-router': '/src/index.ts' },
  },
});
```

**Test Files Location**: `/Users/ivotodorov/Development/temp/vite-rsc/packages/rsc-router/src/__tests__/`
- 34 test files covering:
  - Routing logic (matcher, linear-matcher, router matching)
  - Segment system (segment IDs, reconciliation, rendering)
  - Client navigation and store
  - RSC payload streaming
  - Layout support and arrays
  - Route definition and mounting
  - E2E critical tests

### E2E Tests with Playwright

**Config** (`/Users/ivotodorov/Development/temp/vite-rsc/packages/rsc-router/playwright.config.ts`):
```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: 30000,
  globalTimeout: 60000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'off',
    screenshot: 'off',
    actionTimeout: 10000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    cwd: path.resolve(__dirname, '../../apps/web'),
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30 * 1000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
```

**E2E Tests Location**: `/Users/ivotodorov/Development/temp/vite-rsc/packages/rsc-router/e2e/tests/`
- Tests for: navigation, layouts, dynamic routes, RSC streaming, partial rendering, etc.
- Runs against dev server (`apps/web`)

---

## 5. CODE QUALITY TOOLS

### ESLint Configuration

**File**: `/Users/ivotodorov/Development/temp/vite-rsc/packages/rsc-router/eslint.config.js`

Uses modern ESLint v9 flat config format:
- Base JS recommended rules
- TypeScript-ESLint plugin
- React plugin
- React Hooks plugin
- Prettier integration
- Stricter rules for source files
- Lenient rules for test files

Key rules:
- `@typescript-eslint/no-explicit-any`: warn
- `@typescript-eslint/no-unused-vars`: error (with _ prefix exception)
- React: no prop-types (using TypeScript)
- No console.log in production code
- Prefer const, no var

### Prettier Configuration

**File**: `/Users/ivotodorov/Development/temp/vite-rsc/packages/rsc-router/.prettierrc`:
```json
{
  "semi": true,
  "trailingComma": "es5",
  "singleQuote": true,
  "printWidth": 80,
  "tabWidth": 2,
  "useTabs": false,
  "arrowParens": "always",
  "endOfLine": "lf",
  "bracketSpacing": true,
  "jsxSingleQuote": false,
  "quoteProps": "as-needed"
}
```

---

## 6. SOURCE STRUCTURE

### RSC-Router Source Files
Location: `/Users/ivotodorov/Development/temp/vite-rsc/packages/rsc-router/src/`

```
src/
├── index.ts                    # Main entry point (exports everything)
├── types.ts                    # Core type definitions
├── router.tsx                  # Router component
├── create-router.ts            # Router factory
├── segments.ts                 # Segment utilities
├── segment-system.tsx          # Segment management system
├── matcher.ts                  # Route matching logic
├── linear-matcher.ts           # Linear route matching
├── route-definition.ts         # Route definition system
├── client.ts                   # Client-side utilities
├── server.ts                   # Server-side utilities (minimal)
├── Link.tsx                    # Link component
├── Outlet.tsx                  # Outlet component
├── framework/                  # Framework integration
│   ├── index.ts
│   ├── entry.browser.tsx      # Browser entry point
│   ├── entry.rsc.tsx          # RSC entry point
│   ├── entry.ssr.tsx          # SSR entry point
│   ├── storage.ts
│   ├── types.ts
│   └── utils
└── __tests__/                  # 34 unit test files
    └── setup.ts
```

### Main Entry Point
**File**: `/Users/ivotodorov/Development/temp/vite-rsc/packages/rsc-router/src/index.ts`

Exports:
- Core types and router functionality
- Segment system utilities
- Matcher/linear-matcher
- Route definition
- Client-side helpers (Link, Outlet, SegmentStore)
- Client navigation utilities

---

## 7. PACKAGE CROSS-REFERENCES

### How Packages Reference Each Other

**pnpm workspace protocol**: `workspace:*`

**Example from apps/web**:
```json
{
  "dependencies": {
    "rsc-router": "workspace:*"  // Local reference to packages/rsc-router
  }
}
```

This allows:
- Direct import: `import { Router } from 'rsc-router'`
- pnpm automatically resolves to local package
- No need for npm publish during development

### Dependency Resolution
- pnpm hoists dependencies to root node_modules
- Each package can have its own tsconfig extending base
- Shared devDependencies installed at root level

---

## 8. BUILD ORCHESTRATION WITH TURBO

**File**: `/Users/ivotodorov/Development/temp/vite-rsc/turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {
      "dependsOn": ["^build"]
    },
    "type-check": {
      "dependsOn": ["^build"]
    },
    "preview": {
      "dependsOn": ["build"]
    }
  }
}
```

Key features:
- `^build` means "run build in dependencies first"
- `dev` is persistent and non-cached
- Caching for build output optimization
- Sequential task dependencies

---

## 9. EXAMPLE APPLICATION

### Web App Structure
Location: `/Users/ivotodorov/Development/temp/vite-rsc/apps/web/`

**Package.json**:
```json
{
  "name": "@vite-rsc/web",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "rsc-router": "workspace:*"
  }
}
```

**Source Structure**:
```
apps/web/src/
├── layouts/
├── pages/
├── components/
├── framework/
├── assets/
├── Homepage.tsx
├── MyTestPage.tsx
├── AdvancedRscExample.tsx
├── DynamicRscLoader.tsx
├── client.tsx
├── action.tsx
├── myTestActions.tsx
└── root.action.tsx
```

Uses rsc-router for navigation and routing.

---

## 10. TEMPLATE STRUCTURE FOR NEW PACKAGES

### Recommended Structure for host-router Package

```
packages/host-router/
├── package.json                     # Main package definition
├── tsconfig.json                    # Extends ../../tsconfig.base.json
├── vitest.config.ts                 # Unit test configuration
├── playwright.config.ts             # E2E test configuration
├── eslint.config.js                 # Code quality
├── .prettierrc                       # Code formatting
├── src/
│   ├── index.ts                     # Main entry point (export everything)
│   ├── types.ts                     # Type definitions
│   ├── core.ts                      # Core functionality
│   ├── utils.ts                     # Utility functions
│   ├── components.tsx               # React components (if applicable)
│   ├── __tests__/
│   │   ├── setup.ts
│   │   ├── core.test.ts
│   │   └── ...
│   └── framework/ (if needed)
├── tests/
│   └── e2e/
│       ├── basic.spec.ts
│       └── ...
├── e2e/
│   └── fixtures/
│       └── test-app/
│           └── package.json (test app)
├── examples/                        # Optional example app
│   └── basic/
│       └── package.json
├── .gitignore
├── README.md
└── .turbo/                         # Turbo cache (auto-generated)
```

### Package.json Template

```json
{
  "name": "host-router",
  "version": "0.0.1",
  "license": "MIT",
  "type": "module",
  "main": "./src/index.ts",
  "module": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "files": ["src"],
  "scripts": {
    "type-check": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "playwright test",
    "test:all": "pnpm test && pnpm test:e2e",
    "lint": "eslint src --ext .ts,.tsx",
    "lint:fix": "eslint src --ext .ts,.tsx --fix",
    "format": "prettier --write \"src/**/*.{ts,tsx,json,md}\"",
    "quality": "pnpm type-check && pnpm lint && pnpm test:all"
  },
  "peerDependencies": {
    "react": "^18.0.0 || ^19.0.0",
    "react-dom": "^18.0.0 || ^19.0.0"
  },
  "devDependencies": {
    "@eslint/js": "^9.39.1",
    "@playwright/test": "^1.56.1",
    "@types/react": "^19.2.2",
    "@types/react-dom": "^19.2.2",
    "@typescript-eslint/eslint-plugin": "^8.18.1",
    "@typescript-eslint/parser": "^8.18.1",
    "@vitejs/plugin-react": "^4.3.4",
    "@vitest/coverage-v8": "^2.1.8",
    "@vitest/ui": "^2.1.8",
    "eslint": "^9.17.0",
    "eslint-config-prettier": "^9.1.0",
    "eslint-plugin-react": "^7.37.3",
    "eslint-plugin-react-hooks": "^5.1.0",
    "happy-dom": "^15.11.7",
    "playwright": "^1.56.1",
    "prettier": "^3.4.2",
    "typescript": "^5.7.3",
    "vite": "^7.1.10",
    "vitest": "^2.1.8"
  }
}
```

---

## 11. KEY INSIGHTS FOR host-router PACKAGE

1. **No Build Step Needed**
   - Source TypeScript files are consumed directly
   - Build tools (Vite, etc.) handle transpilation
   - Simpler package.json, no build scripts

2. **Test Strategy**
   - Unit tests with Vitest (happy-dom environment)
   - E2E tests with Playwright against real app
   - 80% coverage thresholds
   - Test fixtures in e2e/fixtures/test-app/

3. **Code Quality**
   - TypeScript strict mode
   - ESLint v9 flat config
   - Prettier for formatting
   - Quality script combines all checks

4. **Workspace Integration**
   - Reference with `workspace:*` in consumer apps
   - pnpm handles local resolution
   - Shared base tsconfig.json

5. **File Distribution**
   - Only `src/` directory included in package
   - Main entry exports everything from index.ts
   - Tree-shakeable exports using named exports

6. **TypeScript Configuration**
   - Extends monorepo base config
   - Strict checks enabled (noUnusedLocals, etc.)
   - React JSX transform enabled
   - Declaration maps for source maps

