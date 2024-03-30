import {
  ClientSubscriptionId,
  Connection,
  Context,
  GetProgramAccountsFilter,
  KeyedAccountInfo,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  TransactionConfirmationStatus,
  TransactionSignature,
} from '@solana/web3.js';
import { BorshAccountsCoder, Idl } from '@staratlas/anchor';
import bs58 from 'bs58';
import { chunk } from 'lodash';
import { Account, AccountStatic, DecodedAccountData } from './account';
import { DataSource, InsertProgramReturn } from './dataSource';
import { ListenProgram, ProgramMethods } from './listenProgram';
import { FixedSizeArray, fixedSizeArrayFromArray } from './util';

type StoredProgram = {
  program: ListenProgram<Record<string, Account>, any>;
  listenerId: FixedSizeArray<ClientSubscriptionId, 3>;
  refresh: () => Promise<void>;
};

export function buildRPCDataSource(connection: Connection): DataSource {
  const programs: { programs: (StoredProgram | null)[] | null } = {
    programs: [],
  };

  const handler =
    (
      program: ListenProgram<Record<string, Account>, any>,
      confirmation: TransactionConfirmationStatus,
      startup: boolean
    ) =>
    (account: KeyedAccountInfo, context: Context): void => {
      program.provideAccountEvent(
        account,
        context.slot,
        confirmation,
        startup,
        0
      );
    };

  return {
    async insertProgram<
      Accounts extends Record<string, Account>,
      IDL extends Idl
    >(
      program: ListenProgram<Accounts, IDL>,
      startupCommitment: TransactionConfirmationStatus | 'recent'
    ): Promise<InsertProgramReturn> {
      if (programs.programs === null) {
        throw new Error('Data source closed');
      }
      if (startupCommitment === 'recent') {
        throw new Error('RPC Data Source does not support recent');
      }
      const array = fixedSizeArrayFromArray(3, [
        connection.onProgramAccountChange(
          program.programId,
          handler(program, 'processed', false),
          'processed'
        ),
        connection.onProgramAccountChange(
          program.programId,
          handler(program, 'confirmed', false),
          'confirmed'
        ),
        connection.onProgramAccountChange(
          program.programId,
          handler(program, 'finalized', false),
          'finalized'
        ),
      ]);
      if (array === null) {
        throw new Error('Could not create listener array');
      }
      const index = programs.programs.length;

      const refresh = async () => {
        if (programs.programs === null) {
          return;
        }
        const program = programs.programs[index];
        if (!program) {
          return;
        }
        const { program: listenProgram } = program;
        const accounts = await connection.getProgramAccounts(
          listenProgram.programId,
          startupCommitment
        );
        for (const account of accounts) {
          listenProgram.provideAccountEvent(
            { accountId: account.pubkey, accountInfo: account.account },
            0,
            startupCommitment,
            true,
            0
          );
        }
      };
      programs.programs.push({ program, listenerId: array, refresh });

      await refresh();

      return {
        close: async () => {
          if (programs.programs === null) {
            return;
          }
          const program = programs.programs[index];
          if (!program) {
            return;
          }
          const { listenerId } = program;
          programs.programs[index] = null;
          await Promise.all([
            connection.removeProgramAccountChangeListener(listenerId[0]),
            connection.removeProgramAccountChangeListener(listenerId[1]),
            connection.removeProgramAccountChangeListener(listenerId[2]),
          ]);
        },
        refresh,
      };
    },
    async closeDataSource() {
      if (programs.programs === null) {
        throw new Error('Data source already closed');
      }
      const promises: Promise<void>[] = [];
      for (const listenerId of programs.programs
        .filter((p): p is StoredProgram => p !== null)
        .flatMap((p) => p.listenerId)) {
        try {
          promises.push(connection.removeAccountChangeListener(listenerId));
        } catch (e) {
          console.error('Could not remove listener: ', e);
        }
      }
      programs.programs = null;
      await Promise.all(promises);
    },
    async refreshAll() {
      await Promise.all(programs.programs?.map((p) => p?.refresh()) ?? []);
    },
  };
}

export async function readAllFromRPC<A extends Account, IDL extends Idl>(
  connection: Connection,
  program: ProgramMethods<IDL>,
  accountClass: AccountStatic<A, IDL>,
  commitment?: TransactionConfirmationStatus,
  additionalFilters: GetProgramAccountsFilter[] = []
): Promise<DecodedAccountData<A>[]> {
  const accounts = await connection.getProgramAccounts(program.programId, {
    ...(commitment ? { commitment } : {}),
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: bs58.encode(
            BorshAccountsCoder.accountDiscriminator(accountClass.ACCOUNT_NAME)
          ),
        },
      },
      ...additionalFilters,
    ],
  });
  return accounts.map((account) =>
    accountClass.decodeData(
      { accountInfo: account.account, accountId: account.pubkey },
      program
    )
  );
}

export async function readFromRPC<A extends Account, IDL extends Idl>(
  connection: Connection,
  program: ProgramMethods<IDL>,
  key: PublicKey,
  accountClass: AccountStatic<A, IDL>,
  commitment?: TransactionConfirmationStatus
): Promise<DecodedAccountData<A>> {
  const account = await connection.getAccountInfo(key, commitment);
  if (account === null) {
    return {
      type: 'error',
      key,
      error: new Error('account does not exist'),
    };
  } else {
    return accountClass.decodeData(
      { accountInfo: account, accountId: key },
      program
    );
  }
}

export async function readFromRPCOrError<A extends Account, IDL extends Idl>(
  connection: Connection,
  program: ProgramMethods<IDL>,
  key: PublicKey,
  accountClass: AccountStatic<A, IDL>,
  commitment?: TransactionConfirmationStatus
): Promise<A> {
  const result = await readFromRPC(
    connection,
    program,
    key,
    accountClass,
    commitment
  );
  if ('error' in result) {
    throw result.error;
  }
  return result.data;
}

export async function readFromRPCNullable<A extends Account, IDL extends Idl>(
  connection: Connection,
  program: ProgramMethods<IDL>,
  key: PublicKey,
  accountClass: AccountStatic<A, IDL>,
  commitment?: TransactionConfirmationStatus
): Promise<A | null> {
  const result = await readFromRPC(
    connection,
    program,
    key,
    accountClass,
    commitment
  );
  if ('error' in result) {
    return null;
  } else {
    return result.data;
  }
}

export function accountRPCSubscribe<A extends Account, IDL extends Idl>(
  connection: Connection,
  program: ProgramMethods<IDL>,
  key: PublicKey,
  accountClass: AccountStatic<A, IDL>,
  callback: (data: DecodedAccountData<A>) => void,
  commitment?: TransactionConfirmationStatus
): ClientSubscriptionId {
  return connection.onAccountChange(
    key,
    (account) => {
      callback(
        accountClass.decodeData(
          { accountInfo: account, accountId: key },
          program
        )
      );
    },
    commitment
  );
}

export async function airdrop(
  connection: Connection,
  wallet: PublicKey,
  lamports: number = LAMPORTS_PER_SOL,
  commitment?: TransactionConfirmationStatus
): Promise<TransactionSignature> {
  const sig = await connection.requestAirdrop(wallet, lamports);
  await connection.confirmTransaction(sig, commitment);
  return sig;
}

/**
 * Read multiple accounts from the RPC
 * @param accountsToRead - array of keys of accounts to read
 * @param connection - Solana connection object
 * @param program - the program that owns the accounts
 * @param accountClass - the account class
 * @param commitment - the Solana commitment level
 * @returns an array of the decoded accounts
 */
export async function readMultipleFromRPC<A extends Account, IDL extends Idl>(
  accountsToRead: PublicKey[],
  connection: Connection,
  program: ProgramMethods<IDL>,
  accountClass: AccountStatic<A, IDL>,
  commitment?: TransactionConfirmationStatus
): Promise<DecodedAccountData<A>[]> {
  /** getMultipleAccountsInfo is limited to 100 at a time */
  const result = (
    await Promise.all(
      chunk(accountsToRead, 100).map((it) =>
        connection.getMultipleAccountsInfo(it, commitment)
      )
    )
  ).flat();

  const accounts: DecodedAccountData<A>[] = [];

  for (let index = 0; index < result.length; index++) {
    const account = result[index];
    const accountId = accountsToRead[index];
    if (account) {
      accounts.push(
        accountClass.decodeData({ accountInfo: account, accountId }, program)
      );
    }
  }

  return accounts;
}

/**
 * Get current timestamp on chain
 * @param connection - the Solana connection object
 * @returns current timestamp on chain
 */
export const getCurrentTimestampOnChain = async (
  connection: Connection
): Promise<bigint> => {
  const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  if (clock === null) {
    throw 'Failed to fetch Clock account info';
  }
  return clock.data.readBigInt64LE(8 * 4);
};
