const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '25P03',
  '57P01',
  '57P02',
  '57P03',
  '55P03',
  '40001',
  '40P01',
]);

const CONNECTION_MESSAGES = [
  /timeout exceeded when trying to connect/i,
  /connection terminated/i,
  /is not queryable/i,
];

interface DriverErrorShape {
  code?: unknown;
  constraint?: unknown;
  message?: unknown;
  cause?: unknown;
}

function layers(error: unknown): DriverErrorShape[] {
  const found: DriverErrorShape[] = [];
  let current: unknown = error;
  while (current !== null && typeof current === 'object' && found.length < 5) {
    found.push(current as DriverErrorShape);
    current = (current as DriverErrorShape).cause;
  }
  return found;
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return layers(error).some(
    (layer) => layer.code === '23505' && layer.constraint === constraint,
  );
}

export function isTransientFailure(error: unknown): boolean {
  return layers(error).some(
    (layer) =>
      (typeof layer.code === 'string' && TRANSIENT_CODES.has(layer.code)) ||
      (typeof layer.message === 'string' &&
        CONNECTION_MESSAGES.some((pattern) =>
          pattern.test(layer.message as string),
        )),
  );
}

export type LockConflictReason = 'lock_timeout' | 'deadlock' | 'serialization';

const LOCK_CONFLICTS: Readonly<Record<string, LockConflictReason>> = {
  '55P03': 'lock_timeout',
  '40P01': 'deadlock',
  '40001': 'serialization',
};

export function lockConflictReason(
  error: unknown,
): LockConflictReason | undefined {
  for (const layer of layers(error)) {
    if (typeof layer.code === 'string' && layer.code in LOCK_CONFLICTS) {
      return LOCK_CONFLICTS[layer.code];
    }
  }
  return undefined;
}
