import { describe, it, expect } from 'vitest';
import { defineHosts } from '../utils';

describe('defineHosts', () => {
  it('should create type-safe host definitions', () => {
    const hosts = defineHosts({
      admin: 'admin.*',
      api: 'api.*',
      app: ['.', 'www.*'],
    });

    expect(hosts.admin).toBe('admin.*');
    expect(hosts.api).toBe('api.*');
    expect(hosts.app).toEqual(['.', 'www.*']);
  });

  it('should freeze the returned object', () => {
    const hosts = defineHosts({
      admin: 'admin.*',
    });

    expect(Object.isFrozen(hosts)).toBe(true);
    expect(() => {
      (hosts as any).admin = 'modified';
    }).toThrow();
  });

  it('should work with empty object', () => {
    const hosts = defineHosts({});

    expect(hosts).toEqual({});
    expect(Object.isFrozen(hosts)).toBe(true);
  });
});
