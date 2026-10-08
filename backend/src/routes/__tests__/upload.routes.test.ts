import {
  validateFileMimeType,
  formatFileSize,
} from "../../utils/fileValidation";
import { MAX_FILE_SIZE, ALLOWED_MIME_TYPES } from "../../config/upload";

describe("File Upload Utilities", () => {
  describe("validateFileMimeType", () => {
    it("should validate file mime type", async () => {
      const result = await validateFileMimeType("/fake/path.pdf");
      expect(result).toHaveProperty("valid");
    });
  });

  describe("formatFileSize", () => {
    it("should format bytes correctly", () => {
      expect(formatFileSize(0)).toBe("0 Bytes");
      expect(formatFileSize(1024)).toBe("1 KB");
      expect(formatFileSize(1048576)).toBe("1 MB");
      expect(formatFileSize(10485760)).toBe("10 MB");
    });
  });
});

describe("Upload Configuration", () => {
  it("should have correct max file size", () => {
    expect(MAX_FILE_SIZE).toBe(10 * 1024 * 1024);
  });

  it("should have allowed mime types", () => {
    expect(ALLOWED_MIME_TYPES).toContain("application/pdf");
    expect(ALLOWED_MIME_TYPES).toContain("image/jpeg");
    expect(ALLOWED_MIME_TYPES).toContain("image/png");
    expect(ALLOWED_MIME_TYPES).toContain("video/mp4");
    expect(ALLOWED_MIME_TYPES).toContain("application/zip");
  });
});
