import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { PromisePool } from '@supercharge/promise-pool';
import {
  AsyncSigner,
  InstructionReturn,
  airdrop,
  buildAndSignTransaction,
  buildAndSignTransactions,
  buildDynamicTransactions,
  buildLookupTableSet,
  createAndExtendAddressLookupTable,
  getTransactionSize,
  keypairToAsyncSigner,
  normalizeArray,
  sendTransaction,
  transfer,
} from '../src';

describe('transaction', () => {
  const connection = new Connection('http://localhost:8899', 'confirmed');

  beforeAll(async () => {
    try {
      await airdrop(connection, Keypair.generate().publicKey);
    } catch (e) {
      console.log('Cannot connect to local validator', e);
    }
  });

  it('buildAndSignTransaction', async () => {
    const funder = keypairToAsyncSigner(Keypair.generate());
    const from = keypairToAsyncSigner(Keypair.generate());
    await Promise.all([
      airdrop(connection, funder.publicKey()),
      airdrop(connection, from.publicKey()),
    ]);

    const to = Keypair.generate().publicKey;
    const ixs = transfer(from, to, LAMPORTS_PER_SOL / 2);

    const signedTx = await buildAndSignTransaction(ixs, funder, { connection });

    const result = await sendTransaction(signedTx, connection);

    expect(
      result.value.isOk(),
      'result: ' + JSON.stringify(result)
    ).toBeTruthy();
  });

  it('buildAndSignTransactions', async () => {
    const funder = keypairToAsyncSigner(Keypair.generate());
    const from: AsyncSigner<Keypair>[] = new Array(100).fill(0).map(() => {
      const signer = keypairToAsyncSigner(Keypair.generate());
      let signerCount = 0;
      return {
        inner: signer.inner,
        signAll<T extends Transaction | VersionedTransaction>(
          txs: T[]
        ): Promise<T[]> {
          signerCount += 1;
          if (signerCount > 1) {
            throw new Error('signer called more than once');
          }
          return signer.signAll(txs);
        },
        sign<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
          signerCount += 1;
          if (signerCount > 1) {
            throw new Error('signer called more than once');
          }
          return signer.sign(tx);
        },
        publicKey: signer.publicKey,
        requiresAsync: signer.requiresAsync,
        signMessage: signer.signMessage,
      };
    });
    await Promise.all([
      airdrop(connection, funder.publicKey()),
      ...from.map((f) => airdrop(connection, f.publicKey())),
    ]);

    const to = Keypair.generate().publicKey;
    const ixs = from.map((from) => transfer(from, to, LAMPORTS_PER_SOL / 2));

    const signedTxs = await buildAndSignTransactions(
      ixs.map((ixs) => ({ ixs, connectionOrRbh: { connection } })),
      funder
    );

    const results = await Promise.all(
      signedTxs.map((signedTx) => sendTransaction(signedTx, connection))
    );

    for (const result of results) {
      expect(
        result.value.isOk(),
        'result: ' + JSON.stringify(result)
      ).toBeTruthy();
    }
  });

  it('size estimate', async () => {
    const funder = keypairToAsyncSigner(Keypair.generate());
    await airdrop(connection, funder.publicKey(), LAMPORTS_PER_SOL * 10);
    const from = new Array(10)
      .fill(0)
      .map(() => keypairToAsyncSigner(Keypair.generate()));
    await Promise.all(
      from.map((f) => airdrop(connection, f.publicKey(), LAMPORTS_PER_SOL * 10))
    );
    const to = new Array(10).fill(0).map(() => Keypair.generate().publicKey);

    const testTx = async (
      ixs: InstructionReturn | InstructionReturn[],
      lookupTables?: AddressLookupTableAccount
    ) => {
      const ixsWithSigners = (
        await Promise.all(
          normalizeArray(ixs).map(async (ix) =>
            normalizeArray(await ix(funder))
          )
        )
      ).flat();
      const lookupTableArray = lookupTables ? [lookupTables] : [];
      const estimate = getTransactionSize(
        ixsWithSigners,
        funder.publicKey(),
        buildLookupTableSet(lookupTableArray)
      );
      const tx = await buildAndSignTransaction(
        ixs,
        funder,
        { connection },
        lookupTableArray
      );
      const serialized = tx.transaction.serialize();
      const realSize = serialized.length;
      const from = tx.transaction;

      return () =>
        expect(
          estimate.size,
          'Estimate: ' +
            estimate +
            ' real: ' +
            realSize +
            ' tx: ' +
            JSON.stringify(tx.transaction, null, 2) +
            ' from: ' +
            JSON.stringify(from, null, 2)
        ).toEqual(realSize);
    };

    const lookupTables = (
      await createAndExtendAddressLookupTable(connection, funder, funder, [
        ...from.map((f) => f.publicKey()),
        ...to,
        funder.publicKey(),
        SystemProgram.programId,
      ])
    )._unsafeUnwrap();
    (await testTx(transfer(from[0], to[0], LAMPORTS_PER_SOL)))();
    (
      await testTx([
        transfer(from[0], to[0], LAMPORTS_PER_SOL),
        transfer(from[2], to[0], LAMPORTS_PER_SOL),
        transfer(from[5], to[1], LAMPORTS_PER_SOL),
        transfer(from[0], to[0], LAMPORTS_PER_SOL),
        transfer(from[1], to[0], LAMPORTS_PER_SOL),
      ])
    )();
    (
      await testTx([
        transfer(from[0], to[0], LAMPORTS_PER_SOL),
        transfer(from[1], to[1], LAMPORTS_PER_SOL),
      ])
    )();
    (
      await testTx([
        transfer(from[0], to[0], LAMPORTS_PER_SOL),
        transfer(from[1], funder.publicKey(), LAMPORTS_PER_SOL),
      ])
    )();
    (
      await testTx([
        transfer(from[0], to[0], LAMPORTS_PER_SOL),
        transfer(from[1], to[0], LAMPORTS_PER_SOL),
        () =>
          Promise.resolve({
            instruction: new TransactionInstruction({
              keys: [],
              programId: funder.publicKey(),
              data: Buffer.alloc(100),
            }),
            signers: [],
          }),
      ])
    )();
    const lookupTable = (await connection.getAddressLookupTable(lookupTables))
      .value;
    if (lookupTable === null) {
      fail('lookupTable is null');
    }
    (
      await testTx(
        [
          transfer(from[0], to[1], LAMPORTS_PER_SOL),
          transfer(from[1], to[2], LAMPORTS_PER_SOL),
          transfer(from[2], to[3], LAMPORTS_PER_SOL),
          transfer(from[3], to[4], LAMPORTS_PER_SOL),
          transfer(from[4], to[5], LAMPORTS_PER_SOL),
          transfer(from[5], to[6], LAMPORTS_PER_SOL),
          transfer(from[6], to[7], LAMPORTS_PER_SOL),
          transfer(from[7], to[8], LAMPORTS_PER_SOL),
          transfer(from[8], to[9], LAMPORTS_PER_SOL),
          transfer(from[9], to[0], LAMPORTS_PER_SOL),
          () =>
            Promise.resolve({
              instruction: new TransactionInstruction({
                keys: [],
                programId: funder.publicKey(),
                data: Buffer.alloc(100),
              }),
              signers: [],
            }),
        ],
        lookupTable
      )
    )();
    (
      await testTx(
        [
          transfer(from[0], to[1], LAMPORTS_PER_SOL),
          transfer(from[1], to[2], LAMPORTS_PER_SOL),
          transfer(from[2], to[3], LAMPORTS_PER_SOL),
          () =>
            Promise.resolve({
              instruction: new TransactionInstruction({
                keys: [],
                programId: funder.publicKey(),
                data: Buffer.alloc(900),
              }),
              signers: [],
            }),
        ],
        lookupTable
      )
    )();
  });

  it('buildDynamicTransactions', async () => {
    const funder = keypairToAsyncSigner(Keypair.generate());
    const from: AsyncSigner<Keypair>[] = new Array(100).fill(0).map(() => {
      const signer = keypairToAsyncSigner(Keypair.generate());
      let signerCount = 0;
      return {
        inner: signer.inner,
        signAll<T extends Transaction | VersionedTransaction>(
          txs: T[]
        ): Promise<T[]> {
          signerCount += 1;
          if (signerCount > 1) {
            throw new Error('signer called more than once');
          }
          return signer.signAll(txs);
        },
        sign<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
          signerCount += 1;
          if (signerCount > 1) {
            throw new Error('signer called more than once');
          }
          return signer.sign(tx);
        },
        publicKey: signer.publicKey,
        requiresAsync: signer.requiresAsync,
        signMessage: signer.signMessage,
      };
    });
    await Promise.all([
      airdrop(connection, funder.publicKey()),
      ...from.map((f) => airdrop(connection, f.publicKey())),
    ]);

    const to = Keypair.generate().publicKey;
    const ixs = from.map((from) => transfer(from, to, LAMPORTS_PER_SOL / 2));

    const signedTxs = (
      await buildDynamicTransactions(ixs, funder, {
        connection,
      })
    )._unsafeUnwrap();

    const results = await Promise.all(
      signedTxs.map((signedTx) => sendTransaction(signedTx, connection))
    );

    for (const result of results) {
      expect(
        result.value.isOk(),
        'result: ' + JSON.stringify(result)
      ).toBeTruthy();
    }
  });

  it('buildDynamicTransactions with sandwich', async () => {
    const funder = keypairToAsyncSigner(Keypair.generate());
    const from: AsyncSigner<Keypair>[] = new Array(100).fill(0).map(() => {
      const signer = keypairToAsyncSigner(Keypair.generate());
      let signerCount = 0;
      return {
        inner: signer.inner,
        signAll<T extends Transaction | VersionedTransaction>(
          txs: T[]
        ): Promise<T[]> {
          signerCount += 1;
          if (signerCount > 1) {
            throw new Error('signer called more than once');
          }
          return signer.signAll(txs);
        },
        sign<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
          signerCount += 1;
          if (signerCount > 1) {
            throw new Error('signer called more than once');
          }
          return signer.sign(tx);
        },
        publicKey: signer.publicKey,
        requiresAsync: signer.requiresAsync,
        signMessage: signer.signMessage,
      };
    });
    await Promise.all([
      airdrop(connection, funder.publicKey()),
      ...from.map((f) => airdrop(connection, f.publicKey())),
    ]);

    const to = Keypair.generate().publicKey;
    const ixs = from.map((from) => transfer(from, to, LAMPORTS_PER_SOL / 2));

    const signedTxs = (
      await buildDynamicTransactions(
        ixs,
        funder,
        {
          connection,
        },
        transfer(funder, to, 100),
        transfer(funder, to, 100)
      )
    )._unsafeUnwrap();

    const results = await Promise.all(
      signedTxs.map((signedTx) => sendTransaction(signedTx, connection))
    );

    for (const result of results) {
      expect(
        result.value.isOk(),
        'result: ' + JSON.stringify(result)
      ).toBeTruthy();
    }
  });

  it('test send retry logic', async () => {
    const funder = keypairToAsyncSigner(Keypair.generate());
    console.log("Funder's public key: " + funder.publicKey().toBase58());
    const from: AsyncSigner<Keypair>[] = new Array(3000).fill(0).map(() => {
      return keypairToAsyncSigner(Keypair.generate());
    });
    await Promise.all([
      airdrop(connection, funder.publicKey()),
      ...from.map((f) => airdrop(connection, f.publicKey())),
    ]);

    const to = Keypair.generate().publicKey;
    const signedTransactions = await Promise.all(
      from.map((from) => {
        const ix = transfer(from, to, LAMPORTS_PER_SOL / 2);
        return buildAndSignTransaction(ix, funder, {
          connection,
        });
      })
    );

    const now = Date.now();
    const currentSlot = await connection.getSlot();
    console.log(`Current slot: ${currentSlot}`);
    const results = await PromisePool.withConcurrency(1000)
      .for(signedTransactions)
      .process(async (signedTx) => {
        return await sendTransaction(signedTx, connection);
      });

    expect(results.errors).toHaveLength(0);

    console.log(
      `Sent ${signedTransactions.length} transactions in ${Date.now() - now}ms!`
    );

    for (const result of results.results) {
      expect(
        result.value.isOk(),
        'result: ' + JSON.stringify(result)
      ).toBeTruthy();
    }
  }, 100000);

  it('buildDynamicTransactionsWithLUT', async () => {
    const funder = keypairToAsyncSigner(Keypair.generate());
    const KEY_COUNT = 250;
    await airdrop(connection, funder.publicKey(), LAMPORTS_PER_SOL * KEY_COUNT);
    const toKeys = Array(KEY_COUNT)
      .fill(0)
      .map(() => {
        return Keypair.generate().publicKey;
      });

    const lut = (
      await createAndExtendAddressLookupTable(
        connection,
        funder,
        funder,
        toKeys,
        undefined,
        {
          awaitNewSlot: true,
        }
      )
    )._unsafeUnwrap();

    const ixs = toKeys.map((to) => transfer(funder, to, LAMPORTS_PER_SOL / 10));

    const lookupTable = (await connection.getAddressLookupTable(lut)).value;
    if (lookupTable === null) {
      fail('lookupTable is null');
    }

    expect(lookupTable.state.addresses.length).toEqual(KEY_COUNT);

    const txReturns = (
      await buildDynamicTransactions(
        ixs,
        funder,
        { connection },
        [],
        [],
        [lookupTable]
      )
    )._unsafeUnwrap();
    const results = await Promise.all(
      txReturns.map((signedTx) => sendTransaction(signedTx, connection, {}))
    );
    // somewhere around ~60 accounts per txn?
    expect(results.length).toEqual(Math.ceil(KEY_COUNT / 59));
    for (const result of results) {
      expect(
        result.value.isOk(),
        'result: ' + JSON.stringify(result)
      ).toBeTruthy();
    }
  });

  it('buildDynamicTransactionsWithManyLUTs', async () => {
    const funder = keypairToAsyncSigner(Keypair.generate());
    await airdrop(connection, funder.publicKey(), LAMPORTS_PER_SOL * 100);
    const KEY_COUNT = 250;

    const toKeys = Array(KEY_COUNT)
      .fill(0)
      .map(() => {
        return Keypair.generate().publicKey;
      });

    const lut1 = toKeys.slice(0, 68); // 68, third, but only ~23 keys used
    const lut2 = toKeys.slice(25, 100); // 75, first
    const lut3 = toKeys.slice(68, 128); // 60, second, but only 28 keys used
    const lut4 = toKeys.slice(128); // only on 2nd

    const allLookupKeys = [lut1, lut2, lut3, lut4];
    const recentSlot = await connection.getSlot('confirmed');
    const lookupTablesIds = (
      await Promise.all(
        allLookupKeys.map((lut, index) => {
          return createAndExtendAddressLookupTable(
            connection,
            funder,
            funder,
            lut,
            recentSlot - index,
            {
              awaitNewSlot: true,
            }
          );
        })
      )
    ).map((lut) => lut._unsafeUnwrap());
    const maybeLookupTableAccounts = (
      await Promise.all(
        lookupTablesIds.map((lut) => {
          return connection.getAddressLookupTable(lut);
        })
      )
    ).map((lut) => lut.value);
    const lookupTableAccounts = maybeLookupTableAccounts.map((lut) => {
      if (lut === null) {
        fail('lookupTable is null');
      }
      return lut;
    });
    expect(lookupTableAccounts[0].state.addresses.length).toEqual(68);
    expect(lookupTableAccounts[1].state.addresses.length).toEqual(75);
    expect(lookupTableAccounts[2].state.addresses.length).toEqual(60);
    expect(lookupTableAccounts[3].state.addresses.length).toEqual(122);

    const toKeyChunks = [];
    while (toKeys.length > 0) {
      toKeyChunks.push(toKeys.splice(0, 8));
    }

    // system and funder for first ix from each expected txn
    toKeyChunks[0].splice(0, 2);
    toKeyChunks[16].splice(0, 2);

    const ixs = toKeyChunks.map((to) =>
      weirdTransfer(funder, to[0], LAMPORTS_PER_SOL / 2, to)
    );

    const txReturns = (
      await buildDynamicTransactions(
        ixs,
        funder,
        { connection },
        [],
        [],
        lookupTableAccounts
      )
    )._unsafeUnwrap();
    expect(txReturns.length).toEqual(2);

    const tableLookups = txReturns.map((tx) => {
      return (tx.transaction as VersionedTransaction).message
        .addressTableLookups;
    });
    const tableLookupKeys = tableLookups.map((tableLookup) => {
      return tableLookup.map((lookup) => lookup.accountKey);
    });
    const firstTableLookups = tableLookupKeys[0];
    expect(firstTableLookups.length).toEqual(3);
    // lookup table ordering based on greedy search
    expect(
      firstTableLookups[0].equals(lookupTableAccounts[1].key)
    ).toBeTruthy();
    expect(
      firstTableLookups[1].equals(lookupTableAccounts[2].key)
    ).toBeTruthy();
    expect(
      firstTableLookups[2].equals(lookupTableAccounts[0].key)
    ).toBeTruthy();

    const secondTableLookups = tableLookupKeys[1];
    expect(secondTableLookups.length).toEqual(1);
    expect(
      secondTableLookups[0].equals(lookupTableAccounts[3].key)
    ).toBeTruthy();

    const results = await Promise.all(
      txReturns.map((signedTx) =>
        sendTransaction(signedTx, connection, {
          sendOptions: { skipPreflight: true },
        })
      )
    );

    for (const result of results) {
      expect(
        result.value.isOk(),
        'result: ' + JSON.stringify(result)
      ).toBeTruthy();
    }
  });
});

function weirdTransfer(
  from: AsyncSigner | null,
  to: PublicKey,
  lamports: number,
  dumbKeys: PublicKey[]
): InstructionReturn {
  return (funder) => {
    const instruction = SystemProgram.transfer({
      fromPubkey: from?.publicKey() ?? funder.publicKey(),
      toPubkey: to,
      lamports,
    });
    instruction.keys.push(
      ...dumbKeys.map((key) => ({
        pubkey: key,
        isSigner: false,
        isWritable: false,
      }))
    );
    return Promise.resolve({
      instruction,
      signers: [from ?? funder],
    });
  };
}
