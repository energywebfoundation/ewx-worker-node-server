import { z } from 'zod';
import axios from 'axios';
import { createLogger } from './logger';
import { CACHE } from './cache';
import { MAIN_CONFIG } from '../config';
import { BaseUrlsInvalidFormatError, FailedToFetchBaseUrlsError } from '../errors';

const BASE_URLS_CACHE_KEY = 'BASE_URLS';
const logger = createLogger('BaseUrls');

const BaseUrlsConfigSchema = z.object({
  workers_nominator_url: z.string().url().optional(),
  cas_normalizer_url: z.string().url().optional(),
  kafka_url: z.union([z.string(), z.array(z.string())]).optional(),
  kafka_proxy_url: z.string().url().optional(),
  indexer_url: z.string().optional(),
  base_indexer_url: z.string().url(),
  rpc_url: z.string().url(),
  workers_registry_url: z.string().url(),
  auth_server_url: z.string().url(),
}).transform((data) => ({
  workersNominatorUrl: data.workers_nominator_url,
  casNormalizerUrl: data.cas_normalizer_url,
  kafkaUrl: data.kafka_url,
  kafkaProxyUrl: data.kafka_proxy_url,
  indexerUrl: data.indexer_url,
  baseIndexerUrl: data.base_indexer_url,
  rpcUrl: data.rpc_url,
  workersRegistryUrl: data.workers_registry_url,
  authServerUrl: data.auth_server_url,
}));

export type BaseUrlsConfig = z.infer<typeof BaseUrlsConfigSchema>;

export const getBaseUrls = async (): Promise<BaseUrlsConfig> => {
  const cacheHit = await CACHE.get<BaseUrlsConfig>(BASE_URLS_CACHE_KEY);

  if (cacheHit != null) {
    return cacheHit;
  }

  logger.info({
    baseUrls: MAIN_CONFIG.BASE_URLS
  }, 'updating urls references from base_urls');

  const receivedConfig = await axios
    .get(MAIN_CONFIG.BASE_URLS)
    .then((x) => x.data)
    .catch((e) => {
      logger.error('failed to fetch base url');
      logger.error(e);

      return false;
    });

  try {
    const parsed = BaseUrlsConfigSchema.parse(receivedConfig);

    const rewritten: BaseUrlsConfig = {
      ... parsed,
      workersRegistryUrl: MAIN_CONFIG.WORKER_REGISTRY_URL ?? parsed.workersRegistryUrl,
      authServerUrl: MAIN_CONFIG.PALLET_AUTH_SERVER_LOGIN_URL ?? parsed.authServerUrl,
      rpcUrl: MAIN_CONFIG.PALLET_RPC_URL ?? parsed.rpcUrl,
    };

    logger.info({
      baseUrls: rewritten
    }, 'updated urls references from base_urls');

    await CACHE.set(BASE_URLS_CACHE_KEY, rewritten, 300 * 1000);

    return rewritten;
  } catch (e) {
    if (e instanceof z.ZodError) {
      logger.error({
        issues: e.issues,
      }, 'failed to parse base urls config');

      logger.error(e);

      throw new BaseUrlsInvalidFormatError();
    }

    if (axios.isAxiosError(e)) {
      logger.error({
        status: e.response?.status,
        statusText: e.response?.statusText,
        data: e.response?.data
      }, 'failed to fetch base urls');

      throw new FailedToFetchBaseUrlsError();
    }

    logger.error('failed to parse base urls config');
    logger.error(e);

    throw e;
  }
};
