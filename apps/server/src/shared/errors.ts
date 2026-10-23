import type { ErrorCode } from '@noidle/auto-resume-contracts';

/** 业务错误：路由层统一转成 { error: { code, message, requestId } }（设计书 §9.4）。 */
export class BizError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly httpStatus = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'BizError';
  }
}

export const notFound = (message = '资源不存在'): BizError =>
  new BizError('NOT_FOUND', message, 404);

export const validationError = (message: string, details?: unknown): BizError =>
  new BizError('VALIDATION_ERROR', message, 400, details);
