import express from 'express';
import { getAppState } from '../util/status';

export const createStatusRouter = (): express.Router => {
  const statusRouter = express.Router({ mergeParams: true });

  statusRouter.get('/status', (_, res) => {
    res.status(200).json({
      status: getAppState(),
    });
  });

  return statusRouter;
};
