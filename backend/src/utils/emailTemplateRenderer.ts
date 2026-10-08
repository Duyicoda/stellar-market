import * as fs from "fs";
import * as path from "path";
import * as Handlebars from "handlebars";

const TEMPLATE_DIR = path.join(__dirname, "../templates/email/handlebars");

const TEMPLATE_NAME_RE = /^[A-Za-z0-9_-]+$/;

const ALLOWED_EXTENSION = ".hbs";

export function isValidTemplateName(name: string): boolean {
  if (!name || typeof name !== "string") return false;
  if (!TEMPLATE_NAME_RE.test(name)) return false;
  const basename = name + ALLOWED_EXTENSION;
  const resolved = path.resolve(TEMPLATE_DIR, basename);
  const rel = path.relative(TEMPLATE_DIR, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const normalizedDir = path.resolve(TEMPLATE_DIR);
  if (!resolved.startsWith(normalizedDir + path.sep)) return false;
  return true;
}

let discoveredTemplates: ReadonlyArray<string> | null = null;

export function getAvailableEmailTemplates(): ReadonlyArray<string> {
  if (discoveredTemplates !== null) return discoveredTemplates;
  try {
    const entries = fs.readdirSync(TEMPLATE_DIR, { withFileTypes: true });
    discoveredTemplates = entries
      .filter((e) => e.isFile() && e.name.endsWith(ALLOWED_EXTENSION))
      .map((e) => path.basename(e.name, ALLOWED_EXTENSION))
      .filter((n) => TEMPLATE_NAME_RE.test(n))
      .sort();
  } catch {
    discoveredTemplates = [];
  }
  return discoveredTemplates;
}

const templateCache = new Map<string, Handlebars.TemplateDelegate>();

export function renderEmailTemplate(
  templateName: string,
  data: Record<string, unknown>,
): string {
  if (!isValidTemplateName(templateName)) {
    throw new Error(`Invalid email template name: ${templateName}`);
  }

  const basename = templateName + ALLOWED_EXTENSION;
  const filePath = path.join(TEMPLATE_DIR, basename);
  const resolved = path.resolve(filePath);
  const normalizedDir = path.resolve(TEMPLATE_DIR);
  if (!resolved.startsWith(normalizedDir + path.sep)) {
    throw new Error(`Invalid email template name: ${templateName}`);
  }

  if (!templateCache.has(templateName)) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Email template not found: ${templateName}`);
    }
    const source = fs.readFileSync(filePath, "utf-8");
    templateCache.set(templateName, Handlebars.compile(source));
  }
  const compiled = templateCache.get(templateName)!;
  return compiled(data);
}
