import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";

export const validate = (schema: {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      // Validate request body — strip unknown fields by default (zod uses .strip() behavior)
      if (schema.body) {
        req.body = schema.body.parse(req.body);
      }

      // Validate query parameters. Zod may coerce values to non-string types
      // (numbers, booleans), which don't fit Express's string-based ParsedQs
      // type — route handlers read the coerced shape back out via their own
      // z.infer<...> casts.
      if (schema.query) {
        req.query = schema.query.parse(req.query) as unknown as typeof req.query;
      }

      // Validate route parameters
      if (schema.params) {
        req.params = schema.params.parse(req.params) as unknown as typeof req.params;
      }

      next();
    } catch (error) {
      if (error instanceof ZodError) {
        // Special-case: budget below platform minimum → 422 with dedicated code
        const budgetMinimumError = error.issues.find(
          (issue) =>
            issue.path.length === 1 &&
            issue.path[0] === "budget" &&
            issue.message.startsWith("Budget must be at least "),
        );
        if (budgetMinimumError) {
          res.status(422).json({
            code: "BudgetBelowMinimum",
            message: budgetMinimumError.message,
          });
          return;
        }

        // Standard validation error: return structured {errors: [{field, message}]} array
        const errors = error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        }));

        res.status(400).json({
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          error: "Validation failed",
          errors,
        });
        return;
      }
      next(error);
    }
  };
};
