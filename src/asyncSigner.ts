import { Keypair, PublicKey, Signer } from '@solana/web3.js';
// Anchor has 2 wallets that are not compatible...
import { WalletContextState } from '@solana/wallet-adapter-react';
import { Wallet } from '@staratlas/anchor/dist/cjs/provider';
import nacl from 'tweetnacl';
import { AnyTransaction } from './transactions';

export interface AsyncSigner<T = unknown> {
  inner?(): T;

  requiresAsync(): boolean;

  publicKey(): PublicKey;

  sign<TT extends AnyTransaction>(tx: TT): Promise<TT>;

  signAll<TT extends AnyTransaction>(txs: TT[]): Promise<TT[]>;

  signMessage?(message: Uint8Array): Promise<Uint8Array>;
}

export function isAsyncSigner(obj: any): obj is AsyncSigner {
  return (
    'inner' in obj &&
    'requiresAsync' in obj &&
    'publicKey' in obj &&
    'sign' in obj &&
    'signAll' in obj
  );
}

function partialSign(tx: AnyTransaction, signer: Signer) {
  if ('instructions' in tx) {
    tx.partialSign(signer);
  } else {
    tx.sign([signer]);
  }
}

export function keypairToAsyncSigner(keypair: Keypair): AsyncSigner<Keypair> {
  return {
    inner: () => keypair,
    requiresAsync(): boolean {
      return false;
    },
    publicKey(): PublicKey {
      return keypair.publicKey;
    },
    sign: (tx) => {
      partialSign(tx, keypair);
      return Promise.resolve(tx);
    },
    signAll: (txs) => {
      for (const tx of txs) {
        partialSign(tx, keypair);
      }
      return Promise.resolve(txs);
    },
    signMessage: (msg) => {
      const signature = nacl.sign.detached(msg, keypair.secretKey);
      return Promise.resolve(signature);
    },
  };
}

export function walletAdapterToAsyncSigner(
  wallet: WalletContextState
): AsyncSigner<WalletContextState> {
  const publicKey = wallet.publicKey;
  const signTransaction = wallet.signTransaction;
  const signAllTransactions = wallet.signAllTransactions;
  const signMessage = wallet.signMessage;
  if (!publicKey || !signTransaction || !signAllTransactions || !signMessage) {
    throw new Error(
      'Failed to convert WalletContextState to AsyncSigner: missing required methods'
    );
  } else {
    return {
      inner(): WalletContextState {
        return wallet;
      },
      publicKey(): PublicKey {
        return publicKey;
      },
      requiresAsync(): boolean {
        return true;
      },
      sign<T extends AnyTransaction>(tx: T): Promise<T> {
        return signTransaction(tx);
      },
      signAll<T extends AnyTransaction>(txs: T[]): Promise<T[]> {
        return signAllTransactions(txs);
      },
      signMessage: (msg) => {
        return signMessage(msg);
      },
    };
  }
}

export function walletToAsyncSigner(wallet: Wallet): AsyncSigner<Wallet> {
  return {
    inner(): Wallet {
      return wallet;
    },
    publicKey(): PublicKey {
      return wallet.publicKey;
    },
    requiresAsync(): boolean {
      return true;
    },
    sign<T extends AnyTransaction>(tx: T): Promise<T> {
      return wallet.signTransaction(tx);
    },
    signAll<T extends AnyTransaction>(txs: T[]): Promise<T[]> {
      return wallet.signAllTransactions(txs);
    },
  };
}

export function signerToAsyncSigner<T extends Signer>(
  signer: T
): AsyncSigner<T> {
  return {
    inner: () => signer,
    publicKey: () => signer.publicKey,
    requiresAsync: () => false,
    sign: <TT extends AnyTransaction>(tx: TT) => {
      partialSign(tx, signer);
      return Promise.resolve(tx);
    },
    signAll: <TT extends AnyTransaction>(txs: TT[]) => {
      for (const tx of txs) {
        partialSign(tx, signer);
      }
      return Promise.resolve(txs);
    },
    signMessage: (msg) => {
      const signature = nacl.sign.detached(msg, signer.secretKey);
      return Promise.resolve(signature);
    },
  };
}

export function createDummyAsyncSigner(
  debugAddress: PublicKey
): AsyncSigner<never> {
  return {
    requiresAsync(): boolean {
      return false;
    },
    publicKey(): PublicKey {
      return debugAddress;
    },
    sign: (tx) => {
      tx.addSignature(debugAddress, Buffer.alloc(64));
      return Promise.resolve(tx);
    },
    signAll: (txs) => {
      for (const tx of txs) {
        tx.addSignature(debugAddress, Buffer.alloc(64));
      }
      return Promise.resolve(txs);
    },
  };
}
