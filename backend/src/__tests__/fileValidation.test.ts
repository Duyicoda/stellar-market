/**
 * Additional tests for fileValidation utility functions
 * Closes #1437: Tests formatFileSize and getExtensionFromMimeType
 */

import { formatFileSize, getExtensionFromMimeType } from '../utils/fileValidation';

describe('formatFileSize', () => {
  it('formats 0 bytes correctly', () => {
    expect(formatFileSize(0)).toBe('0 Bytes');
  });

  it('formats bytes under 1 KB', () => {
    expect(formatFileSize(500)).toBe('500 Bytes');
  });

  it('formats exactly 1023 bytes (boundary before KB)', () => {
    expect(formatFileSize(1023)).toBe('1023 Bytes');
  });

  it('formats exactly 1024 bytes (1 KB boundary)', () => {
    expect(formatFileSize(1024)).toBe('1 KB');
  });

  it('formats KB correctly', () => {
    expect(formatFileSize(2048)).toBe('2 KB');
  });

  it('formats exactly 1 MB boundary (1024 * 1024)', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1 MB');
  });

  it('formats MB correctly', () => {
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5 MB');
  });

  it('formats exactly 1 GB boundary (1024 * 1024 * 1024)', () => {
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1 GB');
  });

  it('formats GB correctly', () => {
    expect(formatFileSize(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });

  it('handles fractional values with proper rounding', () => {
    // 1.5 MB
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });
});

describe('getExtensionFromMimeType', () => {
  it('returns .pdf for application/pdf', () => {
    expect(getExtensionFromMimeType('application/pdf')).toBe('.pdf');
  });

  it('returns .jpg for image/jpeg', () => {
    expect(getExtensionFromMimeType('image/jpeg')).toBe('.jpg');
  });

  it('returns .png for image/png', () => {
    expect(getExtensionFromMimeType('image/png')).toBe('.png');
  });

  it('returns .mp4 for video/mp4', () => {
    expect(getExtensionFromMimeType('video/mp4')).toBe('.mp4');
  });

  it('returns .zip for application/zip', () => {
    expect(getExtensionFromMimeType('application/zip')).toBe('.zip');
  });

  it('returns .zip for application/x-zip-compressed', () => {
    expect(getExtensionFromMimeType('application/x-zip-compressed')).toBe('.zip');
  });

  it('returns .docx for Word document MIME type', () => {
    expect(
      getExtensionFromMimeType(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      )
    ).toBe('.docx');
  });

  it('returns empty string for unknown MIME type', () => {
    expect(getExtensionFromMimeType('application/unknown')).toBe('');
  });

  it('returns empty string for text/plain', () => {
    expect(getExtensionFromMimeType('text/plain')).toBe('');
  });
});
