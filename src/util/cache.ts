import { createCache } from 'cache-manager';

export const CACHE = createCache({
  ttl: 600 * 1000,
});
