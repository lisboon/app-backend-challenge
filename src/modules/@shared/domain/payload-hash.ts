import { createHash } from 'node:crypto';

type CanonicalValue =
  | string
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

const VERSION = 'v1';

const isList = (value: CanonicalValue): value is readonly CanonicalValue[] =>
  Array.isArray(value);

export function canonicalJson(value: CanonicalValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (isList(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const fields = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`);
  return `{${fields.join(',')}}`;
}

export function payloadHash(value: CanonicalValue): string {
  const digest = createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex');
  return `${VERSION}:${digest}`;
}
