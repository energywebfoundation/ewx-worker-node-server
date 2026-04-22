import { type ApiPromise } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import express from 'express';
import bodyParser from 'body-parser';
import { createVoteRouter } from './vote';
import { pushToQueue } from './solution';
import { createHealthRouter } from './health';
import { runChecks } from './checks';
import { createKeyringPair } from './account';
import { APP_BOOTSTRAP_STATUS, createStatusRouter, setAppState } from './status';
import { createLogger, createReadPalletApi } from './util';
import { createConfigRouter } from './worker-config';
import { retryHttpAsyncCall } from './polkadot/polka';
import { startHeartbeat } from './heartbeat';
import { registerWorker } from './registry';
import { ALL_RUNTIMES } from './runtime/registry';

void (async () => {
  setAppState(APP_BOOTSTRAP_STATUS.STARTED);

  const logger = createLogger('WorkerNode');

  const app = express();

  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: false }));

  const healthRouter: express.Router | null = createHealthRouter();

  app.use(createVoteRouter());
  app.use(createStatusRouter());
  app.use(createConfigRouter());

  if (healthRouter != null) {
    logger.info('initializing health router');

    app.use(healthRouter);
  }

  app.listen(3002, () => {
    logger.info(`vote API exposed on port 3002`);
  });

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

  // Start every registered runtime. NR always starts (it's the default/fallback
  // and hosts the express middleware). n8n starts only if it's reachable; if
  // spawning fails, the worker keeps running with NR only and any solution
  // that needs n8n will be skipped at pick time.
  for (const rt of ALL_RUNTIMES) {
    try {
      await rt.start(app);
      logger.info({ runtime: rt.id }, 'runtime started');
    } catch (e) {
      logger.error(
        { runtime: rt.id, err: (e as Error).message },
        'runtime failed to start; solutions routed to it will be skipped',
      );
    }
  }

  setAppState(APP_BOOTSTRAP_STATUS.STARTED_RED_SERVER);

  // Wipe any leftover installed flows from prior runs across every runtime
  // that started successfully, so reconcile starts from a clean slate.
  for (const rt of ALL_RUNTIMES) {
    await rt.deleteAll().catch((e: Error) => {
      logger.warn({ runtime: rt.id, err: e.message }, 'deleteAll on boot failed; continuing');
    });
  }

  await api.disconnect();

  void pushToQueue(account);

  setAppState(APP_BOOTSTRAP_STATUS.READY);

  logger.info('starting heartbeat');
  startHeartbeat();
})();
