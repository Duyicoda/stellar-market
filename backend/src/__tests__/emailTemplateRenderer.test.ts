/**
 * Direct unit tests for `isValidTemplateName` (issue #1438).
 *
 * This guard is the security boundary that prevents email-template path
 * traversal. It is intentionally tested against the pure function so a future
 * edit to the allowlist regex or the containment check is caught immediately,
 * independent of Express/file-system behaviour.
 */
import {
  getAvailableEmailTemplates,
  isValidTemplateName,
  renderEmailTemplate,
} from "../utils/emailTemplateRenderer";

describe("isValidTemplateName (#1438)", () => {
  const VALID_NAMES = [
    "welcome",
    "verify_email",
    "reset-password",
    "Template123",
    "notificationV2",
    "A",
    "_",
    "-",
    "a-b_c",
    "x".repeat(200),
  ];

  it.each(VALID_NAMES)("accepts valid template name %p", (name) => {
    expect(isValidTemplateName(name)).toBe(true);
  });

  // Every entry is rejected by the allowlist regex `^[A-Za-z0-9_-]+$` and/or
  // the containment check.
  const INVALID_NAMES = [
    "",
    " ",
    "  ",
    ".",
    "..",
    "...",
    "../package.json",
    "../../etc/passwd",
    "foo/bar",
    "foo\\bar",
    "foo.hbs",
    "foo bar",
    "foo%2fbar",
    "foo%5cbar",
    "foo;bar",
    "foo$bar",
    "foo*",
    "foo?",
    "foo|bar",
    "foo:bar",
    'foo"bar',
    "foo'bar",
    "foo<bar>",
    "foo(1)",
    "foo[0]",
    "foo\x00bar",
    "welcome\n",
    "welcome\t",
    "/etc/passwd",
    "/welcome",
    "C:\\Windows\\win.ini",
    "\\\\server\\share\\template",
    "..\\..\\secret",
    "....//welcome",
    "%2e%2e%2fwelcome",
    "template/..",
    "template ",
    " template",
    "café",
    "темплейт",
    "🔒",
  ];

  it.each(INVALID_NAMES)("rejects invalid template name %p", (name) => {
    expect(isValidTemplateName(name)).toBe(false);
  });

  describe("path traversal", () => {
    const TRAVERSAL_ATTEMPTS = [
      "../package.json",
      "../../etc/passwd",
      "../templates/email/handlebars/welcome",
      "welcome/../../secret",
      "..\\..\\windows\\win.ini",
      "....//welcome",
      "%2e%2e%2fpackage.json",
    ];

    it.each(TRAVERSAL_ATTEMPTS)("rejects traversal attempt %p", (attempt) => {
      expect(isValidTemplateName(attempt)).toBe(false);
    });
  });

  describe("absolute paths", () => {
    const ABSOLUTE_PATHS = [
      "/etc/passwd",
      "/welcome",
      "/tmp/welcome",
      "C:\\Windows\\win.ini",
      "C:/Windows/win.ini",
      "\\\\server\\share\\welcome",
    ];

    it.each(ABSOLUTE_PATHS)("rejects absolute path %p", (path) => {
      expect(isValidTemplateName(path)).toBe(false);
    });
  });

  describe("empty and non-string input", () => {
    const NON_STRING_INPUTS: unknown[] = [
      null,
      undefined,
      0,
      123,
      1.5,
      -1,
      true,
      false,
      {},
      [],
      ["welcome"],
      Symbol("welcome"),
      10n,
      () => "welcome",
    ];

    it.each(NON_STRING_INPUTS)("rejects non-string input %p", (value) => {
      expect(isValidTemplateName(value as unknown as string)).toBe(false);
    });
  });
});

describe("renderEmailTemplate input validation (#1438)", () => {
  it.each(["../package.json", "foo/bar", "", "/etc/passwd", "welcome.hbs"])(
    "throws for rejected template name %p",
    (name) => {
      expect(() => renderEmailTemplate(name, {})).toThrow(/Invalid email template name/);
    },
  );
});

describe("getAvailableEmailTemplates (#1438)", () => {
  it("only returns names accepted by isValidTemplateName", () => {
    const templates = getAvailableEmailTemplates();

    expect(Array.isArray(templates)).toBe(true);
    for (const template of templates) {
      expect(isValidTemplateName(template)).toBe(true);
      expect(template).not.toMatch(/\.hbs$/);
    }
  });
});
