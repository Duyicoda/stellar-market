import { Router, Request, Response } from "express";
import { requireAdmin } from "../../middleware/auth";
import {
  renderEmailTemplate,
  isValidTemplateName,
  getAvailableEmailTemplates,
} from "../../utils/emailTemplateRenderer";

const router = Router();

router.use(requireAdmin);

router.get("/:template", (req: Request, res: Response) => {
  const rawTemplate = Array.isArray(req.params.template)
    ? req.params.template[0]
    : req.params.template;

  if (!isValidTemplateName(rawTemplate)) {
    return res.status(400).json({ error: "Invalid template name" });
  }

  const allowed = new Set(getAvailableEmailTemplates());
  if (!allowed.has(rawTemplate)) {
    return res.status(404).json({ error: "Template not found" });
  }

  let vars: Record<string, unknown> = {};

  try {
    const rawVars = req.query.vars;
    if (rawVars && typeof rawVars === "string") {
      const parsed = JSON.parse(rawVars);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return res.status(400).json({ error: "Invalid vars JSON" });
      }
      vars = parsed;
    }
  } catch {
    return res.status(400).json({ error: "Invalid vars JSON" });
  }

  try {
    const html = renderEmailTemplate(rawTemplate, vars);
    res.setHeader("Content-Type", "text/html");
    return res.send(html);
  } catch (err) {
    return res.status(404).json({
      error: err instanceof Error ? err.message : "Template not found",
    });
  }
});

export default router;
