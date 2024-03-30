import { PublicKey, SystemProgram } from '@solana/web3.js';
import { AsyncSigner } from './asyncSigner';
import { InstructionReturn } from './transactions';

export function transfer(
  from: AsyncSigner | null,
  to: PublicKey,
  lamports: number
): InstructionReturn {
  return (funder) =>
    Promise.resolve({
      instruction: SystemProgram.transfer({
        fromPubkey: from?.publicKey() ?? funder.publicKey(),
        toPubkey: to,
        lamports,
      }),
      signers: [from ?? funder],
    });
}
