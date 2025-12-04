import type { KeyringPair } from '@polkadot/keyring/types';
import axios from 'axios';
import promiseRetry from 'promise-retry';
import { u8aToHex } from '@polkadot/util';
import { type ApiPromise } from '@polkadot/api';
import { createReadPalletApi } from '../util/pallet-api';
import { createLogger } from '../util/logger';
import { getToken } from './login';
import { getBaseUrls } from '../util/base-urls';
import { AppVersion } from '../util/version';

const logger = createLogger('WorkersRegistry');

enum WorkerRegistrationStatus {
  EXISTS = 'EXISTS',
  ERROR = 'ERROR',
  NOT_EXISTS = 'NOT_EXISTS',
  REQUIRES_UPGRADE = 'REQUIRES_UPGRADE',
}

const source = 'WNS';

export const registerWorker = async (account: KeyringPair): Promise<void> => {
  await promiseRetry(
    async (retry) => {
      const api: ApiPromise = await createReadPalletApi();

      try {
        logger.info('attempting to retrieve token');

        const token: string | null = await getToken();

        if (token == null) {
          return retry(new Error('failed to sign in'));
        }

        const workerRegistrationStatus: WorkerRegistrationStatus =
          await getWorkerRegistrationStatus(token, account.address, api);

        if (workerRegistrationStatus === WorkerRegistrationStatus.EXISTS) {
          logger.info('account is already in workers registry');

          return null;
        } else if (workerRegistrationStatus === WorkerRegistrationStatus.NOT_EXISTS) {
          logger.info('new account, attempting to register worker in registry');

          await storeWorkerInRegistry(token, account);

          return null;
        } else if (workerRegistrationStatus === WorkerRegistrationStatus.REQUIRES_UPGRADE) {
          logger.info('workers registry requires data upgrade');

          await storeWorkerInRegistry(token, account);

          return null;
        } else {
          logger.error('something went wrong when registering in registry');

          return retry(new Error('unable to register worker in registry'));
        }
      } catch (e) {
        logger.error(e);

        return retry(e);
      } finally {
        await api.disconnect();
      }
    },
    {
      forever: true,
      minTimeout: 2000,
    },
  );
};

const storeWorkerInRegistry = async (token: string, account: KeyringPair): Promise<void> => {
  const signature: string = u8aToHex(
    account.sign(
      JSON.stringify({
        coords: undefined,
        source,
      }),
    ),
  );

  const { workersRegistryUrl } = await getBaseUrls();

  await axios
    .post(
      workersRegistryUrl + `/api/v1/workers`,
      {
        source,
        signature,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'x-worker-version': AppVersion.version,
          'x-worker-source': 'WNS',
        },
      },
    )
    .catch((e) => {
      logger.error(e.message);
      logger.error(e.response.data);

      throw e;
    });
};

const getWorkerRegistrationStatus = async (
  token: string,
  workerAddress: string,
  api: ApiPromise,
): Promise<WorkerRegistrationStatus> => {
  const { workersRegistryUrl } = await getBaseUrls();

  const path = workersRegistryUrl + `/api/v1/workers/${workerAddress}`;

  return await axios
    .get(path, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    .then(async (r) => {
      const activeRewardPeriodInfo: any = await api.query.workerNodePallet.activeRewardPeriodInfo();

      if (r.data.rewardIndex !== activeRewardPeriodInfo.index.toNumber()) {
        return WorkerRegistrationStatus.REQUIRES_UPGRADE;
      }

      return WorkerRegistrationStatus.EXISTS;
    })
    .catch((e) => {
      if (e.status === 404 && e.response.data === '') {
        logger.error(
          {
            path,
          },
          'invalid path',
        );

        return WorkerRegistrationStatus.ERROR;
      }

      if (e.status === 404 && e.response.data.error.name === 'WorkerNotFoundException') {
        return WorkerRegistrationStatus.NOT_EXISTS;
      }

      logger.error(e.message);
      logger.error(e.data);

      return WorkerRegistrationStatus.ERROR;
    });
};
