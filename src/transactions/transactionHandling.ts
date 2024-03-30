import { ed25519 } from '@noble/curves/ed25519';
import {
  AddressLookupTableAccount,
  BlockhashWithExpiryBlockHeight,
  Commitment,
  CompileV0Args,
  Connection,
  Finality,
  GetAccountKeysArgs,
  MessageAccountKeys,
  MessageV0,
  PublicKey,
  RpcResponseAndContext,
  SendOptions,
  SerializeConfig,
  SignatureResult,
  TransactionError,
  TransactionInstruction,
  TransactionSignature,
  VersionedMessage,
  VersionedTransaction,
  type Transaction,
} from '@solana/web3.js';
import assert from 'assert';
import bs58 from 'bs58';
import { Result, err, ok } from 'neverthrow';
import { AsyncSigner } from '../asyncSigner';
import { normalizeArray } from '../util';
import { TransactionSender } from './transactionSender';

export type AnyTransaction = VersionedTransaction | Transaction;

export function isVersionedTransaction(
  transaction: Transaction | VersionedTransaction
): transaction is VersionedTransaction {
  return 'version' in transaction;
}

export function verifySignatures(tx: AnyTransaction) {
  if (isVersionedTransaction(tx)) {
    const serializedMessage = tx.message.serialize();
    for (const [index, signature] of tx.signatures.entries()) {
      const key = tx.message.staticAccountKeys[index];
      if (signature.every((byte) => byte === 0)) {
        throw new Error(
          `Missing required signature for key ${key} at index ${index}`
        );
      } else if (!ed25519.verify(signature, serializedMessage, key.toBytes())) {
        throw new Error(`Signature ${index} failed to verify for key ${key}`);
      }
    }
  } else {
    tx.serialize();
  }
}

export function getSignature(
  tx: AnyTransaction
): TransactionSignature | undefined {
  const sig = isVersionedTransaction(tx) ? tx.signatures[0] : tx.signature;
  return sig ? bs58.encode(sig) : undefined;
}

export type TransactionReturn<T extends AnyTransaction = VersionedTransaction> =
  {
    transaction: T;
    rbh: BlockhashWithExpiryBlockHeight;
    commitment: Commitment;
  };

export type InstructionWithSigners = {
  instruction: TransactionInstruction;
  signers: AsyncSigner[];
};

export type InstructionReturn = (
  funder: AsyncSigner
) => Promise<InstructionWithSigners | InstructionWithSigners[]>;

export function ixToIxReturn(ix: TransactionInstruction): InstructionReturn {
  // eslint-disable-next-line require-await
  return async () => ({
    signers: [],
    instruction: ix,
  });
}

export async function ixReturnsToIxs(
  ixReturns: InstructionReturn | InstructionReturn[],
  feePayer: AsyncSigner
): Promise<TransactionInstruction[]> {
  const ixs = await Promise.all(
    normalizeArray(ixReturns).map((ixReturn) => ixReturn(feePayer))
  );
  return ixs.flat().map((ix) => ix.instruction);
}

export type ConnectionOrRbh =
  | { connection: TransactionSender; commitment?: Commitment }
  | { rbh: BlockhashWithExpiryBlockHeight; commitment: Commitment };

export type BuildTransactionsType<
  T = InstructionWithSigners | InstructionWithSigners[]
> = {
  ixs: T;
  connectionOrRbh: ConnectionOrRbh;
  lookupTables?: AddressLookupTableAccount[];
};

export type SendTransactionOptions = {
  commitment?: Finality;
  sendOptions?: SendOptions;
};

export async function buildAndSignTransaction(
  instructions: InstructionReturn | InstructionReturn[],
  feePayer: AsyncSigner,
  connectionOrRbh: ConnectionOrRbh,
  lookupTables: AddressLookupTableAccount[] = []
): Promise<TransactionReturn> {
  const out = (
    await buildAndSignTransactions(
      [{ ixs: instructions, connectionOrRbh, lookupTables }],
      feePayer
    )
  )[0];
  if (out === undefined) {
    throw new Error('Transaction was not built correctly');
  }
  return out;
}

export async function buildAndSignTransactions(
  transactions: BuildTransactionsType<
    InstructionReturn | InstructionReturn[]
  >[],
  feePayer: AsyncSigner
): Promise<TransactionReturn[]> {
  return await buildAndSignTransactionsFromIxWithSigners(
    await Promise.all(
      transactions.map(async ({ ixs, connectionOrRbh, lookupTables }) => {
        return {
          ixs: normalizeArray(
            await Promise.all(normalizeArray(ixs).map((ix) => ix(feePayer)))
          ).flat(),
          connectionOrRbh,
          lookupTables,
        };
      })
    ),
    feePayer
  );
}

export function formatExplorerMessageLink(
  transaction: AnyTransaction,
  connection: Connection
): string {
  const clusterUrl = encodeURIComponent(connection.rpcEndpoint);
  let serializedMessage: Buffer;
  if (isVersionedTransaction(transaction)) {
    serializedMessage = Buffer.from(transaction.message.serialize());
  } else {
    serializedMessage = transaction.serializeMessage();
  }
  const message = encodeURIComponent(serializedMessage.toString('base64'));
  return `https://explorer.solana.com/tx/inspector?message=${message}&cluster=custom&customUrl=${clusterUrl}`;
}

export function formatExplorerLink(
  signature: TransactionSignature | string,
  connection: Connection
): string {
  const clusterUrl = encodeURIComponent(connection.rpcEndpoint);
  return `https://explorer.solana.com/tx/${signature}?cluster=custom&customUrl=${clusterUrl}`;
}

export type SignerMap = Map<string, SignerEntry>;
export type SignerEntry = { signer: AsyncSigner; transactions: Set<number> };
export type BuildTransactionReturn = Omit<TransactionReturn, 'transaction'> & {
  compileArgs: CompileV0Args;
};

export function convertBuildTransactionReturn(
  tx: BuildTransactionReturn
): TransactionReturn {
  const message = MessageV0.compile(tx.compileArgs);
  const transaction = new VersionedTransaction(message);
  return {
    ...tx,
    transaction,
  };
}

export async function buildTransactionsFromIxWithSigners(
  transactions: BuildTransactionsType[],
  feePayer: { signer: AsyncSigner } | { key: PublicKey }
): Promise<{
  tx: BuildTransactionReturn[];
  signers: SignerMap;
}> {
  const signers: SignerMap = new Map();

  if ('signer' in feePayer) {
    const feePayerKey = feePayer.signer.publicKey().toBase58();
    const feePayerEntry: SignerEntry = {
      signer: feePayer.signer,
      transactions: new Set(),
    };

    for (let x = 0; x < transactions.length; x++) {
      feePayerEntry.transactions.add(x);
    }

    signers.set(feePayerKey, feePayerEntry);
  }

  const feePayerKey =
    'signer' in feePayer ? feePayer.signer.publicKey() : feePayer.key;

  return {
    tx: await Promise.all(
      transactions.map(
        async ({ ixs: ixArray, connectionOrRbh, lookupTables }, index) => {
          const instructions = normalizeArray(ixArray);
          for (const signer of instructions.flatMap((ix) => ix.signers)) {
            const key = signer.publicKey().toBase58();
            const signerEntry = signers.get(key);

            if (signerEntry === undefined) {
              signers.set(key, { signer, transactions: new Set([index]) });
            } else {
              signerEntry.transactions.add(index);
            }
          }

          let rbh: BlockhashWithExpiryBlockHeight;
          let commitment: Commitment;

          if ('connection' in connectionOrRbh) {
            rbh = await connectionOrRbh.connection.getLatestBlockhash(
              connectionOrRbh.commitment
            );
            commitment =
              connectionOrRbh.commitment ||
              connectionOrRbh.connection.commitment ||
              'processed';
          } else {
            rbh = connectionOrRbh.rbh;
            commitment = connectionOrRbh.commitment;
          }
          const ixs = instructions.map((ix) => ix.instruction);

          const returnArgs: BuildTransactionReturn = {
            compileArgs: {
              addressLookupTableAccounts: lookupTables,
              instructions: [...ixs],
              payerKey: feePayerKey,
              recentBlockhash: rbh.blockhash,
            },
            commitment,
            rbh,
          };
          return returnArgs;
        }
      )
    ),
    signers,
  };
}

export async function signTransactionReturns<T extends AnyTransaction>(
  unsignedTransactions: TransactionReturn<T>[],
  signers: SignerMap
): Promise<TransactionReturn<T>[]> {
  const signTxns = async ({ signer, transactions }: SignerEntry) => {
    const txsToSign = unsignedTransactions
      .map((tx, index) => ({ tx, index }))
      .filter(({ index }) => transactions.has(index));
    const newTxs = await signer.signAll(
      txsToSign.map(({ tx }) => tx.transaction)
    );
    assert(newTxs.length === txsToSign.length);
    for (let x = 0; x < txsToSign.length; x++) {
      unsignedTransactions[txsToSign[x].index].transaction = newTxs[x];
    }
  };

  for (const signer of signers.values()) {
    if (signer.signer.requiresAsync()) {
      await signTxns(signer);
    }
  }
  for (const signer of signers.values()) {
    if (!signer.signer.requiresAsync()) {
      await signTxns(signer);
    }
  }

  return unsignedTransactions;
}

export async function buildAndSignTransactionsFromIxWithSigners(
  transactions: BuildTransactionsType[],
  feePayer: AsyncSigner
): Promise<TransactionReturn[]> {
  const { tx: unsignedMessage, signers } =
    await buildTransactionsFromIxWithSigners(transactions, {
      signer: feePayer,
    });
  const unsignedTransactions = unsignedMessage.map((tx) =>
    convertBuildTransactionReturn(tx)
  );
  return signTransactionReturns(unsignedTransactions, signers);
}

/**
 * @deprecated Use {@link sendTransaction} instead.
 */
export async function sendAndConfirmTransaction(
  tx: TransactionReturn,
  connection: TransactionSender,
  sendOptions?: SendOptions,
  serializeConfig?: SerializeConfig
): Promise<{
  signature: TransactionSignature;
  signatureResult: SignatureResult;
}> {
  const signature = await connection.sendRawTransaction(
    tx.transaction.serialize(),
    sendOptions
  );
  return {
    signature,
    signatureResult: (
      await connection.confirmTransaction(
        { ...tx.rbh, signature: signature },
        tx.commitment
      )
    ).value,
  };
}

/**
 * Sends and confirms a transaction
 * @param transaction The transaction to send
 * @param connection The connection to send the transaction to
 * @param options Options to send transaction
 * @param retryInterval How often to resend the transaction before it's confirmed, in ms. Default is 3000
 * @param maxRetries How many times to retry before giving up. Default is 10
 */
export async function sendTransaction(
  transaction: TransactionReturn<AnyTransaction>,
  connection: TransactionSender,
  options?: SendTransactionOptions,
  retryInterval = 3000,
  maxRetries = 10
): Promise<
  RpcResponseAndContext<Result<TransactionSignature, TransactionError>>
> {
  const rawTransaction = transaction.transaction.serialize();
  if (isVersionedTransaction(transaction.transaction)) {
    verifySignatures(transaction.transaction);
  }
  const commitment = options?.commitment || 'confirmed';

  const signature = await connection.sendRawTransaction(
    rawTransaction,
    options?.sendOptions
  );

  let count = 0;
  const interval = setInterval(() => {
    if (count < maxRetries) {
      void connection.sendRawTransaction(rawTransaction, {
        ...options?.sendOptions,
        skipPreflight: true,
      });
    }
    count++;
  }, retryInterval);

  let result;
  try {
    result = await connection.confirmTransaction(
      {
        signature,
        ...transaction.rbh,
      },
      commitment
    );
  } finally {
    clearInterval(interval);
  }

  if (result.value.err !== null) {
    return { context: result.context, value: err(result.value.err) };
  } else {
    return { context: result.context, value: ok(signature) };
  }
}

/**
 * @deprecated Use {@link buildAndSignTransaction} and {@link sendTransaction} instead.
 * @param instructions
 * @param feePayer
 * @param connection
 * @param options
 * @param lookupTables
 */
export async function buildSendAndCheck(
  instructions: InstructionReturn | InstructionReturn[],
  feePayer: AsyncSigner,
  connection: Connection,
  options?: {
    commitment?: Finality;
    sendOptions?: SendOptions;
    serializeConfig?: SerializeConfig;
    suppressLogging?: boolean;
    postTransactionHandler?: (
      tx: TransactionReturn
    ) => TransactionReturn | void;
  },
  lookupTables?: AddressLookupTableAccount[]
): Promise<TransactionSignature> {
  instructions = normalizeArray(instructions);
  const commitment = options?.commitment || 'confirmed';
  let tx = await buildAndSignTransaction(
    instructions,
    feePayer,
    {
      connection,
      commitment,
    },
    lookupTables
  );
  if (options?.postTransactionHandler) {
    const newTx = options.postTransactionHandler(tx);
    if (newTx) {
      tx = newTx;
    }
  }
  const { signature, signatureResult } = await sendAndConfirmTransaction(
    tx,
    connection,
    {
      skipPreflight: false,
      ...options?.sendOptions,
    },
    options?.serializeConfig
  );
  if (signatureResult.err !== null) {
    if (!options?.suppressLogging) {
      console.error('Transaction signature: ', signature);
      const transaction = await connection.getTransaction(signature, {
        commitment,
        maxSupportedTransactionVersion: 1,
      });
      console.error('Transaction logs: ', transaction?.meta?.logMessages);
      console.error(
        `Explorer link: ${formatExplorerLink(signature, connection)}`
      );
    }
    throw new Error(
      'Transaction error: ' + JSON.stringify(signatureResult.err, null, 2)
    );
  } else if (
    options != undefined &&
    options.suppressLogging != undefined &&
    !options.suppressLogging
  ) {
    // Please don't delete this xD. Is for the case we want to print the logs even if the IX success
    console.info('Transaction signature: ', signature);
    const transaction = await connection.getTransaction(signature, {
      commitment,
      maxSupportedTransactionVersion: 1,
    });
    // transaction?.transaction.message.getAccountKeys();
    console.info('Transaction logs: ', transaction?.meta?.logMessages);
  }
  return signature;
}

export type PrettyTransaction = {
  instructions: PrettyInstruction[];
  signatures: PrettySignature[];
  feePayer: string | undefined;
  recentBlockhash: string | undefined;
};

export type PrettyInstruction = {
  keys: {
    isSigner: boolean;
    isWritable: boolean;
    pubkey: string | undefined;
  }[];
  programId: string | undefined;
};

export type PrettySignature = {
  signature: boolean;
  publicKey: string | undefined;
};

export function prettyTransaction(
  tx: AnyTransaction,
  accountKeyArgs?: GetAccountKeysArgs
): PrettyTransaction {
  if (isVersionedTransaction(tx)) {
    const accountKeys = tx.message.getAccountKeys(accountKeyArgs);
    return {
      signatures: prettySignature(tx.signatures, accountKeys),
      instructions: prettyInstructions(tx.message, accountKeys),
      feePayer: tx.message.staticAccountKeys[0].toBase58(),
      recentBlockhash: tx.message.recentBlockhash,
    };
  } else {
    return {
      signatures: tx.signatures.map((sig) => ({
        publicKey: sig.publicKey.toBase58(),
        signature: sig.signature !== null,
      })),
      instructions: tx.instructions.map((ix) => ({
        keys: ix.keys.map((meta) => ({
          ...meta,
          pubkey: meta.pubkey.toBase58(),
        })),
        programId: ix.programId.toBase58(),
      })),
      feePayer: tx.feePayer?.toBase58(),
      recentBlockhash: tx.recentBlockhash,
    };
  }
}

function prettySignature(
  signatures: Uint8Array[],
  accountKeys: MessageAccountKeys
): PrettySignature[] {
  return signatures.map((sig, index) => ({
    publicKey: accountKeys.get(index)?.toBase58(),
    signature: sig.every((byte) => byte !== 0),
  }));
}

function prettyInstructions(
  message: VersionedMessage,
  accountKeys: MessageAccountKeys
): PrettyInstruction[] {
  return message.compiledInstructions.map((ix) => ({
    keys: ix.accountKeyIndexes.map((keyIndex) => {
      const key = accountKeys.get(keyIndex);
      return {
        pubkey: key?.toBase58(),
        isSigner: message.isAccountSigner(keyIndex),
        isWritable: message.isAccountWritable(keyIndex),
      };
    }),
    programId: accountKeys.get(ix.programIdIndex)?.toBase58(),
  }));
}
