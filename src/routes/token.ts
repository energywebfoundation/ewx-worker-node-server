import express from 'express';
import asyncHandler from 'express-async-handler';
import { getToken } from '../auth/login';

export const createTokenRouter = (): express.Router => {
  const tokenRouter = express.Router();

  tokenRouter.get(
    '/token',
    asyncHandler(async (req, res) => {
      const token = await getToken().catch(() => null);

      res.status(200).json({
        token,
      });
    }),
  );

  return tokenRouter;
};
