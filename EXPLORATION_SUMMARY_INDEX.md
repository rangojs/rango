# Monorepo Exploration - Documentation Index

This directory contains comprehensive documentation about the monorepo structure, designed to guide the creation of the new `host-router` package.

## Documents

### 1. MONOREPO_EXPLORATION.md
**Comprehensive Overview (11 major sections)**

Complete analysis of the monorepo structure covering:
- Monorepo organization (pnpm workspaces, Turbo)
- rsc-router package structure (template for host-router)
- Build tools & configuration (no build step, TypeScript-only)
- Test setup (Vitest + Playwright)
- Code quality tools (ESLint v9, Prettier)
- Source structure (18 main files + 34 tests)
- Package cross-references (workspace:* protocol)
- Build orchestration with Turbo
- Example application (apps/web)
- Template structure for new packages
- Key insights for host-router

**Read this for**: Deep understanding of the entire ecosystem

---

### 2. DEPENDENCY_STRUCTURE_GUIDE.md
**Visual Reference Guide (10 detailed diagrams)**

Detailed diagrams and visual references including:
- Directory tree with file counts
- Dependency flow diagram
- Package.json key patterns (root, library, app)
- Build pipeline & task dependencies (Turbo execution order)
- TypeScript configuration hierarchy
- Test configuration hierarchy (Vitest + Playwright)
- File distribution strategy
- Code quality configuration stack
- Source file organization pattern
- Workspace resolution process
- Key patterns checklist

**Read this for**: Visual understanding and quick reference

---

### 3. HOST_ROUTER_SETUP_CHECKLIST.md
**Implementation Checklist (8 phases, 60+ items)**

Step-by-step checklist for creating host-router package:
- Phase 1: Directory Structure (10 items)
- Phase 2: Configuration Files (18 items)
- Phase 3: Source Code (7 items)
- Phase 4: Tests (15 items)
- Phase 5: Documentation (2 items)
- Phase 6: Integration with Monorepo (4 items)
- Phase 7: Verification & Testing (8 items)
- Phase 8: CI/CD Setup (3 items)
- Template package.json (fully populated)
- Key files from rsc-router to copy/adapt
- Important notes

**Read this for**: Creating the host-router package

---

## Quick Start: Creating host-router

### Step 1: Understand the Structure
1. Read **MONOREPO_EXPLORATION.md** sections 1-7 (organization, packages, tools)

### Step 2: Visualize the Architecture
1. Review **DEPENDENCY_STRUCTURE_GUIDE.md**
2. Focus on "Directory Tree with File Counts" and "Package.json Key Patterns"

### Step 3: Set Up the Package
1. Use **HOST_ROUTER_SETUP_CHECKLIST.md** Phase 1-2
2. Copy configuration files from rsc-router
3. Create directory structure

### Step 4: Implement Functionality
1. Follow **HOST_ROUTER_SETUP_CHECKLIST.md** Phase 3
2. Create src/index.ts, types.ts, core.ts, etc.
3. Reference rsc-router source code for patterns

### Step 5: Add Tests
1. Follow **HOST_ROUTER_SETUP_CHECKLIST.md** Phase 4
2. Create unit tests in src/__tests__/
3. Create E2E tests in tests/e2e/

### Step 6: Integrate & Verify
1. Follow **HOST_ROUTER_SETUP_CHECKLIST.md** Phase 6-7
2. Add to apps/web package.json
3. Run quality checks

---

## Key Findings

### 1. No Build Step Required
- TypeScript files are consumed directly by build tools
- package.json points main/module/types to src/index.ts
- Consumer's build tool (Vite) handles transpilation
- Simpler than traditional bundling approaches

### 2. pnpm Workspaces
- Three-level resolution: workspace > base config > npm
- Use `workspace:*` protocol for local packages
- Automatic hoisting to root node_modules
- Each package can extend shared tsconfig.base.json

### 3. Turbo Orchestration
- All monorepo tasks configured centrally in turbo.json
- Task dependencies with `^` (dependencies-first)
- Caching for build outputs
- Persistent tasks for dev mode

### 4. Test Architecture
- **Unit Tests**: Vitest + happy-dom (virtual DOM)
- **E2E Tests**: Playwright (real browser)
- 80% coverage thresholds across all metrics
- Tests colocated with source in __tests__/ directories

### 5. Code Quality Standards
- ESLint v9 flat config format (modern)
- Strict TypeScript compilation
- Prettier for consistent formatting
- `quality` script combines all checks

### 6. Package Distribution
- Only src/ directory included via "files": ["src"]
- Barrel exports through index.ts control public API
- Tree-shakeable with named exports
- No dist/ directory needed (source = distribution)

---

## File Structure Reference

```
Documentation Files:
├── MONOREPO_EXPLORATION.md (THIS DOCUMENT)
├── DEPENDENCY_STRUCTURE_GUIDE.md
└── HOST_ROUTER_SETUP_CHECKLIST.md

Existing Template:
packages/rsc-router/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── playwright.config.ts
├── eslint.config.js
├── .prettierrc
└── src/
    ├── index.ts (copy pattern)
    ├── types.ts (copy pattern)
    ├── __tests__/setup.ts (copy pattern)
    └── ... (19 more files as reference)

Future Target:
packages/host-router/
├── package.json (use template from checklist)
├── tsconfig.json (copy from rsc-router)
├── vitest.config.ts (copy and adapt)
├── playwright.config.ts (copy and adapt)
├── eslint.config.js (copy and review)
├── .prettierrc (copy from rsc-router)
└── src/
    ├── index.ts (implement with similar pattern)
    ├── types.ts
    ├── core.ts (or domain-specific files)
    ├── utils.ts
    └── __tests__/
        ├── setup.ts
        ├── core.test.ts
        └── ...

Consumer Update:
apps/web/
└── package.json
    └── dependencies.host-router = "workspace:*"
```

---

## Configuration Files to Copy from rsc-router

### Direct Copy (No Changes)
1. `tsconfig.json` - Extends base config, no customization needed
2. `.prettierrc` - Formatting rules are standard
3. `src/__tests__/setup.ts` - Global test setup

### Copy and Review
1. `eslint.config.js` - May need rule adjustments
2. `vitest.config.ts` - Update imports/aliases if needed
3. `playwright.config.ts` - Update webServer path if needed

### Use as Template
1. `package.json` - Update name, adjust dependencies as needed

---

## TypeScript Configuration

### Base Config (Shared)
```
tsconfig.base.json
├── ES2020 target
├── ESNext modules
├── Strict mode enabled
├── React JSX transform
└── Bundler module resolution
```

### Package-Specific (host-router)
```
tsconfig.json
├── Extends base
├── Declaration files + maps
├── Strict additional options
│   ├── noUnusedLocals
│   ├── noUnusedParameters
│   ├── noFallthroughCasesInSwitch
│   └── noImplicitReturns
└── Source: src/**, Exclude: node_modules, dist
```

---

## Test Coverage Goals

### Unit Tests (Vitest)
- Target: 80% coverage minimum
- Location: src/__tests__/
- Environment: happy-dom (virtual DOM)
- Metrics: lines, functions, branches, statements

### E2E Tests (Playwright)
- Location: tests/e2e/
- Target: Critical paths and integrations
- Browser: Chromium
- Server: Dev server (apps/web)

---

## Important Notes

1. **No Build Script Needed**
   - `type-check` only validates TypeScript
   - No transpilation in package.json scripts
   - Consumer's build tool handles everything

2. **Strict TypeScript**
   - `strict: true` in base config
   - Additional strict checks in package tsconfig
   - No `any` types (warnings only)

3. **Workspace Protocol**
   - Use `"host-router": "workspace:*"` in consumers
   - pnpm automatically resolves to local package
   - No version constraints needed

4. **Test Colocations**
   - Unit tests in `src/__tests__/`
   - E2E tests in `tests/e2e/`
   - Keep tests close to code

5. **Code Quality Required**
   - Always run `pnpm quality` before commits
   - Combines: type-check, lint, format, test
   - Part of monorepo culture

---

## Next Steps

1. **Read Documentation**
   - Start with MONOREPO_EXPLORATION.md (sections 1-5)
   - Review DEPENDENCY_STRUCTURE_GUIDE.md for visuals
   - Skim HOST_ROUTER_SETUP_CHECKLIST.md for overview

2. **Examine rsc-router**
   - Review package.json structure
   - Check configuration files
   - Study index.ts pattern
   - Look at test setup

3. **Create host-router Package**
   - Follow HOST_ROUTER_SETUP_CHECKLIST.md step by step
   - Copy appropriate files from rsc-router
   - Adapt configurations as needed
   - Implement functionality

4. **Test & Integrate**
   - Write unit tests (80% coverage)
   - Write E2E tests against apps/web
   - Add to apps/web dependencies
   - Run all quality checks

---

## Questions to Answer Before Starting

1. What is the core functionality of host-router?
2. Does it need React components or just utilities?
3. Are there specific types/interfaces to define?
4. What are the critical E2E test scenarios?
5. Are there any special integration needs with rsc-router?
6. What documentation/examples are needed?

---

## Version Information

- **Node.js/pnpm**: pnpm@10.12.1 (see root package.json)
- **TypeScript**: ^5.7.3
- **React**: ^18.0.0 || ^19.0.0
- **Vite**: ^7.1.10
- **Vitest**: ^2.1.8
- **Playwright**: ^1.56.1
- **ESLint**: v9.17.0 (modern flat config)

---

## Summary

These three documents provide:
1. **Complete reference** of monorepo structure
2. **Visual guides** for understanding dependencies and configs
3. **Actionable checklist** for implementing host-router

Use them together as a comprehensive guide for creating the new package following established patterns and best practices.

