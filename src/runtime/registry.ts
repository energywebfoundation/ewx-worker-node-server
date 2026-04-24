import { type Express } from 'express';
import { type Server } from 'http';
import { readFileSync, existsSync } from 'fs';
import { type Runtime } from './runtime';
import { MAIN_CONFIG } from '../config';
import { createLogger } from '../util/logger';
import { nodeRedRuntime } from './node-red/red-runtime';
import { n8nRuntime } from './n8n/n8n-runtime';
import { type Solution } from '../polkadot/polka-types';

const logger = createLogger('RuntimeRegistry');

/**
 * The ordered list of runtimes known to this worker. Order matters only for
 * the back-compat fallback when a solution's executionEnvironment is empty -
 * the first runtime whose executionEnvironments array contains the empty
 * string wins, which by design is Node-RED.
 */
export const ALL_RUNTIMES: readonly Runtime[] = [nodeRedRuntime, n8nRuntime];

/**
 * Parse DEV_RUNTIME_OVERRIDES env var. Format:
 *   DEV_RUNTIME_OVERRIDES=vcc-1=n8n,other-sol=node-red
 * This lets an operator force a specific solutionId onto a specific runtime
 * for local testing, regardless of what the chain says. Intended for dev only.
 */
const parseRuntimeOverrides = (raw: string | undefined): Record<string, string> => {
  if (raw == null || raw.trim().length === 0) return {};

  const out: Record<string, string> = {};

  for (const entry of raw.split(',')) {
    const [sid, rtId] = entry.split('=').map((s) => s.trim());

    if (sid != null && sid.length > 0 && rtId != null && rtId.length > 0) {
      out[sid] = rtId;
    }
  }

  return out;
};

const runtimeOverrides: Record<string, string> = parseRuntimeOverrides(
  MAIN_CONFIG.DEV_RUNTIME_OVERRIDES,
);

/**
 * Warn-once set so a misconfigured override doesn't flood the log every
 * reconcile tick.
 */
const warnedOverrideMiss = new Set<string>();

/**
 * Pick the runtime for a given solution based on its on-chain
 * executionEnvironment field, with optional dev-time override.
 *
 * Returns null if the solution's executionEnvironment does not match any known
 * runtime, which the caller treats as "skip this solution, it targets a runtime
 * we don't implement".
 */
export const pickRuntimeForSolution = (solutionId: string, solution: Solution): Runtime | null => {
  // Dev override: operator-set DEV_RUNTIME_OVERRIDES wins over chain.
  const overrideId: string | undefined = runtimeOverrides[solutionId];

  if (overrideId != null) {
    const rt = ALL_RUNTIMES.find((r) => r.id === overrideId);

    if (rt != null) return rt;

    if (!warnedOverrideMiss.has(solutionId)) {
      warnedOverrideMiss.add(solutionId);
      logger.warn(
        {
          solutionId,
          override: overrideId,
          available: ALL_RUNTIMES.map((r) => r.id),
        },
        'DEV_RUNTIME_OVERRIDES names a runtime that is not available; falling through to chain',
      );
    }
  }

  const ee: string = solution.workload?.executionEnvironment ?? '';
  const rt = ALL_RUNTIMES.find((r) => r.executionEnvironments.includes(ee));

  if (rt == null) {
    logger.warn(
      { solutionId, executionEnvironment: ee },
      'solution has unrecognized executionEnvironment; skipping',
    );

    return null;
  }

  return rt;
};

/**
 * Parse DEV_LOCAL_FLOW_OVERRIDES env var. Format:
 *   DEV_LOCAL_FLOW_OVERRIDES=vcc-1=./test-flows/vcc-1.json,other=./path.json
 * When a solutionId appears in this map, the worker reads the flow JSON from
 * the given local file instead of fetching from IPFS. Intended for dev only
 * and useful for iterating on an n8n flow without republishing to IPFS.
 */
const parseFlowOverrides = (raw: string | undefined): Record<string, string> => {
  if (raw == null || raw.trim().length === 0) return {};

  const out: Record<string, string> = {};

  for (const entry of raw.split(',')) {
    const [sid, filePath] = entry.split('=').map((s) => s.trim());

    if (sid != null && sid.length > 0 && filePath != null && filePath.length > 0) {
      out[sid] = filePath;
    }
  }

  return out;
};

const flowOverrides: Record<string, string> = parseFlowOverrides(
  MAIN_CONFIG.DEV_LOCAL_FLOW_OVERRIDES,
);

/**
 * If the operator has configured DEV_LOCAL_FLOW_OVERRIDES[solutionId], return
 * the file contents. Otherwise return null and the caller falls back to the
 * normal chain/IPFS fetch.
 */
export const getLocalFlowOverride = (solutionId: string): string | null => {
  const filePath: string | undefined = flowOverrides[solutionId];

  if (filePath == null) return null;

  if (!existsSync(filePath)) {
    logger.warn(
      { solutionId, filePath },
      'DEV_LOCAL_FLOW_OVERRIDES points at a file that does not exist',
    );

    return null;
  }

  return readFileSync(filePath, 'utf8');
};

/**
 * Start every registered runtime during worker bootstrap. Returns a map of
 * runtime id to the http.Server it exposes (or null if the runtime does not
 * expose one), so callers can wire these into graceful shutdown. Errors are
 * logged per-runtime and then swallowed, so a single runtime failing to spawn
 * does not bring down the worker; solutions routed to the broken runtime will
 * simply be skipped at pick time.
 */
export const startAllRuntimes = async (app: Express): Promise<Record<string, Server | null>> => {
  const servers: Record<string, Server | null> = {};

  for (const rt of ALL_RUNTIMES) {
    try {
      const server: Server | null = await rt.start(app);
      servers[rt.id] = server;
      logger.info({ runtime: rt.id }, 'runtime started');
    } catch (e) {
      servers[rt.id] = null;
      logger.error(
        { runtime: rt.id, err: (e as Error).message },
        'runtime failed to start; solutions routed to it will be skipped',
      );
    }
  }

  return servers;
};

/**
 * Wipe leftover installed flows from every registered runtime. Called on boot
 * so reconcile starts from a clean slate. Errors per-runtime are logged and
 * swallowed; the reconcile loop will catch up on the next tick regardless.
 */
export const deleteAllFromAllRuntimes = async (): Promise<void> => {
  for (const rt of ALL_RUNTIMES) {
    await rt.deleteAll().catch((e: Error) => {
      logger.warn({ runtime: rt.id, err: e.message }, 'deleteAll on boot failed; continuing');
    });
  }
};
