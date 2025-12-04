import { MAIN_CONFIG } from '../config';
import { EwxHttpTxManager } from '../polkadot/ewx-tx-manager-http';
import { type EwxTxManager } from '../polkadot/ewx-tx-manager';

export const createEwxTxManager = (): EwxTxManager => {
  return new EwxHttpTxManager(new URL(MAIN_CONFIG.VOTING_RPC_URL));
};
