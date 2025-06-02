import { z } from 'zod';
import { MAIN_CONFIG } from './config';
import { readFileSync, existsSync } from 'fs';

const VERSION_SCHEMA = z.object({
  version: z.string(),
  gitSha: z.string(),
});

export type Version = z.infer<typeof VERSION_SCHEMA>;

const readVersion = (): Version => {
  if (!existsSync(MAIN_CONFIG.BUILD_METADATA_PATH)) {
    throw new Error('BUILD_METADATA_PATH does not exist');
  }

  const contents = readFileSync(MAIN_CONFIG.BUILD_METADATA_PATH).toString();

  return VERSION_SCHEMA.parse(JSON.parse(contents));
};

export const AppVersion = readVersion();
