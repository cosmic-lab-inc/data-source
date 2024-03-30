import {
  BlockhashWithExpiryBlockHeight,
  Commitment,
  GetBlockHeightConfig,
  GetLatestBlockhashConfig,
  RpcResponseAndContext,
  SendOptions,
  SignatureResult,
  SignatureStatus,
  SignatureStatusConfig,
  TransactionConfirmationStrategy,
  TransactionSignature,
} from '@solana/web3.js';
import { Buffer } from 'buffer';

export interface TransactionSender {
  commitment: Commitment | undefined;

  getBlockHeight(
    commitmentOrConfig?: Commitment | GetBlockHeightConfig
  ): Promise<number>;

  sendRawTransaction(
    rawTransaction: Buffer | Uint8Array | Array<number>,
    options?: SendOptions
  ): Promise<TransactionSignature>;

  getSignatureStatuses(
    signatures: Array<TransactionSignature>,
    config?: SignatureStatusConfig
  ): Promise<RpcResponseAndContext<Array<SignatureStatus | null>>>;

  getLatestBlockhash(
    commitmentOrConfig?: Commitment | GetLatestBlockhashConfig
  ): Promise<BlockhashWithExpiryBlockHeight>;

  confirmTransaction(
    strategy: TransactionConfirmationStrategy,
    commitment?: Commitment
  ): Promise<RpcResponseAndContext<SignatureResult>>;
}
