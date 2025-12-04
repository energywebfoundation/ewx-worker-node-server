/* eslint-disable */
/**
 * @source @energywebfoundation/generic-green-proofs-ewx-module
 */

import type { ApiPromise, Keyring } from '@polkadot/api';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any; // no way to type polkadot api integration

export type SendTxResult = { txHash: string; finalizedBlockNumber: number; extrinsicIndex: number };

export abstract class EwxTxManager {
  abstract signAndSend(
    keyringPair: ReturnType<Keyring['addFromUri']>,
    fn: (api: ApiPromise) => { signAndSend: Any },
  ): Promise<SendTxResult>;

  abstract sendWithoutSigning(fn: (api: ApiPromise) => { send: Any }): Promise<SendTxResult>;

  abstract isConnected(): Promise<boolean>;
  abstract startConnection(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract getConnection(): Promise<ApiPromise>;

  async verifyProxyEvent(params: { blockNumber: number; extrinsicIndex: number }): Promise<void> {
    const api = await this.getConnection();

    const blockHash = await api.rpc.chain.getBlockHash(params.blockNumber);

    // After finding block hash we need to get events from it
    const apiAt = await api.at(blockHash);
    const allBlockEvents: Any = await apiAt.query.system.events();

    // Then some of these events are related to our extrinsic (index)
    const eventsForExtrinsic = allBlockEvents
      .filter(
        ({ phase }: Any) =>
          phase.isApplyExtrinsic && phase.asApplyExtrinsic.eq(params.extrinsicIndex),
      )
      .map(({ event }: Any) => event);

    const proxyEvent = eventsForExtrinsic.find(
      (event: Any) => `${event.section}:${event.method}` === 'proxy:ProxyExecuted',
    );

    if (!proxyEvent) {
      throw new Error(
        `Checking for proxy event failed. Cannot find ProxyExecuted event in block: ${params.blockNumber}.`,
      );
    }

    // I have no idea what I'm doing...
    const humanData = proxyEvent.data[0].toHuman();
    const isError = Boolean(humanData.Err);

    if (isError) {
      // Descending into madness...
      const errorData = proxyEvent.data.result?.__internal__raw?.__internal__raw;

      if (errorData) {
        const decoded = api.registry.findMetaError(errorData);

        throw new Error(
          `Transaction executed through proxy failed with ${decoded.section}.${decoded.name} in block: ${params.blockNumber}`,
        );
      } else {
        throw new Error(
          `Transaction executed through proxy failed with unknown reason in block: ${params.blockNumber}`,
        );
      }
    }
  }

  // source: https://polkadot.js.org/docs/api/cookbook/blocks/#how-do-i-determine-if-an-extrinsic-succeededfailed
  protected decodeFailure(api: ApiPromise, event: Any): string {
    const [dispatchError, _dispatchInfo] = event.data;

    if (dispatchError.isModule) {
      const decoded = api.registry.findMetaError(dispatchError.asModule);

      return `${decoded.section}.${decoded.name}`;
    } else {
      return dispatchError.toString();
    }
  }
}
