/**
 * Global test setup file for vitest
 * This runs before all tests
 */

// Add any global test utilities or mocks here
global.fetch = global.fetch || (() => Promise.resolve(new Response()));

// Console setup - you can silence or spy on console methods if needed
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

// Optionally silence console during tests (uncomment if needed)
// console.log = jest.fn();
// console.warn = jest.fn();
// console.error = jest.fn();

// Export utilities that might be useful across tests
export { originalConsoleLog, originalConsoleWarn, originalConsoleError };
