import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { Result, ok } from 'neverthrow';
import { AsyncSigner } from '../asyncSigner';
import { normalizeArray } from '../util';
import { buildDynamicTransactionsNoSigning } from './sizing';
import {
  InstructionReturn,
  TransactionReturn,
  buildAndSignTransaction,
  buildAndSignTransactionsFromIxWithSigners,
  ixReturnsToIxs,
  ixToIxReturn,
} from './transactionHandling';

export const COMPUTE_TEST_INSTRUCTION_RETURNS = [
  ixToIxReturn(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 426 })
  ),
  ixToIxReturn(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })),
];

export const COMPUTE_TEST_INSTRUCTIONS = [
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 426 }),
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
];

export function getWritableAccounts(
  instructions: TransactionInstruction[]
): PublicKey[] {
  const keys = instructions
    .map((ix) =>
      ix.keys.filter((meta) => meta.isWritable).map((meta) => meta.pubkey)
    )
    .flat();
  const uniqueKeys = new Set(keys);
  return Array.from(uniqueKeys);
}

export function buildSimulationTransaction(
  instructions: TransactionInstruction[],
  lookupTables: AddressLookupTableAccount[],
  payerKey: PublicKey
): VersionedTransaction {
  return new VersionedTransaction(
    new TransactionMessage({
      instructions,
      payerKey,
      recentBlockhash: PublicKey.default.toString(),
    }).compileToV0Message(lookupTables)
  );
}

/**
 * Gets the compute units used in a transaction by simulating it.
 * @param transaction - The transaction to simulate.
 * @param connection - The connection to use for the simulation.
 * @returns The number of compute units used in the simulation, or undefined if the simulation failed.
 */
export const getSimulationUnits: GetComputeLimit = async (
  transaction: VersionedTransaction,
  connection: Connection
) => {
  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  if (simulation.value.err) {
    return undefined;
  }
  return simulation.value?.unitsConsumed;
};

export type GetPriorityFee = (
  writableAccounts: PublicKey[],
  connection: Connection
) => Promise<number>;

export type GetComputeLimit = (
  transaction: VersionedTransaction,
  connection: Connection
) => Promise<number | undefined>;

export type PriorityConfig = {
  getLimit: GetComputeLimit | undefined;
  getFee: GetPriorityFee | undefined;
};

/**
 * Builds a compute-optimized transaction from a set of instructions, fee payer, connection, and lookup tables
 *
 * @param connection - The connection to use for getting the rbh and passed in to the priority config functions
 * @param instructions - The main instructions to include in the transaction.
 * @param feePayer - The fee payer for the transaction.
 * @param priorityConfig - Configuration for if and how the Compute budget instructions will be added to the transaction.
 * @param lookupTables - Optional list of lookup tables to try to build transaction with.
 * @returns A promise that resolves to a Transaction with rbh and commitment.
 */
export async function buildAndSignOptimalTransaction(
  connection: Connection,
  instructions: InstructionReturn | InstructionReturn[],
  feePayer: AsyncSigner,
  priorityConfig: PriorityConfig,
  lookupTables: AddressLookupTableAccount[] = []
): Promise<TransactionReturn> {
  const ixArray = normalizeArray(instructions);
  const getLimit = async () => {
    if (priorityConfig.getLimit === undefined) {
      return undefined;
    }
    const simulationTransaction = buildSimulationTransaction(
      [
        ...COMPUTE_TEST_INSTRUCTIONS,
        ...(await ixReturnsToIxs(ixArray, feePayer)),
      ],
      lookupTables,
      feePayer.publicKey()
    );
    return priorityConfig.getLimit(simulationTransaction, connection);
  };

  const getFee = async () => {
    if (priorityConfig.getFee === undefined) {
      return undefined;
    }
    const txInstructions = await ixReturnsToIxs(ixArray, feePayer);
    const writableKeys = getWritableAccounts(txInstructions);
    return priorityConfig.getFee(writableKeys, connection);
  };

  const [units, microLamports, rbh] = await Promise.all([
    getLimit(),
    getFee(),
    connection.getLatestBlockhash(),
  ]);
  if (units) {
    ixArray.unshift(
      ixToIxReturn(ComputeBudgetProgram.setComputeUnitLimit({ units }))
    );
  }
  if (microLamports) {
    ixArray.unshift(
      ixToIxReturn(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }))
    );
  }

  return buildAndSignTransaction(
    ixArray,
    feePayer,
    { rbh, commitment: connection.commitment ?? 'confirmed' },
    lookupTables
  );
}

/**
 * Builds compute-optimized dynamic transactions from a set of instructions, fee payer, connection, lookup tables, and optional before/after instructions.
 *
 * @param connection - The connection to use for getting the rbh and passed in to the priority config functions
 * @param instructions - The main instructions to include in the transactions.
 * @param feePayer - The fee payer for the transactions.
 * @param priorityConfig - Configuration for if and how the Compute budget instructions will be added to the transactions.
 * @param lookupTables - Optional list of lookup tables to try to build transactions with.
 * @param beforeIxs - Optional instructions to include at the beginning of each transaction.
 * @param afterIxs - Optional instructions to include at the end of each transaction.
 * @param maxInstructionCount - The maximum number of instructions to include in each transaction.
 * @returns A promise that resolves to a result object containing either the built transactions or an error message.
 */
export async function buildOptimalDynamicTransactions(
  connection: Connection,
  instructions: InstructionReturn | InstructionReturn[],
  feePayer: AsyncSigner,
  priorityConfig: PriorityConfig,
  lookupTables: AddressLookupTableAccount[] = [],
  beforeIxs?: InstructionReturn[],
  afterIxs?: InstructionReturn[],
  maxInstructionCount = 64
): Promise<Result<TransactionReturn[], string>> {
  const testBeforeIxs = [
    ...COMPUTE_TEST_INSTRUCTION_RETURNS,
    ...(beforeIxs ?? []),
  ];

  const noSigning = await buildDynamicTransactionsNoSigning(
    instructions,
    feePayer,
    testBeforeIxs,
    afterIxs,
    lookupTables,
    maxInstructionCount
  );
  if (noSigning.isErr()) {
    throw noSigning.error;
  }
  const noSignedIxs = noSigning.value.map((v) => {
    const testInstructions = v.instructions.map((i) => i.instruction);
    const writableKeys = priorityConfig.getFee
      ? getWritableAccounts(testInstructions)
      : [];
    const simulationTransaction = buildSimulationTransaction(
      testInstructions,
      v.lookupTables,
      feePayer.publicKey()
    );
    // remove the temp compute budget instructions
    v.instructions.splice(0, 2);
    return {
      simulationTransaction,
      writableKeys,
      instructionsWithSigners: v,
    };
  });

  const getIxWithComputeBudget = () =>
    Promise.all(
      noSignedIxs.map(
        async ({
          writableKeys,
          simulationTransaction,
          instructionsWithSigners,
        }) => {
          const [simulationUnits, fees] = await Promise.all([
            priorityConfig.getLimit
              ? priorityConfig.getLimit(simulationTransaction, connection)
              : undefined,
            priorityConfig.getFee
              ? priorityConfig.getFee(writableKeys, connection)
              : undefined,
          ]);
          return { simulationUnits, fees, instructionsWithSigners };
        }
      )
    );

  const [ixWithComputeBudget, rbh] = await Promise.all([
    getIxWithComputeBudget(),
    connection.getLatestBlockhash(),
  ]);
  const buildTransactions = ixWithComputeBudget.map((ix) => {
    const ixWithSigners = ix.instructionsWithSigners;
    if (ix.fees !== undefined) {
      ixWithSigners.instructions.unshift({
        instruction: ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: ix.fees,
        }),
        signers: [],
      });
    }
    if (ix.simulationUnits !== undefined) {
      ixWithSigners.instructions.unshift({
        instruction: ComputeBudgetProgram.setComputeUnitLimit({
          units: ix.simulationUnits,
        }),
        signers: [],
      });
    }
    return {
      connectionOrRbh: {
        rbh,
        commitment: connection.commitment ?? 'confirmed',
      },
      ixs: ixWithSigners.instructions,
      lookupTables: ixWithSigners.lookupTables,
    };
  });
  return ok(
    await buildAndSignTransactionsFromIxWithSigners(buildTransactions, feePayer)
  );
}
