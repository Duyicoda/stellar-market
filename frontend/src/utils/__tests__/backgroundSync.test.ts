/**
 * Tests for shouldQueueAction
 * Covers #1440: offline detection is a pure wrapper around navigator.onLine
 */

import { shouldQueueAction } from '../backgroundSync';

describe('shouldQueueAction', () => {
  const originalOnLine = navigator.onLine;

  afterEach(() => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: originalOnLine,
    });
  });

  it('returns true when the browser reports being offline', () => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: false,
    });

    expect(shouldQueueAction()).toBe(true);
  });

  it('returns false when the browser reports being online', () => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: true,
    });

    expect(shouldQueueAction()).toBe(false);
  });
});
