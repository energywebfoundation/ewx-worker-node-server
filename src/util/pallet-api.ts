import { type ApiPromise } from '@polkadot/api';
import { createApi, retryHttpAsyncCall } from '../polkadot/polka';
import { getBaseUrls } from './base-urls';

export const createReadPalletApi = async (): Promise<ApiPromise> => {
  const { rpcUrl } = await getBaseUrls();

  return await retryHttpAsyncCall(async () => await createApi(rpcUrl));
};
