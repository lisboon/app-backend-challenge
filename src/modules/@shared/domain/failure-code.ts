export const FailureCode = {
  REQUEST_INVALID: 'REQUEST_INVALID',
  MONEY_INVALID_FORMAT: 'MONEY_INVALID_FORMAT',
  CURRENCY_INVALID: 'CURRENCY_INVALID',

  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',

  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  MONEY_OUT_OF_RANGE: 'MONEY_OUT_OF_RANGE',

  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

export const FailureKind = {
  CONTRACT: 'CONTRACT',
  NOT_FOUND: 'NOT_FOUND',
  BUSINESS: 'BUSINESS',
  INTERNAL: 'INTERNAL',
} as const;

export type FailureKind = (typeof FailureKind)[keyof typeof FailureKind];

const KIND_BY_CODE: Readonly<Record<FailureCode, FailureKind>> = {
  [FailureCode.REQUEST_INVALID]: FailureKind.CONTRACT,
  [FailureCode.MONEY_INVALID_FORMAT]: FailureKind.CONTRACT,
  [FailureCode.CURRENCY_INVALID]: FailureKind.CONTRACT,

  [FailureCode.RESOURCE_NOT_FOUND]: FailureKind.NOT_FOUND,

  [FailureCode.CURRENCY_MISMATCH]: FailureKind.BUSINESS,
  [FailureCode.MONEY_OUT_OF_RANGE]: FailureKind.BUSINESS,

  [FailureCode.INTERNAL_ERROR]: FailureKind.INTERNAL,
};

export function failureKindOf(code: FailureCode): FailureKind {
  return KIND_BY_CODE[code];
}
