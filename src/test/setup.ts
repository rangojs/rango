import { expect, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom';

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  // Optionally silence console.log during tests
  // log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
};

afterEach(() => {
  vi.clearAllMocks();
});