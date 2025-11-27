/* eslint-disable */
/**
 * @source @energywebfoundation/generic-green-proofs-ewx-module
 */
import { ApiPromise, HttpProvider, type Keyring } from '@polkadot/api';
import { setTimeout } from 'timers/promises';

import { type Any, EwxTxManager, type SendTxResult } from './ewx-tx-manager.js';

export type EwxHttpTxManagerOptions = {
  /** How many blocks to wait (to find transaction registered) before failing */
  waitBlockNumber: number;
  debug: boolean;
};

export class EwxHttpTxManager extends EwxTxManager {
  private options: EwxHttpTxManagerOptions;
  private connectionCache: Promise<ApiPromise> | null = null;
  private provider: HttpProvider;

  constructor(rpcUrl: URL, options: Partial<EwxHttpTxManagerOptions> = {}) {
    super();

    this.options = {
      waitBlockNumber: options.waitBlockNumber ?? 10,
      debug: options.debug ?? false,
    };

    this.provider = new HttpProvider(rpcUrl.href);
  }

  async isConnected(): Promise<boolean> {
    // Initializing HTTP connection is enough
    const api = await this.getConnection();

    return Boolean(api);
  }

  async startConnection(): Promise<void> {
    // Just check the connection
    const api = await this.getConnection();
    await api.rpc.chain.getHeader();
  }

  async disconnect(): Promise<void> {
    // not applicable
  }

  public async signAndSend(
    keyringPair: ReturnType<Keyring['addFromUri']>,
    fn: (api: ApiPromise) => { signAndSend: Any },
  ): Promise<SendTxResult> {
    const api = await this.getConnection();

    const txHash = await new Promise<string>((resolve, reject) => {
      fn(api)
        .signAndSend(keyringPair, (status: Any) => {
          resolve(status.toHuman());
        })
        .catch(reject);
    });

    return await this.waitForTx(api, txHash);
  }

  public async sendWithoutSigning(fn: (api: ApiPromise) => { send: Any }): Promise<SendTxResult> {
    const api = await this.getConnection();

    const txHash = await new Promise<string>((resolve, reject) => {
      fn(api)
        .send((status: Any) => {
          resolve(status.toHuman());
        })
        .catch(reject);
    });

    return await this.waitForTx(api, txHash);
  }

  public async getConnection() {
    if (!this.connectionCache) {
      this.connectionCache = ApiPromise.create({
        provider: this.provider,
        noInitWarn: true,
        throwOnConnect: true,
      });
    }

    return this.connectionCache;
  }

  private async waitForTx(api: ApiPromise, txHash: string) {
    // Sent transaction will eventually come up in some in future
    const {
      block: { block },
      extrinsicIndex,
    } = await this.findBlockWithTx(api, txHash);

    // After finding that block we need to get events from it
    const apiAt = await api.at(block.header.hash);
    const allBlockEvents: Any = await apiAt.query.system.events();

    // Then some of these events are related to our extrinsic (index)
    const eventsForExtrinsic = allBlockEvents
      .filter(
        ({ phase }: Any) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.eq(extrinsicIndex),
      )
      .map(({ event }: Any) => event);

    // Some of these events might indicate that extrinsic failed
    const failedEvents: Any[] = eventsForExtrinsic.filter((event: Any) =>
      api.events.system.ExtrinsicFailed.is(event),
    );

    if (failedEvents.length === 0) {
      return {
        txHash,
        finalizedBlockNumber: block.header.number.toNumber(),
        extrinsicIndex,
      };
    } else {
      const errors = failedEvents.map((event) => this.decodeFailure(api, event));

      throw new Error(`Extrinsic failed due to errors: ${errors.join(', ')}`);
    }
  }

  private async findBlockWithTx(api: ApiPromise, txHash: string) {
    const startingBlockNumber = await this.getCurrentBlockNumber(api);
    let blockToCheck = startingBlockNumber;

    while (startingBlockNumber + this.options.waitBlockNumber > blockToCheck) {
      this.debugLog(`Checking block number ${blockToCheck}. Looking for txHash=${txHash}`);

      const blockHash = await api.rpc.chain.getBlockHash(blockToCheck);

      if (
        blockHash.toHex() === '0x0000000000000000000000000000000000000000000000000000000000000000'
      ) {
        this.debugLog(`Block ${blockToCheck} not ready`);
        await setTimeout(2000);
        continue;
      }

      // We should check extrinsics ONLY on finalized blocks
      // In case of parachain if block is not finalized then its list of extrinsics can change
      const finalizedBlockNumber = await this.getCurrentFinalizedBlockNumber(api);
      if (finalizedBlockNumber < blockToCheck) {
        this.debugLog(
          `Block ${blockToCheck} is not finalized yet (latest finalized: ${finalizedBlockNumber})`,
        );
        await setTimeout(2000);
        continue;
      }

      const signedBlock = await api.rpc.chain.getBlock(blockHash);

      this.debugLog(
        'Found extrinsics hashes',
        signedBlock.block.extrinsics.map((ex) => ex.hash.toHex()),
      );

      const matchingExtrinsicIndex = signedBlock.block.extrinsics.findIndex((ex) => {
        return ex.hash.toHex() === txHash;
      });

      if (matchingExtrinsicIndex >= 0) {
        return {
          block: signedBlock,
          extrinsic: signedBlock.block.extrinsics[matchingExtrinsicIndex],
          extrinsicIndex: matchingExtrinsicIndex,
        };
      } else {
        blockToCheck += 1;
      }
    }

    throw new Error(
      `Cannot finish extrinsic started in ${startingBlockNumber}. Block with extrinsic was not found in ${this.options.waitBlockNumber} blocks.`,
    );
  }

  private async getCurrentBlockNumber(api: ApiPromise): Promise<number> {
    const header = await api.rpc.chain.getHeader();
    const blockNumber = header.number.toNumber();

    return blockNumber;
  }

  private async getCurrentFinalizedBlockNumber(api: ApiPromise): Promise<number> {
    const finalizedBlockHash = await api.rpc.chain.getFinalizedHead();
    const finalizedBlock = await api.rpc.chain.getBlock(finalizedBlockHash);

    return finalizedBlock.block.header.number.toNumber();
  }

  private debugLog(...log: unknown[]) {
    if (this.options.debug === true) {
      // eslint-disable-next-line no-console
      console.log(...log);
    }
  }
}
