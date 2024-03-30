/**
 * Part of this code has been taken from the excellent Saber-HQ anchor-contrib
 * https://github.com/saber-hq/saber-common/tree/master/packages/anchor-contrib
 *
 */
import type { Idl } from '@staratlas/anchor';
import type { AnchorError } from './anchorTypes';

export type ErrorMap<T extends Idl> = {
  [K in AnchorError<T>['name']]: AnchorError<T> & { name: K };
};

/**
 * Generates the error mapping
 * @param idl
 * @returns the program error map
 */
export const generateErrorMap = <T extends Idl>(idl: T): ErrorMap<T> => {
  return (idl.errors?.reduce((acc, err) => {
    return {
      ...acc,
      [err.name]: err,
    };
  }, {}) ?? {}) as ErrorMap<T>;
};
