import { passwordSchema } from "../common";
import { loginSchema, changePasswordSchema } from "../auth";

describe("Password Max Length Validation (Issue #930)", () => {
  const valid8Char = "Password123";
  const valid128Char = "A".repeat(100) + "a".repeat(20) + "12345678";
  const invalid129Char = "A".repeat(100) + "a".repeat(20) + "123456789";

  describe("passwordSchema", () => {
    it("accepts valid passwords up to 128 characters", () => {
      expect(passwordSchema.safeParse(valid8Char).success).toBe(true);
      expect(passwordSchema.safeParse(valid128Char).success).toBe(true);
    });

    it("rejects passwords exceeding 128 characters", () => {
      const result = passwordSchema.safeParse(invalid129Char);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/128 characters/i);
      }
    });
  });

  describe("loginSchema", () => {
    it("accepts valid login credentials with password <= 128 chars", () => {
      const result = loginSchema.safeParse({
        email: "user@example.com",
        password: valid128Char,
      });
      expect(result.success).toBe(true);
    });

    it("rejects login with password > 128 chars", () => {
      const result = loginSchema.safeParse({
        email: "user@example.com",
        password: invalid129Char,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toMatch(/128 characters/i);
      }
    });
  });

  describe("changePasswordSchema", () => {
    it("rejects currentPassword exceeding 128 characters", () => {
      const result = changePasswordSchema.safeParse({
        currentPassword: invalid129Char,
        newPassword: valid8Char,
      });
      expect(result.success).toBe(false);
    });
  });
});
