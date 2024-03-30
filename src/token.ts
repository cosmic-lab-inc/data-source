import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AuthorityType,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  Account as TokenAccount,
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createInitializeAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from '@solana/spl-token';
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { AsyncSigner, InstructionReturn, calculateMinimumRent } from '.';

/**
 * Fetch all the parsed token accounts owned by the specified account
 *
 * Better than `connection.getTokenAccountsByOwner` or `connection.getParsedTokenAccountsByOwner`
 * as it properly decodes the token accounts using the more modern `unpackAccount`.
 *
 * @param connection - Solana connection object
 * @param owner - the token accounts owner
 * @param programId - the token program id
 * @returns the parsed token accounts for the given owner
 */
export const getParsedTokenAccountsByOwner = async (
  connection: Connection,
  owner: PublicKey,
  programId = TOKEN_PROGRAM_ID
): Promise<TokenAccount[]> => {
  return (
    await connection.getTokenAccountsByOwner(owner, {
      programId,
    })
  ).value.map((data) => unpackAccount(data.pubkey, data.account, programId));
};

export function createMint(
  mint: AsyncSigner,
  decimals: number,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null
): InstructionReturn {
  // eslint-disable-next-line require-await
  return async (funder) => [
    {
      instruction: SystemProgram.createAccount({
        fromPubkey: funder.publicKey(),
        lamports: calculateMinimumRent(MINT_SIZE),
        newAccountPubkey: mint.publicKey(),
        programId: TOKEN_PROGRAM_ID,
        space: MINT_SIZE,
      }),
      signers: [mint, funder],
    },
    {
      instruction: createInitializeMintInstruction(
        mint.publicKey(),
        decimals,
        mintAuthority,
        freezeAuthority
      ),
      signers: [],
    },
  ];
}

export function createTokenAccount(
  account: AsyncSigner,
  owner: PublicKey,
  mint: PublicKey
): InstructionReturn {
  // eslint-disable-next-line require-await
  return async (funder) => [
    {
      instruction: SystemProgram.createAccount({
        fromPubkey: funder.publicKey(),
        lamports: calculateMinimumRent(ACCOUNT_SIZE),
        newAccountPubkey: account.publicKey(),
        programId: TOKEN_PROGRAM_ID,
        space: ACCOUNT_SIZE,
      }),
      signers: [account, funder],
    },
    {
      instruction: createInitializeAccountInstruction(
        account.publicKey(),
        mint,
        owner
      ),
      signers: [],
    },
  ];
}

export function mintToTokenAccount(
  mintAuthority: AsyncSigner,
  mint: PublicKey,
  tokenAccount: PublicKey,
  amount: number
): InstructionReturn {
  // eslint-disable-next-line require-await
  return async () => ({
    instruction: createMintToInstruction(
      mint,
      tokenAccount,
      mintAuthority.publicKey(),
      amount,
      []
    ),
    signers: [mintAuthority],
  });
}

export function setMintAuthority(
  mint: PublicKey,
  currentAuthority: AsyncSigner,
  newAuthority: PublicKey | null
): InstructionReturn {
  // eslint-disable-next-line require-await
  return async () => ({
    instruction: createSetAuthorityInstruction(
      mint,
      currentAuthority.publicKey(),
      AuthorityType.MintTokens,
      newAuthority
    ),
    signers: [currentAuthority],
  });
}

export function setFreezeAuthority(
  mint: PublicKey,
  currentFreezeAuthority: AsyncSigner,
  newFreezeAuthority: PublicKey | null
): InstructionReturn {
  // eslint-disable-next-line require-await
  return async () => ({
    instruction: createSetAuthorityInstruction(
      mint,
      currentFreezeAuthority.publicKey(),
      AuthorityType.FreezeAccount,
      newFreezeAuthority
    ),
    signers: [currentFreezeAuthority],
  });
}

export function setAccountAuthority(
  tokenAccount: PublicKey,
  currentAuthority: AsyncSigner,
  newAuthority: PublicKey | null
): InstructionReturn {
  // eslint-disable-next-line require-await
  return async () => ({
    instruction: createSetAuthorityInstruction(
      tokenAccount,
      currentAuthority.publicKey(),
      AuthorityType.AccountOwner,
      newAuthority
    ),
    signers: [currentAuthority],
  });
}

export function transferToTokenAccount(
  owner: AsyncSigner,
  source: PublicKey,
  destination: PublicKey,
  amount: number
): InstructionReturn {
  // eslint-disable-next-line require-await
  return async () => ({
    instruction: createTransferInstruction(
      source,
      destination,
      owner.publicKey(),
      amount,
      []
    ),
    signers: [owner],
  });
}

/**
 * Create and initialize a new associated token account with allowOwnerOffCurve
 *
 * @param payer                    Payer of the transaction and initialization fees
 * @param mint                     Mint for the account
 * @param owner                    Owner of the new account
 * @param allowOwnerOffCurve       Allow the owner account to be a PDA (Program Derived Address)
 * @param programId                SPL Token program account
 * @param associatedTokenProgramId SPL Associated Token program account
 *
 * @return Address of the new associated token account
 */
export function createAssociatedTokenAccount(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = true,
  programId = TOKEN_PROGRAM_ID,
  associatedTokenProgramId = ASSOCIATED_TOKEN_PROGRAM_ID
): { instructions: InstructionReturn; address: PublicKey } {
  const associatedToken = getAssociatedTokenAddressSync(
    mint,
    owner,
    allowOwnerOffCurve,
    programId,
    associatedTokenProgramId
  );
  return {
    // eslint-disable-next-line require-await
    instructions: async (funder) => ({
      instruction: createAssociatedTokenAccountInstruction(
        funder.publicKey(),
        associatedToken,
        owner,
        mint,
        programId,
        associatedTokenProgramId
      ),
      signers: [funder],
    }),
    address: associatedToken,
  };
}

/**
 * Construct a CreateAssociatedTokenAccountIdempotent instruction
 *
 * Creates an associated token account for the given wallet address and token mint,
 * if it doesn't already exist.  Returns an error if the account exists,
 * but with a different owner.
 *
 * @param payer                    Payer of the transaction and initialization fees
 * @param mint                     Mint for the account
 * @param owner                    Owner of the new account
 * @param allowOwnerOffCurve       Allow the owner account to be a PDA (Program Derived Address)
 * @param programId                SPL Token program account
 * @param associatedTokenProgramId SPL Associated Token program account
 *
 * @return Address of the new associated token account
 */
export function createAssociatedTokenAccountIdempotent(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = true,
  programId = TOKEN_PROGRAM_ID,
  associatedTokenProgramId = ASSOCIATED_TOKEN_PROGRAM_ID
): { instructions: InstructionReturn; address: PublicKey } {
  const associatedToken = getAssociatedTokenAddressSync(
    mint,
    owner,
    allowOwnerOffCurve,
    programId,
    associatedTokenProgramId
  );
  return {
    // eslint-disable-next-line require-await
    instructions: async (funder) => ({
      instruction: createAssociatedTokenAccountIdempotentInstruction(
        funder.publicKey(),
        associatedToken,
        owner,
        mint,
        programId,
        associatedTokenProgramId
      ),
      signers: [funder],
    }),
    address: associatedToken,
  };
}
