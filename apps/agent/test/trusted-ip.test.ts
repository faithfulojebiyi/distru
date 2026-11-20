/** Which client-IP header Better Auth trusts (TRUSTED_IP_HEADER): none by default in production. */
import { describe, expect, test } from 'bun:test';
import { trustedIpHeaders } from '../src/env';

describe('trustedIpHeaders', () => {
  test('outside production the old default stays (x-forwarded-for, x-real-ip)', () => {
    expect(trustedIpHeaders('development', undefined)).toEqual(['x-forwarded-for', 'x-real-ip']);
    expect(trustedIpHeaders('test', undefined)).toEqual(['x-forwarded-for', 'x-real-ip']);
  });

  test('production trusts nothing unless configured', () => {
    expect(trustedIpHeaders('production', undefined)).toEqual([]);
    expect(trustedIpHeaders('production', 'fly-client-ip')).toEqual(['fly-client-ip']);
    // Behind our own proxy, which sets x-forwarded-for from the platform header.
    expect(trustedIpHeaders('production', 'x-forwarded-for')).toEqual(['x-forwarded-for']);
  });

  test('`none` (or empty) disables it everywhere', () => {
    expect(trustedIpHeaders('development', 'none')).toEqual([]);
    expect(trustedIpHeaders('production', '')).toEqual([]);
  });
});
