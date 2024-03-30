import {
  AddressLookupTableProgram,
  Connection,
  MessageV0,
  PublicKey,
  TransactionError,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { Err, Result, err, ok } from 'neverthrow';
import { AsyncSigner } from './asyncSigner';
import {
  InstructionReturn,
  SendTransactionOptions,
  buildDynamicTransactions,
  sendTransaction,
} from './transactions';

export async function createAddressLookupTable(
  connection: Connection,
  authority: AsyncSigner,
  feePayer: AsyncSigner,
  recentSlot?: number,
  options?: SendTransactionOptions
): Promise<Result<PublicKey, TransactionError>> {
  const [createLutIx, newLutKey] = AddressLookupTableProgram.createLookupTable({
    authority: authority.publicKey(),
    payer: feePayer.publicKey(),
    recentSlot: recentSlot ?? (await connection.getSlot('confirmed')),
  });

  const recentBlockhash = await connection.getLatestBlockhash('confirmed');
  const createTx = new VersionedTransaction(
    MessageV0.compile({
      payerKey: feePayer.publicKey(),
      instructions: [createLutIx],
      recentBlockhash: recentBlockhash.blockhash,
    })
  );
  await authority.sign(createTx);
  await feePayer.sign(createTx);
  const txResponse = await sendTransaction(
    {
      transaction: createTx,
      rbh: recentBlockhash,
      commitment: 'confirmed',
    },
    connection,
    {
      ...options,
      // Creating LUT fails in preflight check
      sendOptions: {
        skipPreflight: true,
      },
    }
  );

  if (txResponse.value.isErr()) {
    return err(
      `Failed to create address lookup table: ${txResponse.value.error}`
    );
  }

  return ok(newLutKey);
}

export type ExtendTransactionOptions = SendTransactionOptions & {
  awaitNewSlot?: boolean;
};

const MS_PER_SLOT = 400;

export async function extendAddressLookupTable(
  connection: Connection,
  lookupTable: PublicKey,
  authority: AsyncSigner,
  feePayer: AsyncSigner,
  addresses: PublicKey[],
  options?: ExtendTransactionOptions
): Promise<Result<PublicKey, TransactionError>> {
  if (addresses.length > 256) {
    return err('Transaction lookup table can only hold up to 256 addresses');
  }
  const addressesClone = [...addresses];
  const instructions: TransactionInstruction[] = [];

  while (addressesClone.length > 0) {
    const chunk = addressesClone.splice(0, 20);
    const extendLutIx = AddressLookupTableProgram.extendLookupTable({
      lookupTable: lookupTable,
      authority: authority.publicKey(),
      payer: feePayer.publicKey(),
      addresses: chunk,
    });
    instructions.push(extendLutIx);
  }

  const instructionReturns: InstructionReturn[] = instructions.map((ix) => {
    return (payer) =>
      Promise.resolve({
        instruction: ix,
        signers: [payer, feePayer, authority],
      });
  });

  const txReturns = await buildDynamicTransactions(
    instructionReturns,
    feePayer,
    {
      connection,
      commitment: options?.commitment ?? 'confirmed',
    }
  );

  if (txReturns.isErr()) {
    return new Err(`Failed to build dynamic transactions: ${txReturns.error}`);
  }
  const results = await Promise.all(
    txReturns.value.map((txn) => {
      return sendTransaction(txn, connection, options);
    })
  );

  const error = results.find((txResponse) => txResponse.value.isErr());
  if (error) {
    return err(`Failed to extend address lookup table: ${error.value}`);
  }

  if (options?.awaitNewSlot) {
    const slots = results.map((txResponse) => txResponse.context.slot);
    const newestSlotNum = Math.max(...slots);
    // wait for 1 slot to pass for extended lookup table to be usable
    const commitment = options?.commitment ?? 'confirmed';
    while ((await connection.getSlot(commitment)) <= newestSlotNum) {
      await new Promise((resolve) => setTimeout(resolve, MS_PER_SLOT / 2));
    }
  }

  return ok(lookupTable);
}

export async function createAndExtendAddressLookupTable(
  connection: Connection,
  authority: AsyncSigner,
  feePayer: AsyncSigner,
  addresses: PublicKey[],
  recentSlot?: number,
  options?: ExtendTransactionOptions
): Promise<Result<PublicKey, TransactionError>> {
  const lookupTable = await createAddressLookupTable(
    connection,
    authority,
    feePayer,
    recentSlot,
    options
  );
  if (lookupTable.isErr()) {
    return lookupTable;
  }

  return await extendAddressLookupTable(
    connection,
    lookupTable.value,
    authority,
    feePayer,
    addresses,
    options
  );
}
