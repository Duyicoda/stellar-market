import {
  PORTFOLIO_MAX_FILE_SIZE,
  PORTFOLIO_MAX_ITEMS,
  PORTFOLIO_MIME_TYPES,
  portfolioUpload,
} from "../../config/upload";

describe("Portfolio Upload Configuration", () => {
  it("should have correct max portfolio file size (5MB)", () => {
    expect(PORTFOLIO_MAX_FILE_SIZE).toBe(5 * 1024 * 1024);
  });

  it("should have correct max portfolio items limit", () => {
    expect(PORTFOLIO_MAX_ITEMS).toBe(10);
  });

  it("should allow image MIME types for portfolio", () => {
    expect(PORTFOLIO_MIME_TYPES).toContain("image/jpeg");
    expect(PORTFOLIO_MIME_TYPES).toContain("image/png");
    expect(PORTFOLIO_MIME_TYPES).toContain("image/gif");
    expect(PORTFOLIO_MIME_TYPES).toContain("image/webp");
    expect(PORTFOLIO_MIME_TYPES).toContain("application/pdf");
  });

  it("should not allow disallowed MIME types for portfolio", () => {
    expect(PORTFOLIO_MIME_TYPES).not.toContain("video/mp4");
    expect(PORTFOLIO_MIME_TYPES).not.toContain("application/zip");
  });

  it("should export portfolioUpload multer instance", () => {
    expect(portfolioUpload).toBeDefined();
  });
});
