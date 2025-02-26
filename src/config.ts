import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { z } from 'zod';

const getEnvFilePath = (): string | null => {
  const pathsToTest = ['.env', '../.env'];

  let finalPath: string | null = null;

  for (const pathToTest of pathsToTest) {
    const resolvedPath = path.resolve(__dirname, pathToTest);

    if (fs.existsSync(resolvedPath)) {
      finalPath = resolvedPath;
      break;
    }
  }

  return finalPath;
};

const envFilePath = getEnvFilePath();

dotenv.config({
  path: envFilePath ?? undefined,
});

export const ENV_SCHEMA = z.object({
  EXCLUDED_NODES: z
    .string()
    .default('file,file in,watch,exec')
    .transform((a) => a.split(','))
    .describe(
      'NodeRed nodes that are going to be excluded from SmartFlows. If any node type of the SmartFlow equals to one of the EXCLUDED_NODES it will prevent SmartFlow from being installed.',
    ),
  TARGET_SOLUTION_NAMESPACES: z
    .string()
    .transform((a) => a.split(','))
    .optional()
    .describe(
      'If set it will only install solutions that namespaces are specified in this env. variable. Comma-separated.',
    ),
  RETRY_WORKER_CHECKS: z.coerce
    .boolean()
    .default(true)
    .describe(
      `If it's enabled it will indefinitely await for worker to pass all checks otherwise it will kill process. Useful e.g if worker account is not yet assigned to operator at the moment of configuration.`,
    ),
  ENABLE_HEALTH_API: z.coerce
    .boolean()
    .default(true)
    .describe(`If it's enabled it will enable health check routes.`),
  PALLET_RPC_URL: z.string().url().describe('Read EWX Parachain URL'),
  VOTING_RPC_URL: z.string().url().describe('Write EWX Parachain URL'),
  VOTING_WORKER_SEED: z.string().describe('Seed of the worker (not operator)'),
  PORT: z.coerce.number().positive().default(8000).describe('Port number of NodeRed Server.'),
  HOST: z.string().default('localhost').describe('Hostname of NodeRed Server.'),
  RED_ENABLE_UI: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default('false')
    .describe('Should enable NodeRed UI.'),
  RED_DIRECTORY: z.string().default('./node-red-data').describe('Storage of NodeRed flows.'),
  SQLITE_BASE_PATH: z.string().default('./sqlite').describe('Base SQLite path.'),
  IPFS_API_KEY: z.string().nullable().default(null).describe('IPFS API Key'),
  IPFS_SECRET_KEY: z.string().nullable().default(null).describe('IPFS Secret Key'),
  IPFS_URL: z.string().default('https://ipfs.io').describe('IPFS Url'),
  IPFS_CONTEXT_PATH: z.string().default('/ipfs/').describe('IPFS Context Path'),
  IPFS_USER_AGENT_VALUE: z
    .string()
    .default('ewx-worker-node-server')
    .describe('Default user agent that is going to be used for public IPFS queries.'),
  SOLUTION_QUEUE_PROCESS_DELAY: z.coerce
    .number()
    .default(20000)
    .describe('How often should refresh EWX Solutions information from chain (in miliseconds).'),
  LOCAL_SOLUTIONS_PATH: z
    .string()
    .optional()
    .describe(
      'Path to locally hosted NodeRed solution flow files to be used when installing solutions using "local" prefix within WorkLogic field.',
    ),
  SS58_FORMAT: z.coerce.number().positive().default(42).describe('SS58 Key Format.'),
  PRETTY_PRINT: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default('false')
    .describe(
      `Should pretty print logs. If you plan to use Grafana or any other log tooling it's recommended to set it to false.`,
    ),
  HEARTBEAT_PATH: z
    .string()
    .default('heartbeat')
    .describe('Path to the heartbeat file used for monitoring.'),
  HEARTBEAT_INTERVAL: z.coerce
    .number()
    .positive()
    .default(5000)
    .describe('Interval (in ms) at which the heartbeat process updates the file.'),
  HEARTBEAT_PRINT_SUCCESS_LOG: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default('true')
    .describe('Should print successful logs.'),
});

export const MAIN_CONFIG: z.infer<typeof ENV_SCHEMA> = (process.env.__SKIP_PARSE_CONFIG === 'true'
  ? undefined
  : ENV_SCHEMA.parse(process.env)) as unknown as z.infer<typeof ENV_SCHEMA>;
