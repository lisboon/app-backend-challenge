export function publicationErrorCode(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'UnknownError';
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,64}$/.test(code)
    ? code
    : error.constructor.name;
}
