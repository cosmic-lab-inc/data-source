import { TransactionConfirmationStatus } from '@solana/web3.js';
import { Idl } from '@staratlas/anchor';
import { Account } from './account';
import { ListenProgram } from './listenProgram';

export type InsertProgramReturn = {
  refresh: () => Promise<void>;
  close: () => Promise<void>;
};

export interface DataSource {
  /**
   * Insert a program into the data source.
   * @return A function that can be called to remove the program from the data source.
   * @param program The program to add.
   * @param startupCommitment The commitment level to use when fetching accounts on startup.
   */
  insertProgram<Accounts extends Record<string, Account>, IDL extends Idl>(
    program: ListenProgram<Accounts, IDL>,
    startupCommitment: TransactionConfirmationStatus | 'recent'
  ): Promise<InsertProgramReturn>;

  /**
   * Repeat startup for all programs.
   */
  refreshAll(): Promise<void>;

  /**
   * Closes the data source and all programs within it.
   */
  closeDataSource(): Promise<void>;
}
