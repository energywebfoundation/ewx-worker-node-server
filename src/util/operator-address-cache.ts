import type { ApiPromise } from '@polkadot/api';
import { createCache } from 'cache-manager';
import { createLogger } from './logger';
import { getOperatorAddress, retryHttpAsyncCall } from '../polkadot/polka';
import { createReadPalletApi } from './pallet-api';

const logger = createLogger('OperatorAddressCache');

const OPERATOR_ADDRESS_CACHE_TTL_MS = 300000;

// In-memory cache with TTL so operator changes are reflected while WNS is running
const operatorAddressCache = createCache({
  ttl: OPERATOR_ADDRESS_CACHE_TTL_MS,
});

export const saveOperatorAddress = async (
  workerAddress: string,
  operatorAddress: string,
): Promise<void> => {
  await operatorAddressCache.set(workerAddress, operatorAddress, OPERATOR_ADDRESS_CACHE_TTL_MS);
};

export const getCachedOperatorAddress = async (
  workerAddress: string,
  timeoutMs: number = 5000,
): Promise<string | null> => {
  // Return cached value if available (undefined when missing or expired)
  const cached = await operatorAddressCache.get(workerAddress);
  if (cached != null && typeof cached === 'string') {
    return cached;
  }

  // Query chain if not cached
  let api: ApiPromise | null = null;

  try {
    const apiPromise = retryHttpAsyncCall(async () => await createReadPalletApi());
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error('Operator address fetch timeout'));
      }, timeoutMs);
    });

    api = await Promise.race([apiPromise, timeoutPromise]);

    if (api == null) {
      return null;
    }

    const apiInstance = api;
    const operatorAddressPromise = retryHttpAsyncCall(
      async () => await getOperatorAddress(apiInstance, workerAddress),
    );
    const operatorAddress = await Promise.race([operatorAddressPromise, timeoutPromise]).catch(
      () => null,
    );

    if (operatorAddress != null) {
      // Cache the result with TTL
      await operatorAddressCache.set(workerAddress, operatorAddress, OPERATOR_ADDRESS_CACHE_TTL_MS);
      return operatorAddress;
    }

    logger.warn({ workerAddress }, 'no operator assigned to worker');
    return null;
  } catch (error) {
    logger.warn({ error, workerAddress }, 'failed to get operator address from chain');
    return null;
  } finally {
    if (api != null) {
      await api.disconnect().catch(() => {
        // Ignore disconnect errors
      });
    }
  }
};

export const clearOperatorAddress = async (workerAddress: string): Promise<void> => {
  await operatorAddressCache.del(workerAddress);
};
