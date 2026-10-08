import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from "../errors/AppError";
import { ErrorCodes } from "../errors/codes";
import { logger } from "../lib/logger";

export interface ApiError extends Error {
  statusCode?: number;
  details?: unknown;
  code?: string;
}

export const errorHandler = (
  err: ApiError,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  let code: string = ErrorCodes.INTERNAL_ERROR;
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal Server Error';
  let details: unknown = err.details;

  if (err instanceof AppError) {
    code = err.code;
    statusCode = err.statusCode;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    code = ErrorCodes.VALIDATION_ERROR;
    statusCode = 400;
    message = 'Validation failed';
    details = err.issues.map(issue => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
  } else if (err.name === 'PrismaClientKnownRequestError') {
    const prismaErr = err as unknown as { code?: string; meta?: { target?: unknown } };
    code = ErrorCodes.DATABASE_ERROR;
    statusCode = 400;
    message = 'Database operation failed';
    details = {
      prismaCode: prismaErr.code,
      target: prismaErr.meta?.target,
    };
  } else if (err.name === 'ContractSimulationError') {
    code = ErrorCodes.CONTRACT_SIMULATION_ERROR;
    statusCode = 422;
    message = err.message;
  } else if (err.name === 'JsonWebTokenError') {
    code = ErrorCodes.INVALID_TOKEN;
    statusCode = 401;
    message = 'Invalid token';
  } else if (err.name === 'TokenExpiredError') {
    code = ErrorCodes.TOKEN_EXPIRED;
    statusCode = 401;
    message = 'Token expired';
  } else if ((err as unknown as { type?: string }).type === 'entity.too.large') {
    code = ErrorCodes.PAYLOAD_TOO_LARGE;
    statusCode = 413;
    message = 'Request body is too large. Maximum size is 1MB.';
  } else if (err.name === 'MulterError') {
    code = ErrorCodes.FILE_UPLOAD_FAILED;
    statusCode = 400;
    const multerErr = err as unknown as { code?: string, field?: string };
    const multerCode = multerErr.code;
    const isAvatarRoute = req.originalUrl.includes('/avatar');

    if (multerCode === 'LIMIT_FILE_SIZE') {
      code = ErrorCodes.FILE_TOO_LARGE;
      if (isAvatarRoute) {
        message = 'File too large. Avatar must be at most 2MB.';
      } else {
        message = `File too large for field '${multerErr.field || 'unknown'}'.`;
      }
    } else if (multerCode === 'LIMIT_UNEXPECTED_FILE') {
      code = ErrorCodes.UNEXPECTED_FIELD;
      if (isAvatarRoute) {
        message = "Unexpected field. Use 'avatar' for the file.";
      } else {
        message = `Unexpected field '${multerErr.field || 'unknown'}'.`;
      }
    } else {
      message = 'File upload failed.';
    }
  }

  logger.error(
    {
      err,
      errorCode: code,
      requestId: req.requestId,
      url: req.url,
      method: req.method,
      ip: req.ip,
    },
    "Request error",
  );

  if (statusCode === 503) {
    res.setHeader("Retry-After", "30");
  }

  // Validation errors surface the issues as a top-level `errors` array
  // matching the {errors: [{field, message}]} contract expected by clients.
  if (code === ErrorCodes.VALIDATION_ERROR && Array.isArray(details)) {
    res.status(statusCode).json({
      code,
      message,
      requestId: req.requestId,
      errors: details,
    });
    return;
  }

  res.status(statusCode).json({
    code,
    message,
    error: message,
    requestId: req.requestId,
    ...(details ? { details } : {}),
  });
};

export const createError = (message: string, statusCode: number = 500, details?: unknown): ApiError => {
  const error = new Error(message) as ApiError;
  error.statusCode = statusCode;
  error.details = details;
  return error;
};

export const asyncHandler =
  <Req extends Request = Request>(
    fn: (req: Req, res: Response, next: NextFunction) => unknown,
  ) =>
  (req: Req, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
