import { type ApiPromise } from '@polkadot/api';
import { type KeyringPair } from '@polkadot/keyring/types';
import { MAIN_CONFIG } from './config';
import { sleep } from './util';
import {
  getOperatorSubscriptions,
  isConnectedAsWorker,
  retryHttpAsyncCall,
} from './polkadot/polka';

export const runChecks = async (api: ApiPromise, account: KeyringPair, logger): Promise<void> => {
  const shouldRetryInfinite: boolean = MAIN_CONFIG.RETRY_WORKER_CHECKS;

  let checksResult = false;

  do {
    checksResult = await performInitialChecks(api, account, logger);

    if (!checksResult) {
      logger.error('some checks failed, check console');

      if (!shouldRetryInfinite) {
        break;
      }

      await sleep(10000);
    }
    // eslint-disable-next-line no-unmodified-loop-condition
  } while (!checksResult && shouldRetryInfinite);

  if (!checksResult && !shouldRetryInfinite) {
    logger.error('checks failed and will not be retried');
    logger.error('exiting process');

    process.exit(1);
  }
};

export const performInitialChecks = async (
  api: ApiPromise,
  account: KeyringPair,
  logger,
): Promise<boolean> => {
  const [isConnected, operatorAddress] = await retryHttpAsyncCall(
    async () => await isConnectedAsWorker(api, account.address),
  );

  if (!isConnected || operatorAddress == null) {
    logger.error({ address: account.address }, 'worker does not have operator');

    return false;
  }

  logger.info({ operatorAddress }, 'operator address');

  const operatorSubscriptions: string[] = await retryHttpAsyncCall(
    async () => await getOperatorSubscriptions(api, operatorAddress),
  );

  if (operatorSubscriptions.length === 0) {
    logger.error({ operatorAddress }, 'operator does not have any subscriptions');

    return false;
  }

  logger.info({ operatorSubscriptions }, 'operator subscriptions');

  return true;
};
