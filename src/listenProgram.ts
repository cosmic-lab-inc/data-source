// eslint-disable-next-line @typescript-eslint/no-unused-vars
import {
  AccountInfo,
  KeyedAccountInfo,
  PublicKey,
  TransactionConfirmationStatus,
} from '@solana/web3.js';
import {
  BorshAccountsCoder,
  Coder,
  Idl,
  Program,
  Provider,
} from '@staratlas/anchor';
import { Account, AccountStatic } from './account';
import { remapObject } from './util';

export type ProgramMethods<IDL extends Idl> = Omit<
  Program<IDL>,
  'provider' | 'addEventListener' | 'removeEventListener' | 'rpc' | 'account'
>;

export type AccountUpdate<T> = {
  slot: number;
  writeVersion: number;
  isStartup: boolean;
  confirmationStatus: TransactionConfirmationStatus | 'recent';
  account: T;
  accountInfo: AccountInfo<Buffer>;
};

export type AccountClosedUpdate = {
  slot: number;
  writeVersion: number;
  confirmationStatus: TransactionConfirmationStatus | 'recent';
  key: PublicKey;
  oldOwner: PublicKey;
  newOwner: PublicKey;
  accountInfo: AccountInfo<Buffer>;
};

export type AccountUpdateHandler<T> = (update: AccountUpdate<T>) => void;

export abstract class ListenProgram<
  Accounts extends Record<string, Account>,
  IDL extends Idl
> {
  private readonly listeners: {
    [K in keyof Accounts]: ((update: AccountUpdate<Account>) => void) | null;
  };

  protected readonly accountDiscriminants: {
    [K in keyof Accounts]: Readonly<Buffer>;
  };

  protected accountClosedListener:
    | ((update: AccountClosedUpdate) => void)
    | null = null;

  protected constructor(
    protected program: ProgramMethods<IDL>,
    protected parsers: {
      [K in keyof Accounts & string]: {
        new (...args: never[]): Accounts[K] & Account;
      } & AccountStatic<Accounts[K], IDL>;
    }
  ) {
    this.accountDiscriminants = remapObject(parsers, (value) =>
      BorshAccountsCoder.accountDiscriminator(value.ACCOUNT_NAME)
    );
    this.listeners = remapObject(parsers, () => null);
  }

  setAccountClosedListener(
    listener: (update: AccountClosedUpdate) => void | null
  ): void {
    this.accountClosedListener = listener;
  }

  get programId(): PublicKey {
    return this.program.programId;
  }

  accountDiscriminant(accountId: keyof Accounts): Buffer {
    return this.accountDiscriminants[accountId];
  }

  discriminantToAccountId(data: Buffer): {
    key: keyof Accounts & string;
    discriminantLength: number;
  } | null {
    for (const [key, value] of Object.entries(this.accountDiscriminants)) {
      if (data.subarray(0, value.length).equals(value)) {
        return {
          key: key as keyof Accounts & string,
          discriminantLength: value.length,
        };
      }
    }
    return null;
  }

  provideDecodedAccountEvent<AccountId extends keyof Accounts>(
    accountId: AccountId,
    account: Accounts[AccountId],
    slot: number,
    confirmationStatus: TransactionConfirmationStatus | 'recent',
    isStartup: boolean,
    accountInfo: AccountInfo<Buffer>,
    writeVersion: number
  ): void {
    const listener = this.listeners[accountId];

    if (listener) {
      listener({
        account,
        slot,
        confirmationStatus,
        isStartup,
        accountInfo,
        writeVersion,
      });
    }
  }

  provideAccountEvent(
    account: KeyedAccountInfo,
    slot: number,
    confirmationStatus: TransactionConfirmationStatus | 'recent',
    isStartup: boolean,
    writeVersion: number,
    unknownAccountHandler: (key: PublicKey) => void = (key: PublicKey) => {
      console.error(
        `Unknown account \`${key.toBase58()}\` for program \`${this.programId.toBase58()}\``
      );
    }
  ): void {
    const accountId = this.discriminantToAccountId(account.accountInfo.data);
    if (accountId === null) {
      unknownAccountHandler(account.accountId);
      return;
    }
    if (this.listeners[accountId.key]) {
      const decoded = this.parsers[accountId.key].decodeData(
        account,
        this.program
      );
      if ('error' in decoded) {
        throw decoded.error;
      }
      this.provideDecodedAccountEvent(
        accountId.key,
        decoded.data,
        slot,
        confirmationStatus,
        isStartup,
        account.accountInfo,
        writeVersion
      );
    }
  }

  setAccountListener<AccountId extends keyof Accounts>(
    accountId: AccountId,
    accountType: { new (...args: never[]): Accounts[AccountId] },
    listener: AccountUpdateHandler<Accounts[AccountId]> | null
  ): void {
    if (listener) {
      this.listeners[accountId] = (update) => {
        if (update.account instanceof accountType) {
          listener({ ...update, account: update.account });
        } else {
          console.error(
            'Wrong account type passed, account: ',
            JSON.stringify(update.account)
          );
        }
      };
    } else {
      this.listeners[accountId] = null;
    }
  }

  discriminantToAccountIdNoSubarray(discriminant: Buffer): {
    key: keyof Accounts & string;
    discriminantLength: number;
  } | null {
    const keys = Object.keys(this.accountDiscriminants);

    for (const key of keys) {
      const value = this.accountDiscriminants[key];
      if (discriminant.equals(value)) {
        return {
          key: key as keyof Accounts & string,
          discriminantLength: value.length,
        };
      }
    }
    return null;
  }

  provideAccountClosedEvent(
    key: PublicKey,
    oldOwner: PublicKey,
    newOwner: PublicKey,
    slot: number,
    confirmationStatus: TransactionConfirmationStatus | 'recent',
    writeVersion: number,
    accountInfo: AccountInfo<Buffer>
  ): void {
    const listener = this.accountClosedListener;
    if (listener) {
      listener({
        accountInfo,
        slot,
        confirmationStatus,
        writeVersion,
        key,
        oldOwner,
        newOwner,
      });
    }
  }
}

export interface ListenProgramStatic<
  Self,
  Accounts extends Record<string, Account>,
  IDL extends Idl
> {
  new (program: ProgramMethods<IDL>): Self & ListenProgram<Accounts, IDL>;

  buildProgram(
    programId: PublicKey,
    provider?: Provider,
    coder?: Coder
  ): ProgramMethods<IDL>;
}
