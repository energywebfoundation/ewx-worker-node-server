import { createLogger } from './logger';
import { getOperatorAddress, retryHttpAsyncCall } from '../polkadot/polka';
import { createReadPalletApi } from './pallet-api';

const logger = createLogger('OperatorAddressCache');

// In-memory cache: Map<workerAddress, operatorAddress>
const operatorAddressCache = new Map<string, string>();

export const saveOperatorAddress = (workerAddress: string, operatorAddress: string): void => {
  operatorAddressCache.set(workerAddress, operatorAddress);
};

export const getCachedOperatorAddress = async (
  workerAddress: string,
  timeoutMs: number = 5000,
): Promise<string | null> => {
  // Return cached value if available
  const cached = operatorAddressCache.get(workerAddress);
  if (cached != null) {
    return cached;
  }

  // Query chain if not cached
  try {
    const apiPromise = retryHttpAsyncCall(async () => await createReadPalletApi());
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error('Operator address fetch timeout'));
      }, timeoutMs);
    });

    const api = await Promise.race([apiPromise, timeoutPromise]);

    const operatorAddressPromise = retryHttpAsyncCall(
      async () => await getOperatorAddress(api, workerAddress),
    );
    const operatorAddress = await Promise.race([operatorAddressPromise, timeoutPromise]).catch(
      () => null,
    );

    await api.disconnect().catch(() => {
      // Ignore disconnect errors
    });

    if (operatorAddress != null) {
      // Cache the result
      operatorAddressCache.set(workerAddress, operatorAddress);
      return operatorAddress;
    }

    logger.warn({ workerAddress }, 'no operator assigned to worker');
    return null;
  } catch (error) {
    logger.warn({ error, workerAddress }, 'failed to get operator address from chain');
    return null;
  }
};

export const clearOperatorAddress = (workerAddress: string): void => {
  operatorAddressCache.delete(workerAddress);
};
