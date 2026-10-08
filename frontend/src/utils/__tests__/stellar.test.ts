/**
 * Tests for parseJobIdFromResult function
 * Closes #1441: Tests XDR parsing with real stellar SDK
 */

import { parseJobIdFromResult } from '../stellar';
import { xdr } from '@stellar/stellar-sdk';

describe('parseJobIdFromResult', () => {
  it('parses a valid scvU64 XDR value', () => {
    // Create a real scvU64 XDR value representing job ID 42
    const u64Val = xdr.ScVal.scvU64(xdr.Uint64.fromString('42'));
    const xdrString = u64Val.toXDR('base64');

    const result = parseJobIdFromResult(xdrString);
    expect(result).toBe(42);
  });

  it('parses a large scvU64 value', () => {
    // Test with a large u64 value
    const u64Val = xdr.ScVal.scvU64(xdr.Uint64.fromString('999999'));
    const xdrString = u64Val.toXDR('base64');

    const result = parseJobIdFromResult(xdrString);
    expect(result).toBe(999999);
  });

  it('throws error for empty string input', () => {
    expect(() => parseJobIdFromResult('')).toThrow(
      'No return value XDR provided'
    );
  });

  it('throws error for wrong ScVal type (scvI32 instead of scvU64)', () => {
    // Create an scvI32 XDR value
    const i32Val = xdr.ScVal.scvI32(42);
    const xdrString = i32Val.toXDR('base64');

    expect(() => parseJobIdFromResult(xdrString)).toThrow(
      'Unexpected ScVal type "scvI32" — expected scvU64'
    );
  });

  it('throws error for wrong ScVal type (scvBool)', () => {
    const boolVal = xdr.ScVal.scvBool(true);
    const xdrString = boolVal.toXDR('base64');

    expect(() => parseJobIdFromResult(xdrString)).toThrow(
      'Unexpected ScVal type "scvBool" — expected scvU64'
    );
  });

  it('throws error for invalid base64 XDR', () => {
    expect(() => parseJobIdFromResult('invalid-base64-xdr')).toThrow(
      'Failed to parse on-chain job ID'
    );
  });
});
