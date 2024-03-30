import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import { Result, err, ok } from 'neverthrow';
import { AsyncSigner } from '../asyncSigner';
import { normalizeArray } from '../util';
import {
  BuildTransactionsType,
  ConnectionOrRbh,
  InstructionReturn,
  InstructionWithSigners,
  TransactionReturn,
  buildAndSignTransactionsFromIxWithSigners,
} from './transactionHandling';

export const MAX_TRANSACTION_SIZE = 1232;
export const MAX_UNIQUE_KEYS_COUNT = 128;

/* 
  Returns the number of keys in the set that are contained in the lookup table, along with a set of the remaining keys that aren't
 */
export function containedInLUTCount(
  keys: Set<string>,
  lookupTableAddresses: Set<string>
): [number, Set<string>] {
  let includedCount = 0;
  const notIncluded = new Set<string>();
  keys.forEach((k) => {
    if (lookupTableAddresses.has(k)) {
      includedCount++;
    } else {
      notIncluded.add(k);
    }
  });
  return [includedCount, notIncluded];
}

type TransactionSize = {
  size: number;
  lookupTables: AddressLookupTableAccount[];
  uniqueKeyCount: number;
};

type StaticAccountSize = {
  staticSize: number;
  staticAccounts: number;
};

export function getTransactionSize(
  instructions: InstructionWithSigners[],
  funder: PublicKey,
  lookupTables: [Set<string>, AddressLookupTableAccount][] = []
): TransactionSize {
  const uniqueSigners: Set<string> = new Set();
  const programIds = new Set<string>();
  const lutEligibleKeys: Set<string> = new Set();

  uniqueSigners.add(funder.toBase58());
  instructions.forEach(({ instruction }) => {
    programIds.add(instruction.programId.toBase58());
    instruction.keys.forEach((s) => {
      if (s.isSigner) {
        uniqueSigners.add(s.pubkey.toBase58());
      }
      lutEligibleKeys.add(s.pubkey.toBase58());
    });
  });
  // remove signers and top level program ids from lut eligible keys
  for (const signer of uniqueSigners) {
    lutEligibleKeys.delete(signer);
  }
  for (const programId of programIds) {
    lutEligibleKeys.delete(programId);
  }

  // shouldn't be possible for a program id to be a signer, but just in case...
  const ineligibleKeys = new Set([...uniqueSigners, ...programIds]);

  let ixSizes = 0;
  instructions.forEach(({ instruction }) => {
    ixSizes +=
      1 + // program id index
      lengthToCompact16size(instruction.keys.length) + // num accounts
      instruction.keys.length + // account indexes
      lengthToCompact16size(instruction.data.length) + // num ix bytes
      instruction.data.length; // ix bytes
  });

  const staticSize =
    lengthToCompact16size(uniqueSigners.size) + // num sigs
    uniqueSigners.size * 64 + // Sigs
    3 + // message header
    32 + // recent blockhash
    1 + // version field, assume all are v0
    lengthToCompact16size(instructions.length) + // num instructions
    ixSizes +
    1; // LUT length field

  const staticAccountSize: StaticAccountSize = {
    staticSize,
    staticAccounts: ineligibleKeys.size,
  };
  const bestSize = totalSize(staticAccountSize, 0, 0, lutEligibleKeys.size);

  const uniqueKeyCount = ineligibleKeys.size + lutEligibleKeys.size;

  if (bestSize <= MAX_TRANSACTION_SIZE || lookupTables.length === 0) {
    return {
      size: bestSize,
      lookupTables: [],
      uniqueKeyCount,
    };
  } else if (uniqueKeyCount > MAX_UNIQUE_KEYS_COUNT) {
    return {
      size: bestSize,
      lookupTables: [],
      uniqueKeyCount,
    };
  }

  return findBestLookupTables(
    staticAccountSize,
    bestSize,
    0,
    0,
    lutEligibleKeys,
    [],
    [...lookupTables]
  );
}

function findBestLookupTables(
  staticAccountSize: StaticAccountSize,
  size: number,
  lutCount: number,
  includedAccounts: number,
  remainingAccounts: Set<string>,
  usedLuts: AddressLookupTableAccount[],
  remainingLuts: [Set<string>, AddressLookupTableAccount][]
): TransactionSize {
  if (remainingLuts.length === 0) {
    return {
      size,
      lookupTables: usedLuts,
      uniqueKeyCount: includedAccounts + remainingAccounts.size,
    };
  }
  let bestRemaining = remainingAccounts;
  let bestSize = size;
  let bestIncluded = includedAccounts;
  let bestLutIndex = 0;
  for (const [lutIndex, lut] of remainingLuts.entries()) {
    const [count, remainingUnique] = containedInLUTCount(
      remainingAccounts,
      lut[0]
    );
    const newIncluded = includedAccounts + count;
    const txnSize = totalSize(
      staticAccountSize,
      lutCount + 1,
      newIncluded,
      remainingUnique.size
    );
    if (txnSize < MAX_TRANSACTION_SIZE) {
      usedLuts.push(lut[1]);
      return {
        size: txnSize,
        lookupTables: usedLuts,
        uniqueKeyCount: newIncluded + remainingUnique.size,
      };
    } else if (txnSize < bestSize) {
      bestSize = txnSize;
      bestRemaining = remainingUnique;
      bestIncluded = newIncluded;
      bestLutIndex = lutIndex;
    }
  }
  if (size === bestSize) {
    return {
      size: size,
      lookupTables: usedLuts,
      uniqueKeyCount: includedAccounts + remainingAccounts.size,
    };
  }
  // remove the best lut from the remaining luts and add it to the used luts
  const bestLut = remainingLuts.splice(bestLutIndex, 1)[0];
  usedLuts.push(bestLut[1]);
  return findBestLookupTables(
    staticAccountSize,
    bestSize,
    lutCount + 1,
    bestIncluded,
    bestRemaining,
    usedLuts,
    remainingLuts
  );
}

/**
 * Returns the total size of a serialized transaction
 * @param staticAccountSize - the static size and number of static accounts in a transaction
 * @param lutCount - the number of LUTs that are in a transaction
 * @param includedAccounts - the number of accounts that are in a LUT
 * @param remainingStatic - additional static accounts that are not in a LUT
 */
function totalSize(
  staticAccountSize: StaticAccountSize,
  lutCount: number,
  includedAccounts: number,
  remainingStatic: number
) {
  const staticCount = staticAccountSize.staticAccounts + remainingStatic;
  return (
    staticAccountSize.staticSize +
    34 * lutCount + // lut key, writable len, readable len
    includedAccounts + // byte for each account index in the LUT
    lengthToCompact16size(staticCount) + // size of unique static keys
    staticCount * 32
  );
}

const insert = <T>(arr: T[], index: number, newItem: T) => [
  // part of the array before the specified index
  ...arr.slice(0, index),
  // inserted item
  newItem,
  // part of the array after the specified index
  ...arr.slice(index),
];

const deepCopyInstructions = (
  instructions: InstructionsWithSignersAndLUTs
): InstructionsWithSignersAndLUTs => {
  return {
    instructions: instructions.instructions.map((entry) => ({
      ...entry,
      instruction: new TransactionInstruction({
        keys: entry.instruction.keys.map((k) => ({ ...k })),
        programId: entry.instruction.programId,
        data: entry.instruction.data
          ? Buffer.from(entry.instruction.data)
          : undefined,
      }),
    })),
    lookupTables: instructions.lookupTables,
  };
};

export type InstructionsWithSignersAndLUTs = {
  instructions: InstructionWithSigners[];
  lookupTables: AddressLookupTableAccount[];
};

export function buildLookupTableSet(
  lookupTables: AddressLookupTableAccount[]
): [Set<string>, AddressLookupTableAccount][] {
  return lookupTables.map((lut) => {
    const addresses = lut.state.addresses.map((a) => a.toBase58());
    const set = new Set(addresses);

    return [set, lut];
  });
}

export async function buildDynamicTransactionsNoSigning(
  instructions: InstructionReturn | InstructionReturn[],
  feePayer: AsyncSigner,
  beforeIxs: InstructionReturn | InstructionReturn[] = [],
  afterIxs: InstructionReturn | InstructionReturn[] = [],
  lookupTables: AddressLookupTableAccount[] = [],
  maxInstructionCount = 64
): Promise<Result<InstructionsWithSignersAndLUTs[], string>> {
  const instructionsWithSigners = normalizeArray(
    await Promise.all(normalizeArray(instructions).map((ix) => ix(feePayer)))
  ).flat();

  const beforeIxsWithSigners = normalizeArray(
    await Promise.all(normalizeArray(beforeIxs).map((ix) => ix(feePayer)))
  ).flat();
  const afterIxsWithSigners = normalizeArray(
    await Promise.all(normalizeArray(afterIxs).map((ix) => ix(feePayer)))
  ).flat();

  const output: InstructionsWithSignersAndLUTs[] = [];

  const lookupTableAddresses = buildLookupTableSet(lookupTables);
  let current: InstructionsWithSignersAndLUTs = {
    instructions: [...beforeIxsWithSigners, ...afterIxsWithSigners],
    lookupTables: [],
  };
  const {
    size: currentSize,
    lookupTables: currentLuts,
    uniqueKeyCount,
  } = getTransactionSize(
    current.instructions,
    feePayer.publicKey(),
    lookupTableAddresses
  );
  if (currentSize > MAX_TRANSACTION_SIZE) {
    return err(
      'Before and after instructions alone are too big to fit in transaction'
    );
  } else if (uniqueKeyCount > MAX_UNIQUE_KEYS_COUNT) {
    return err(
      'Before and after instructions alone have too many unique keys to fit in transaction'
    );
  }
  current.lookupTables = currentLuts;

  for (const ix of instructionsWithSigners) {
    const nextIxs = insert(
      current.instructions,
      current.instructions.length - afterIxsWithSigners.length,
      ix
    );
    const {
      size: nextSize,
      lookupTables: nextLuts,
      uniqueKeyCount: nextUniqueKeyCount,
    } = getTransactionSize(nextIxs, feePayer.publicKey(), lookupTableAddresses);

    if (
      nextSize > MAX_TRANSACTION_SIZE ||
      nextUniqueKeyCount > MAX_UNIQUE_KEYS_COUNT ||
      nextIxs.length > maxInstructionCount
    ) {
      output.push(deepCopyInstructions(current));
      const currentIxs = [...beforeIxsWithSigners, ix, ...afterIxsWithSigners];

      const {
        size: currentSize,
        lookupTables: currentLuts,
        uniqueKeyCount: currentUniqueKeyCount,
      } = getTransactionSize(
        currentIxs,
        feePayer.publicKey(),
        lookupTableAddresses
      );
      if (currentSize > MAX_TRANSACTION_SIZE) {
        return err(
          `Instruction too large to fit in transaction: ${ix.instruction.programId.toBase58()}`
        );
      } else if (currentUniqueKeyCount > MAX_UNIQUE_KEYS_COUNT) {
        return err(
          `Instruction has too many unique accounts to fit in transaction: ${ix.instruction.programId.toBase58()}`
        );
      } else {
        current = {
          instructions: currentIxs,
          lookupTables: currentLuts,
        };
      }
    } else {
      current = {
        instructions: nextIxs,
        lookupTables: nextLuts,
      };
    }
  }

  if (
    current.instructions.length >
    beforeIxsWithSigners.length + afterIxsWithSigners.length
  ) {
    output.push(deepCopyInstructions(current));
  }

  return ok(output);
}

/**
 * Builds dynamic transactions from a set of instructions, fee payer, connection, and optional before/after instructions.
 *
 * @param instructions - The main instructions to include in the transactions.
 * @param feePayer - The fee payer for the transactions.
 * @param connectionOrRbh - The connection information or recent blockhash with expiry and commitment.
 * @param beforeIxs - Optional instructions to include at the beginning of each transaction.
 * @param afterIxs - Optional instructions to include at the end of each transaction.
 * @param lookupTables - Optional list of lookup tables to try to build transactions with.
 * @param maxInstructionCount - The maximum number of instructions to include in each transaction.
 * @returns A promise that resolves to a result object containing either the built transactions or an error message.
 */
export async function buildDynamicTransactions(
  instructions: InstructionReturn | InstructionReturn[],
  feePayer: AsyncSigner,
  connectionOrRbh: ConnectionOrRbh,
  beforeIxs: InstructionReturn | InstructionReturn[] = [],
  afterIxs: InstructionReturn | InstructionReturn[] = [],
  lookupTables: AddressLookupTableAccount[] = [],
  maxInstructionCount = 64
): Promise<Result<TransactionReturn[], string>> {
  const output = await buildDynamicTransactionsNoSigning(
    instructions,
    feePayer,
    beforeIxs,
    afterIxs,
    lookupTables,
    maxInstructionCount
  );
  if (output.isErr()) {
    return err(output.error);
  }
  const transactions = output.value.map(
    (ixs): BuildTransactionsType => ({
      ixs: ixs.instructions,
      connectionOrRbh,
      lookupTables: ixs.lookupTables,
    })
  );
  return ok(
    await buildAndSignTransactionsFromIxWithSigners(transactions, feePayer)
  );
}

function lengthToCompact16size(size: number): number {
  if (size > 0x7f) {
    return 2;
  } else {
    return 1;
  }
}
