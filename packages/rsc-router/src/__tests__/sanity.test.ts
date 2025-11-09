/**
 * Sanity test to verify the test infrastructure is working
 */

import { describe, it, expect } from 'vitest';

describe('Test Infrastructure', () => {
  it('should run tests successfully', () => {
    expect(true).toBe(true);
  });

  it('should support async tests', async () => {
    const result = await Promise.resolve(42);
    expect(result).toBe(42);
  });

  it('should have access to TypeScript types', () => {
    const num: number = 42;
    const str: string = 'hello';

    expect(typeof num).toBe('number');
    expect(typeof str).toBe('string');
  });
});
