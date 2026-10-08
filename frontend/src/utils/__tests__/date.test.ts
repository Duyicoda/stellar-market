/**
 * Tests for formatRelativeTime function
 * Closes #1439: Tests all branch boundaries with fake timers
 */

import { formatRelativeTime } from '../date';

describe('formatRelativeTime', () => {
  beforeEach(() => {
    // Mock current time to 2024-01-01 12:00:00
    jest.useFakeTimers().setSystemTime(new Date('2024-01-01T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns "just now" for times under 60 seconds', () => {
    // 30 seconds ago
    const date = new Date('2024-01-01T11:59:30Z').toISOString();
    expect(formatRelativeTime(date)).toBe('just now');
  });

  it('returns "just now" at exact 59 seconds boundary', () => {
    const date = new Date('2024-01-01T11:59:01Z').toISOString();
    expect(formatRelativeTime(date)).toBe('just now');
  });

  it('returns minutes for times under 60 minutes', () => {
    // 30 minutes ago
    const date = new Date('2024-01-01T11:30:00Z').toISOString();
    expect(formatRelativeTime(date)).toBe('30m ago');
  });

  it('returns "1m ago" at 60 seconds boundary', () => {
    const date = new Date('2024-01-01T11:59:00Z').toISOString();
    expect(formatRelativeTime(date)).toBe('1m ago');
  });

  it('returns "59m ago" at 59 minutes boundary', () => {
    const date = new Date('2024-01-01T11:01:00Z').toISOString();
    expect(formatRelativeTime(date)).toBe('59m ago');
  });

  it('returns hours for times under 24 hours', () => {
    // 12 hours ago
    const date = new Date('2024-01-01T00:00:00Z').toISOString();
    expect(formatRelativeTime(date)).toBe('12h ago');
  });

  it('returns "1h ago" at 60 minutes boundary', () => {
    const date = new Date('2024-01-01T11:00:00Z').toISOString();
    expect(formatRelativeTime(date)).toBe('1h ago');
  });

  it('returns "23h ago" at 23 hours boundary', () => {
    const date = new Date('2023-12-31T13:00:00Z').toISOString();
    expect(formatRelativeTime(date)).toBe('23h ago');
  });

  it('returns days for times under 7 days', () => {
    // 3 days ago
    const date = new Date('2023-12-29T12:00:00Z').toISOString();
    expect(formatRelativeTime(date)).toBe('3d ago');
  });

  it('returns "1d ago" at 24 hours boundary', () => {
    const date = new Date('2023-12-31T12:00:00Z').toISOString();
    expect(formatRelativeTime(date)).toBe('1d ago');
  });

  it('returns "6d ago" at 6 days boundary', () => {
    const date = new Date('2023-12-26T12:00:00Z').toISOString();
    expect(formatRelativeTime(date)).toBe('6d ago');
  });

  it('returns formatted date for times 7+ days ago', () => {
    // 10 days ago
    const date = new Date('2023-12-22T12:00:00Z').toISOString();
    const formatted = formatRelativeTime(date);
    expect(formatted).toMatch(/12\/22\/2023/); // Locale-dependent format
  });
});
