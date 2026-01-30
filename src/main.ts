import { type ApiPromise } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { deleteAll, startRedServer } from './node-red/red';
import express from 'express';
import bodyParser from 'body-parser';
import { pushToQueue } from './solution';
import { runChecks } from './checks';
import { retryHttpAsyncCall } from './polkadot/polka';
import { createLogger } from './util/logger';
import { createReadPalletApi } from './util/pallet-api';
import { APP_BOOTSTRAP_STATUS, setAppState } from './util/status';
import { createKeyringPair } from './polkadot/account';
import { registerWorker } from './auth/registry';
import { startHeartbeat } from './health/heartbeat';
import { createHealthRouter } from './routes/health';
import { createVoteRouter } from './routes/vote';
import { createStatusRouter } from './routes/status';
import { createConfigRouter } from './routes/worker-config';
import { createTokenRouter } from './routes/token';
import { createAdminRouter } from './routes/admin';
import { setMainServer, setNodeRedServer, setAdminServer } from './shutdown';
import { MAIN_CONFIG } from './config';

void (async () => {
  setAppState(APP_BOOTSTRAP_STATUS.STARTED);

  const logger = createLogger('WorkerNode');

  const app = express();

  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: false }));

  const healthRouter: express.Router | null = createHealthRouter();

  app.use(createVoteRouter());
  app.use(createTokenRouter());
  app.use(createStatusRouter());
  app.use(createConfigRouter());

  if (healthRouter != null) {
    logger.info('initializing health router');

    app.use(healthRouter);
  }

  const mainServer = app.listen(3002, () => {
    logger.info(`vote API exposed on port 3002`);
  });
  setMainServer(mainServer);

  // Start admin server separately
  const adminApp = express();
  adminApp.use(bodyParser.json());
  adminApp.use(bodyParser.urlencoded({ extended: false }));
  adminApp.use(createAdminRouter());

  const adminServer = adminApp.listen(MAIN_CONFIG.ADMIN_SERVER_PORT, () => {
    logger.info(`admin API exposed on port ${MAIN_CONFIG.ADMIN_SERVER_PORT}`);
  });
  setAdminServer(adminServer);

  setAppState(APP_BOOTSTRAP_STATUS.EXPOSED_HTTP);

  await cryptoWaitReady();

  const account = createKeyringPair();

  logger.info(
    {
      address: account.address,
    },
    'loaded account',
  );

  const api: ApiPromise = await retryHttpAsyncCall(async () => await createReadPalletApi());

  setAppState(APP_BOOTSTRAP_STATUS.INITIALIZED_WORKER_ACCOUNT);

  await runChecks(api, account, logger);

  setAppState(APP_BOOTSTRAP_STATUS.PERFORMED_CHECKS);

  logger.info('connected to chain');

  await registerWorker(account);

  const nodeRedServer = await startRedServer(app);
  setNodeRedServer(nodeRedServer);

  setAppState(APP_BOOTSTRAP_STATUS.STARTED_RED_SERVER);

  await deleteAll();

  await api.disconnect();

  void pushToQueue(account);

  setAppState(APP_BOOTSTRAP_STATUS.READY);

  logger.info('starting heartbeat');
  startHeartbeat();
})();
