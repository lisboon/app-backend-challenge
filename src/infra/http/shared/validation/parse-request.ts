import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

export function parseRequest<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  const problems = result.error.issues.map(
    (issue) => `${issue.path.join('.') || 'corpo'}: ${issue.message}`,
  );
  throw new BadRequestException(problems.join('; '));
}
