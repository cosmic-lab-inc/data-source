import { KeyedAccountInfo, PublicKey } from '@solana/web3.js';
import { BorshAccountsCoder, Coder, Idl } from '@staratlas/anchor';
import { ProgramMethods } from './listenProgram';

export type DecodedAccountData<T> =
  | { type: 'ok'; key: PublicKey; data: T }
  | {
      type: 'error';
      key: PublicKey;
      error: Error;
    };

export interface Account {
  get key(): PublicKey;
}

export interface AccountStatic<Self extends Account, IDL extends Idl> {
  /** should be in camelCase */
  readonly ACCOUNT_NAME: NonNullable<IDL['accounts']>[number]['name'];
  /** The size of any header data and discriminant */
  readonly MIN_DATA_SIZE: number;
  new (...args: never[]): Self & Account;
  decodeData(
    account: KeyedAccountInfo,
    program: ProgramMethods<IDL>
  ): DecodedAccountData<Self>;
}

interface ToBufferInterface {
  toBuffer: () => Buffer;
}

export type ToBuffer =
  | ToBufferInterface
  | PublicKey
  | Buffer
  | Uint8Array
  | string;

export interface PdaAccountStatic<
  Self extends Account,
  IDL extends Idl,
  SeedsArgs extends Record<string, ToBuffer>
> extends AccountStatic<Self, IDL> {
  findAddress(
    program: ProgramMethods<IDL>,
    args: SeedsArgs
  ): [PublicKey, number];
}

export function decodeAccount<A extends Account, D, IDL extends Idl>(
  account: KeyedAccountInfo,
  program: ProgramMethods<IDL>,
  accountClass: AccountStatic<A, IDL> & (new (data: D, key: PublicKey) => A)
): DecodedAccountData<A> {
  if (!account.accountInfo.owner.equals(program.programId)) {
    return {
      type: 'error',
      key: account.accountId,
      error: new Error('not owned by program'),
    };
  } else if (
    !account.accountInfo.data
      .subarray(0, 8)
      .equals(
        BorshAccountsCoder.accountDiscriminator(accountClass.ACCOUNT_NAME)
      )
  ) {
    return {
      type: 'error',
      key: account.accountId,
      error: new Error('discriminator mismatch'),
    };
  } else {
    try {
      const coder: Coder<NonNullable<IDL['accounts']>[number]['name']> =
        program.coder;
      const data = coder.accounts.decode<D>(
        accountClass.ACCOUNT_NAME,
        account.accountInfo.data
      );
      return {
        type: 'ok',
        key: account.accountId,
        data: new accountClass(data, account.accountId),
      };
    } catch (error) {
      return {
        type: 'error',
        key: account.accountId,
        error: error as Error,
      };
    }
  }
}

export function decodeAccountWithRemaining<
  A extends Account,
  D,
  R,
  IDL extends Idl
>(
  account: KeyedAccountInfo,
  program: ProgramMethods<IDL>,
  accountClass: AccountStatic<A, IDL> &
    (new (data: D, key: PublicKey, remainingData: R) => A),
  remainingDataFunc: (remainingData: Buffer, data: D) => R
): DecodedAccountData<A> {
  if (!account.accountInfo.owner.equals(program.programId)) {
    return {
      type: 'error',
      key: account.accountId,
      error: new Error('not owned by program'),
    };
  } else if (
    !account.accountInfo.data
      .subarray(0, 8)
      .equals(
        BorshAccountsCoder.accountDiscriminator(accountClass.ACCOUNT_NAME)
      )
  ) {
    return {
      type: 'error',
      key: account.accountId,
      error: new Error('discriminator mismatch'),
    };
  } else {
    try {
      const coder: Coder<NonNullable<IDL['accounts']>[number]['name']> =
        program.coder;

      const data = coder.accounts.decode<D>(
        accountClass.ACCOUNT_NAME,
        account.accountInfo.data.subarray(0, accountClass.MIN_DATA_SIZE)
      );
      return {
        type: 'ok',
        key: account.accountId,
        data: new accountClass(
          data,
          account.accountId,
          remainingDataFunc(
            account.accountInfo.data.subarray(accountClass.MIN_DATA_SIZE),
            data
          )
        ),
      };
    } catch (error) {
      return {
        type: 'error',
        key: account.accountId,
        error: error as Error,
      };
    }
  }
}
