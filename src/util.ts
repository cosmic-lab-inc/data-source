import { range } from 'lodash';

export function optionalToArray<T>(value: T | null | undefined): T[] {
  if (value === null || value === undefined) {
    return [];
  } else {
    return [value];
  }
}

export type ExtractArrayType<T> = T extends Array<infer U> ? U : never;

export function remapObject<
  T extends Record<string, unknown>,
  O extends { [K in keyof T]: unknown }
>(
  object: T,
  mapper: <K extends keyof T & string>(value: T[K], key: K) => O[K]
): O {
  return Object.entries(object)
    .map(([key, value]) => ({
      [key]: mapper(value as T[typeof key], key),
    }))
    .reduce((prev, next) => ({
      ...prev,
      ...next,
    })) as O;
}

type Shift<A extends Array<any>> = ((...args: A) => void) extends (
  ...args: [A[0], ...infer R]
) => void
  ? R
  : never;

type GrowExpRev<
  A extends Array<any>,
  N extends number,
  P extends Array<Array<any>>
> = A['length'] extends N
  ? A
  : {
      0: GrowExpRev<[...A, ...P[0]], N, P>;
      1: GrowExpRev<A, N, Shift<P>>;
    }[[...A, ...P[0]][N] extends undefined ? 0 : 1];

type GrowExp<
  A extends Array<any>,
  N extends number,
  P extends Array<Array<any>>
> = A['length'] extends N
  ? A
  : {
      0: GrowExp<[...A, ...A], N, [A, ...P]>;
      1: GrowExpRev<A, N, P>;
    }[[...A, ...A][N] extends undefined ? 0 : 1];

export type FixedSizeArray<T, N extends number> = N extends 0
  ? []
  : N extends 1
  ? [T]
  : GrowExp<[T, T], N, [[T]]>;

export function fixedSizeArray<T, N extends number>(
  length: N,
  initialValue: T
): FixedSizeArray<T, N> {
  return new Array(length).fill(initialValue) as FixedSizeArray<T, N>;
}

export function fixedSizeArrayInit<T, N extends number>(
  length: N,
  init: (index: number) => T
): FixedSizeArray<T, N> {
  return range(0, length).map(init) as FixedSizeArray<T, N>;
}

/**
 * @param length The length for the fixed size array.
 * @param array The array to try to convert.
 * @return `null` if array is the incorrect size.
 */
export function fixedSizeArrayFromArray<T, N extends number>(
  length: N,
  array: T[]
): FixedSizeArray<T, N> | null {
  if (array.length === length) {
    return array as FixedSizeArray<T, N>;
  } else {
    return null;
  }
}

export function arrayDeepEquals<T, U>(
  array1: Readonly<T[]>,
  array2: Readonly<U[]>,
  eq: (a: T, b: U) => boolean
): boolean {
  if (array1.length !== array2.length) {
    return false;
  }
  return array1.reduce((prev, current, index) => {
    const other = array2[index];
    if (other == null) {
      return false;
    }
    return prev && eq(current, other);
  }, true);
}

export function stringToByteArray(input: string, forceSize?: number): number[] {
  const nameBytes = new TextEncoder().encode(input);
  if (forceSize === undefined) {
    return Array.from(nameBytes);
  } else {
    if (nameBytes.length > forceSize) {
      throw new Error('name too long');
    }
    return Array.from(nameBytes).concat(
      new Array(forceSize - nameBytes.length).fill(0)
    );
  }
}

export function byteArrayToString(input: number[]): string {
  const firstZero = input.findIndex((x) => x === 0);
  return new TextDecoder().decode(
    Uint8Array.from(input).slice(0, firstZero === -1 ? undefined : firstZero)
  );
}

export function assertNever(x: never): never {
  throw new Error('Unexpected object: ' + x);
}

/**
 * Class decorator
 */
export function staticImplements<T>() {
  return <U extends T>(constructor: U) => {
    // noinspection BadExpressionStatementJS
    constructor;
  };
}

/** Check if all Object Properties are Null */
export const isNull = <T>(
  obj: keyof T extends string ? { [K in keyof T]: T[K] } : never
) => {
  return Object.values(obj).every((value) => value === null);
};

export type CUnion<T extends Record<PropertyKey, unknown>> = {
  [K in keyof T]: { [_ in K]: T[K] } & {
    [_ in Exclude<keyof T, K>]?: undefined;
  };
}[keyof T];

/** Gets the element at `index` on the array or throws an error if it is not defined */
export const getElementOrError = <T>(array: T[], index: number): T => {
  const el = array[index];
  if (el == null) {
    throw new Error(
      `element at index ${index} doesn't exist in ${typeof array}`
    );
  }
  return el;
};

export interface CustomAnchorError {
  InstructionError: [number, { Custom: number }];
}

export function normalizeArray<T>(val: T | T[]): T[] {
  return Array.isArray(val) ? val : [val];
}

export const snakeCaseToTitleCase = (text: string): string => {
  const result = text.replace(/([A-Z])/g, ' $1');
  return result.charAt(0).toUpperCase() + result.slice(1);
};

export const ACCOUNT_STORAGE_OVERHEAD = 128;
export const LAMPORTS_PER_BYTE_YEAR =
  ((1_000_000_000 / 100) * 365) / (1024 * 1024);
export const EXEMPTION_THRESHOLD = 2;

export function calculateMinimumRent(dataSize: number): number {
  return (
    (ACCOUNT_STORAGE_OVERHEAD + dataSize) *
    LAMPORTS_PER_BYTE_YEAR *
    EXEMPTION_THRESHOLD
  );
}
