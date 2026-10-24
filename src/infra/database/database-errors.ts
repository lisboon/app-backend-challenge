const CONNECTION_CODES = new Set([
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
  '57P01',
  '57P02',
  '57P03',
]);

const CONNECTION_MESSAGES = [
  /timeout exceeded when trying to connect/i,
  /connection terminated/i,
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

export function isConnectionFailure(error: unknown): boolean {
  return layers(error).some(
    (layer) =>
      (typeof layer.code === 'string' && CONNECTION_CODES.has(layer.code)) ||
      (typeof layer.message === 'string' &&
        CONNECTION_MESSAGES.some((pattern) =>
          pattern.test(layer.message as string),
        )),
  );
}
