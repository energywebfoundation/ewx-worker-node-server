import { type Express } from 'express';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import * as path from 'path';
import axios, { type AxiosInstance } from 'axios';
import { type Runtime, type UpsertSolutionInput, type InstalledSolutionHandle } from '../runtime';
import { MAIN_CONFIG } from '../../config';
import { createLogger } from '../../util/logger';

const logger = createLogger('N8nRuntime');

/**
 * n8n runtime. Spawns the n8n package's own CLI as a child process and drives
 * it through its public REST API - the same API n8n's own UI uses. This is
 * the integration pattern n8n is designed to support. We do not touch n8n
 * internals, so our code stays stable across n8n upgrades.
 *
 * Why subprocess and not in-process embedding:
 *   - Process isolation: an n8n crash or leak does not take out the worker.
 *   - No DI graph priming or database bootstrap work on our side - n8n boots
 *     itself the same way it does in a normal deployment.
 *   - No transitive loading of ".ee" Enterprise-licensed source files via
 *     deep imports, which would be triggered by in-process embedding.
 *   - Upgrading n8n is just a package.json bump; the REST API surface we use
 *     is stable across releases.
 *
 * Deployment notes:
 *   - n8n binds to 127.0.0.1 only, never reachable from outside the host.
 *   - User management is disabled; no login, no UI auth.
 *   - Telemetry and version notifications are disabled.
 *   - Encryption key is generated once and persisted to the worker's storage
 *     directory so restarts preserve any credentials n8n stores.
 */

interface N8nFlowEnvOverride {
  // What we inject into n8n workflows as static data so the flow JSON can
  // reference EWX_* variables the same way NR flows do via tab env.
  EWX_SOLUTION_ID: string;
  EWX_SOLUTION_GROUP_ID: string;
  EWX_WORKLOGIC_ID: string;
  EWX_SQLITE_PATH: string;
  EWX_WORKER_ADDRESS: string;
  EWX_RPC_URL: string;
  BASE_URL: string;
  EWX_SOLUTION: string;
}

// In-memory bookkeeping. solutionId -> n8n workflowId.
const installedBySolutionId = new Map<string, string>();

// Reverse index for getSolutionNamespace queries. workflowId -> solutionId.
// We mirror the NR logic where the vote router can ask "what solution does
// this runtime-internal id belong to?".
const solutionIdByWorkflowId = new Map<string, string>();

// The solutionGroupId is also tracked for getSolutionLogicalParts.
const solutionGroupIdByWorkflowId = new Map<string, string>();

// Track workLogic so getInstalledSolutionHandles can report it accurately.
const workLogicIdByWorkflowId = new Map<string, string>();

let n8nProcess: ChildProcess | null = null;
let client: AxiosInstance | null = null;
let baseUrl: string | null = null;

/** Generate or load the encryption key n8n uses for its own credentials. */
const ensureEncryptionKey = (n8nUserDir: string): string => {
  mkdirSync(n8nUserDir, { recursive: true });
  const keyPath: string = path.join(n8nUserDir, 'encryptionKey');

  if (existsSync(keyPath)) {
    return readFileSync(keyPath, 'utf8').trim();
  }

  const key: string = randomBytes(32).toString('hex');

  writeFileSync(keyPath, key, { mode: 0o600 });
  logger.info({ keyPath }, 'generated new n8n encryption key');

  return key;
};

/** Resolve path to the n8n CLI binary inside node_modules. */
const resolveN8nBinary = (): string => {
  // n8n ships its CLI at node_modules/n8n/bin/n8n.  require.resolve on the
  // package entry gives us a path inside the dist directory; walk up to find
  // the package root, then point at bin/n8n.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const entry: string = require.resolve('n8n');
  // entry looks like .../node_modules/n8n/dist/index.js; the package root is
  // two parents up.
  const pkgRoot: string = path.resolve(path.dirname(entry), '..');

  return path.join(pkgRoot, 'bin', 'n8n');
};

/**
 * Promise resolved when n8n has finished bootstrapping and is ready to serve
 * authenticated requests. We set this up before spawning n8n, then fulfil it
 * when n8n's stdout emits its end-of-boot marker.
 *
 * Background: waiting for the TCP port to accept connections is not enough.
 * n8n starts accepting HTTP connections several hundred milliseconds before
 * its auth middleware and cookie-issuing code are fully wired. During that
 * gap, /rest/login and /rest/owner/setup can return 2xx without issuing a
 * Set-Cookie header, which leaves us with no session. The end-of-boot marker
 * is logged after everything is wired.
 */
let n8nReadyPromise: Promise<void> | null = null;
let n8nReadyResolve: (() => void) | null = null;
let n8nReadyReject: ((err: Error) => void) | null = null;

/** n8n 2.17 bootstrap end-of-boot marker. */
const N8N_READY_MARKER: string = 'Editor is now accessible via';

/** Wait for n8n to be fully ready to serve authenticated requests. */
const waitForN8nReady = async (timeoutMs: number = 60000): Promise<void> => {
  if (n8nReadyPromise == null) {
    throw new Error('n8n ready promise not initialized - did start() run?');
  }

  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => {
      reject(new Error(`n8n did not emit ready marker within ${timeoutMs}ms`));
    }, timeoutMs);
  });

  await Promise.race([n8nReadyPromise, timeout]);
};

interface OwnerCredentials {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

/**
 * Load or generate the worker-internal owner credentials used to sign in to
 * the embedded n8n. These credentials are stored locally in the n8n user dir,
 * never exposed over the network (n8n binds to 127.0.0.1 only), and used
 * solely for the worker to authenticate its own REST calls.
 */
const ensureOwnerCredentials = (n8nUserDir: string): OwnerCredentials => {
  const credentialsPath: string = path.join(n8nUserDir, 'owner-credentials.json');

  if (existsSync(credentialsPath)) {
    const raw: string = readFileSync(credentialsPath, 'utf8');

    try {
      return JSON.parse(raw) as OwnerCredentials;
    } catch {
      logger.warn({ credentialsPath }, 'owner credentials file was malformed; regenerating');
    }
  }

  // n8n's password schema requires 8-64 chars, at least 1 digit, at least 1
  // uppercase letter. We use 24 bytes of random base64 (gives 32 chars with
  // mixed case + digits + symbols) which always satisfies the policy.
  const credentials: OwnerCredentials = {
    email: 'worker@ewx-worker.local',
    password: 'W' + randomBytes(24).toString('base64').replace(/[+/=]/g, '') + '9',
    firstName: 'Worker',
    lastName: 'Internal',
  };

  writeFileSync(credentialsPath, JSON.stringify(credentials), { mode: 0o600 });
  logger.info({ credentialsPath }, 'generated new n8n owner credentials');

  return credentials;
};

/**
 * Delete a workflow. In n8n 2.17 deleting a workflow is a two-step operation:
 * first POST /rest/workflows/:id/archive to soft-delete it, then DELETE
 * /rest/workflows/:id to hard-delete it. Calling DELETE directly on a
 * non-archived workflow returns 400. We always archive first so this works
 * whether the workflow is active, inactive, or already archived.
 *
 * Both calls are best-effort - we log but do not throw, because this is
 * called from rollback paths where the primary error has already been
 * reported.
 */
const archiveAndDeleteWorkflow = async (workflowId: string): Promise<void> => {
  if (client == null) return;

  try {
    const archiveResp = await client.post(`/rest/workflows/${workflowId}/archive`);

    // 200 = freshly archived, 409 = already archived; both are fine.
    if (archiveResp.status >= 400 && archiveResp.status !== 409) {
      logger.warn(
        { workflowId, status: archiveResp.status, body: archiveResp.data },
        'n8n workflow archive returned non-success; attempting delete anyway',
      );
    }
  } catch (e) {
    logger.warn({ workflowId, err: (e as Error).message }, 'n8n workflow archive threw');
  }

  try {
    const deleteResp = await client.delete(`/rest/workflows/${workflowId}`);

    if (deleteResp.status >= 400) {
      logger.warn(
        { workflowId, status: deleteResp.status, body: deleteResp.data },
        'n8n workflow delete failed',
      );
    }
  } catch (e) {
    logger.warn({ workflowId, err: (e as Error).message }, 'n8n workflow delete threw');
  }
};

/**
 * Extract the session cookie from a Set-Cookie response header. n8n sets a
 * single cookie named "n8n-auth" containing the JWT session token. We capture
 * just the name=value portion (before the first semicolon) and resend it as
 * the Cookie header on every subsequent request.
 */
const extractSessionCookie = (setCookieHeaders: string[] | undefined): string | null => {
  if (setCookieHeaders == null) return null;

  for (const header of setCookieHeaders) {
    if (header.startsWith('n8n-auth=')) {
      const firstSemicolon: number = header.indexOf(';');

      return firstSemicolon > 0 ? header.substring(0, firstSemicolon) : header;
    }
  }

  return null;
};

/**
 * Authenticate against the embedded n8n: try owner-setup first (succeeds on
 * a fresh instance, fails harmlessly on an already-initialized one), then
 * log in to get a session cookie. Sets the cookie header on the axios client
 * so every subsequent call is authenticated.
 */
const authenticate = async (credentials: OwnerCredentials): Promise<void> => {
  if (client == null) {
    throw new Error('n8n REST client not initialized');
  }

  // Step 1: try owner setup. This endpoint succeeds with 200 on a fresh
  // n8n instance (first run against a new database), and fails with 400
  // "Instance owner already setup" on subsequent runs. Either outcome is
  // fine; we just need to know which branch we're on to handle the cookie.
  const setupResp = await client.post('/rest/owner/setup', {
    email: credentials.email,
    password: credentials.password,
    firstName: credentials.firstName,
    lastName: credentials.lastName,
  });

  if (setupResp.status >= 200 && setupResp.status < 300) {
    // Fresh instance: setup succeeded and n8n returned a session cookie.
    const cookie: string | null = extractSessionCookie(setupResp.headers['set-cookie']);

    if (cookie != null) {
      client.defaults.headers.common.Cookie = cookie;
      logger.info('n8n owner setup completed; authenticated session established');

      return;
    }

    logger.warn('n8n owner setup succeeded but returned no session cookie; will try login');
  } else {
    logger.info({ status: setupResp.status }, 'n8n owner already configured; proceeding to login');
  }

  // Step 2: log in with the stored credentials to get a session cookie.
  const loginResp = await client.post('/rest/login', {
    emailOrLdapLoginId: credentials.email,
    password: credentials.password,
  });

  if (loginResp.status >= 400) {
    throw new Error(
      `n8n login failed with status ${loginResp.status}: ${JSON.stringify(loginResp.data)}. ` +
        `If this is a persistent instance, the owner-credentials.json file at ` +
        `{RED_DIRECTORY}/.n8n/ may be out of sync with the database. Delete that file AND ` +
        `node-red-data/.n8n/database.sqlite to start fresh.`,
    );
  }

  const cookie: string | null = extractSessionCookie(loginResp.headers['set-cookie']);

  if (cookie == null) {
    throw new Error('n8n login succeeded but returned no session cookie');
  }

  client.defaults.headers.common.Cookie = cookie;
  logger.info('authenticated session established via /rest/login');
};

/**
 * Walk over a parsed n8n flow JSON and substitute {{EWX_*}} placeholders in
 * every string field. Equivalent to what modifyFlowIds does for NR flows, but
 * applied to strings anywhere in the node tree. We intentionally skip n8n
 * expression strings (which start with = and use their own {{ }} syntax) to
 * avoid colliding with flow-author expressions.
 */
const substituteTemplates = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node: any,
  env: N8nFlowEnvOverride,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any => {
  if (typeof node === 'string') {
    // Skip n8n expression syntax (leading =). Flow authors use that for n8n's
    // own expression language; injecting into those would break evaluation.
    if (node.startsWith('=')) {
      return node;
    }

    return node.replace(/\{\{\s*(EWX_[A-Z_]+|BASE_URL)\s*\}\}/g, (_match, key: string) => {
      const value: string | undefined = (env as unknown as Record<string, string>)[key];

      return value ?? _match;
    });
  }

  if (Array.isArray(node)) {
    return (node as unknown[]).map((item) => substituteTemplates(item, env));
  }

  if (node != null && typeof node === 'object') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: Record<string, any> = {};

    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = substituteTemplates(v, env);
    }

    return out;
  }

  return node;
};

export const n8nRuntime: Runtime = {
  id: 'n8n',

  // The chain pallet will eventually have an N8nV1 enum value for the
  // executionEnvironment field. We also accept a lowercase alias for dev.
  executionEnvironments: ['N8nV1', 'n8n'],

  async start(_app: Express): Promise<null> {
    const n8nUserDir: string = path.join(MAIN_CONFIG.RED_DIRECTORY, '.n8n');
    const n8nPort: number = MAIN_CONFIG.N8N_INTERNAL_PORT;
    const encryptionKey: string = ensureEncryptionKey(n8nUserDir);

    const n8nEnv: Record<string, string> = {
      ...process.env,
      N8N_USER_FOLDER: n8nUserDir,
      N8N_ENCRYPTION_KEY: encryptionKey,
      N8N_PORT: String(n8nPort),
      N8N_LISTEN_ADDRESS: '127.0.0.1',
      N8N_HOST: '127.0.0.1',
      // No UI assets or public API exposed outside localhost.
      N8N_DISABLE_UI: 'true',
      N8N_PUBLIC_API_DISABLED: 'true',
      // No phone-home.
      N8N_DIAGNOSTICS_ENABLED: 'false',
      N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
      N8N_HIDE_USAGE_PAGE: 'true',
      // Don't nag about the settings file permissions.
      N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'false',
      // Don't queue; we want direct execution on the main instance.
      EXECUTIONS_MODE: 'regular',
      // Prune execution history aggressively; we don't inspect it via the UI.
      EXECUTIONS_DATA_PRUNE: 'true',
      EXECUTIONS_DATA_MAX_AGE: '24',
      // Disable optional n8n modules we don't need as a pure workflow executor.
      //
      // NOTE: community-packages stays ENABLED. Even when the module is
      // disabled via N8N_DISABLED_MODULES, the Start command's init hook
      // unconditionally calls initCommunityPackages -> getAllInstalledPackages
      // which queries the InstalledPackages DB table. If the module never
      // created that table, the query throws EntityMetadataNotFoundError and
      // kills the process. Cheaper to let n8n manage its own table than patch
      // the init hook.
      //
      // breaking-changes is also kept off the list now that we know the
      // original load failure was a zod-duplication issue, not a module issue.
      N8N_DISABLED_MODULES: 'insights,external-secrets,data-table,mcp,chat-hub,provisioning',
    };

    const binary: string = resolveN8nBinary();

    logger.info({ binary, n8nUserDir, n8nPort }, 'spawning n8n subprocess');

    // Initialize the ready promise BEFORE spawning so no stdout chunk can
    // fire the marker before we're listening for it.
    n8nReadyPromise = new Promise<void>((resolve, reject) => {
      n8nReadyResolve = resolve;
      n8nReadyReject = reject;
    });

    n8nProcess = spawn(binary, ['start'], {
      env: n8nEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    n8nProcess.stdout?.on('data', (chunk: Buffer) => {
      const text: string = chunk.toString();

      for (const line of text.split('\n')) {
        if (line.trim().length > 0) {
          logger.info({ n8n: true }, line);

          // Look for the end-of-boot marker. Once we see it, n8n's HTTP
          // server + auth middleware are fully initialized and ready to
          // issue cookies.
          if (line.includes(N8N_READY_MARKER) && n8nReadyResolve != null) {
            n8nReadyResolve();
            n8nReadyResolve = null;
            n8nReadyReject = null;
          }
        }
      }
    });

    n8nProcess.stderr?.on('data', (chunk: Buffer) => {
      const text: string = chunk.toString();

      for (const line of text.split('\n')) {
        if (line.trim().length > 0) {
          logger.warn({ n8n: true }, line);
        }
      }
    });

    n8nProcess.on('exit', (code, signal) => {
      logger.error({ code, signal }, 'n8n child process exited');

      // If n8n dies before we saw the ready marker, fail fast so start()
      // doesn't hang forever.
      if (n8nReadyReject != null) {
        n8nReadyReject(
          new Error(`n8n exited before becoming ready (code=${code}, signal=${signal})`),
        );
        n8nReadyResolve = null;
        n8nReadyReject = null;
      }

      n8nProcess = null;
    });

    // Kill n8n if the worker shuts down. Without this the child can outlive us.
    const shutdown = (): void => {
      if (n8nProcess != null) {
        logger.info('sending SIGTERM to n8n child');
        n8nProcess.kill('SIGTERM');
      }
    };

    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    process.once('exit', shutdown);

    baseUrl = `http://127.0.0.1:${n8nPort}`;

    client = axios.create({
      baseURL: baseUrl,
      timeout: 15000,
      validateStatus: (status: number) => status >= 200 && status < 500,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    await waitForN8nReady();

    const ownerCredentials: OwnerCredentials = ensureOwnerCredentials(n8nUserDir);
    await authenticate(ownerCredentials);

    // n8n manages its own child process; we do not expose an http.Server.
    return null;
  },

  async upsertSolution(input: UpsertSolutionInput): Promise<void> {
    if (client == null) {
      throw new Error('n8n runtime not started');
    }

    if (n8nProcess == null) {
      logger.error(
        { solutionId: input.solutionId },
        'n8n child process is not running; skipping install. Restart the worker to retry.',
      );

      return;
    }

    const derivedLogger = logger.child({
      solutionId: input.solutionId,
      solutionGroupId: input.solutionGroupId,
      worklogicId: input.workLogicId,
    });

    // Idempotency: same solutionId at the same workLogic is a no-op.
    const existingWorkflowId: string | undefined = installedBySolutionId.get(input.solutionId);

    if (existingWorkflowId != null) {
      const existingWorkLogic: string | undefined = workLogicIdByWorkflowId.get(existingWorkflowId);

      if (existingWorkLogic === input.workLogicId) {
        return;
      }

      // workLogic has changed: deactivate and delete the old version before
      // installing the new one. Mirrors NR's behavior in upsertSolution.
      derivedLogger.info(
        { oldWorkLogic: existingWorkLogic, newWorkLogic: input.workLogicId },
        'solution content has changed, replacing',
      );

      await this.deleteBySolutionId(input.solutionId);
    }

    // Parse the pre-fetched flow JSON and inject the EWX_* env substitutions.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: any;

    try {
      parsed = JSON.parse(input.flowContent);
    } catch (e) {
      derivedLogger.error(`failed to parse flow JSON: ${(e as Error).message}`);

      return;
    }

    if (parsed == null) {
      derivedLogger.error('flow JSON parsed to null, refusing install');

      return;
    }

    const parsedObj = parsed as { nodes?: unknown[] };

    if (!Array.isArray(parsedObj.nodes) || parsedObj.nodes.length === 0) {
      derivedLogger.error('flow JSON has no nodes array, refusing install');

      return;
    }

    const nodes: unknown[] = parsedObj.nodes;

    // n8n flows announce themselves with typeVersion on every node. Refuse
    // to install a Node-RED shaped JSON into n8n - that would be silent
    // garbage because n8n would not find any recognizable triggers.
    if (!nodes.some((n) => typeof (n as { typeVersion?: number }).typeVersion === 'number')) {
      derivedLogger.error(
        'flow JSON does not look like an n8n workflow (no typeVersion on any node)',
      );

      return;
    }

    // Excluded-nodes check (same semantics as NR's hasExcludedNodes).
    const hasExcluded: boolean = input.excludedNodes.some((rule: string) =>
      nodes.some((n) => {
        const type: string | undefined = (n as { type?: string }).type;
        return type != null && type.endsWith(rule);
      }),
    );

    if (hasExcluded) {
      derivedLogger.warn({ excludedNodes: input.excludedNodes }, 'solution has excluded nodes');

      return;
    }

    const sqlitePath: string = path.join(
      MAIN_CONFIG.SQLITE_BASE_PATH,
      input.workerAddress,
      input.solutionGroupId,
      input.solutionId,
      'db.sqlite',
    );

    mkdirSync(path.dirname(sqlitePath), { recursive: true });

    const envOverride: N8nFlowEnvOverride = {
      EWX_SOLUTION: JSON.stringify(input.solution),
      EWX_SOLUTION_ID: input.solutionId,
      EWX_SOLUTION_GROUP_ID: input.solutionGroupId,
      EWX_WORKLOGIC_ID: input.workLogicId,
      EWX_SQLITE_PATH: sqlitePath,
      EWX_WORKER_ADDRESS: input.workerAddress,
      // PALLET_RPC_URL is optional in config; when unset, the worker uses
      // baseUrls.rpcUrl resolved at config-query time. Pass empty string
      // here so the flow's env substitution still succeeds; flows that
      // actually need an RPC URL hit /config from inside the workflow.
      EWX_RPC_URL: MAIN_CONFIG.PALLET_RPC_URL ?? '',
      BASE_URL: MAIN_CONFIG.BASE_URLS,
    };

    const substituted = substituteTemplates(parsed, envOverride);

    // Build the payload n8n's REST API expects for POST /rest/workflows.
    // Set active: false on creation; activation is a separate REST call.
    const createPayload = {
      name: input.solutionId,
      nodes: substituted.nodes,
      connections: substituted.connections ?? {},
      settings: substituted.settings ?? { executionOrder: 'v1' },
      staticData: substituted.staticData ?? null,
      pinData: substituted.pinData ?? {},
      active: false,
      // meta is opaque to n8n; we use it to round-trip VCC tracking info so
      // we can rebuild our in-memory maps if needed by listing from n8n.
      meta: {
        ewxSolutionId: input.solutionId,
        ewxSolutionGroupId: input.solutionGroupId,
        ewxWorkLogicId: input.workLogicId,
      },
    };

    derivedLogger.info('installing solution');

    const createResp = await client.post('/rest/workflows', createPayload);

    if (createResp.status >= 400) {
      derivedLogger.error(
        { status: createResp.status, body: createResp.data },
        'n8n workflow create failed',
      );

      return;
    }

    // Response shape: { data: { id, versionId, ... } }.  n8n's activate
    // endpoint requires the current versionId for optimistic concurrency.
    const createdWorkflow = createResp.data?.data ?? createResp.data;
    const workflowId: string | undefined = createdWorkflow?.id;
    const versionId: string | undefined = createdWorkflow?.versionId;

    if (workflowId == null) {
      derivedLogger.error({ body: createResp.data }, 'n8n create response had no workflow id');

      return;
    }

    if (versionId == null) {
      derivedLogger.error(
        { body: createResp.data },
        'n8n create response had no versionId; cannot activate',
      );

      await archiveAndDeleteWorkflow(workflowId);

      return;
    }

    // Activate it. n8n 2.17 has a dedicated POST /rest/workflows/:id/activate
    // endpoint. The older PATCH-with-{active:true} pattern silently no-ops in
    // 2.17 because the UpdateWorkflowDto does not include an `active` field -
    // the DTO strips it, n8n returns 200, but the database active flag stays
    // false and ActiveWorkflowManager never registers the triggers.
    //
    // The activate endpoint requires the current versionId for optimistic
    // concurrency - prevents activating a workflow you haven't seen the
    // latest version of.
    const activateResp = await client.post(`/rest/workflows/${workflowId}/activate`, { versionId });

    if (activateResp.status >= 400) {
      derivedLogger.error(
        { status: activateResp.status, body: activateResp.data },
        'n8n workflow activation failed',
      );

      // Roll back the create so we don't leave a dangling inactive workflow.
      await archiveAndDeleteWorkflow(workflowId);

      return;
    }

    installedBySolutionId.set(input.solutionId, workflowId);
    solutionIdByWorkflowId.set(workflowId, input.solutionId);
    solutionGroupIdByWorkflowId.set(workflowId, input.solutionGroupId);
    workLogicIdByWorkflowId.set(workflowId, input.workLogicId);

    derivedLogger.info({ workflowId }, 'solution installed');
  },

  async deleteBySolutionId(solutionId): Promise<void> {
    if (client == null) return;

    const workflowId: string | undefined = installedBySolutionId.get(solutionId);

    if (workflowId == null) return;

    logger.info({ solutionId, workflowId }, 'removing n8n workflow');

    await archiveAndDeleteWorkflow(workflowId);

    installedBySolutionId.delete(solutionId);
    solutionIdByWorkflowId.delete(workflowId);
    solutionGroupIdByWorkflowId.delete(workflowId);
    workLogicIdByWorkflowId.delete(workflowId);
  },

  async deleteAll(): Promise<void> {
    if (client == null) return;

    const ids: string[] = Array.from(installedBySolutionId.keys());

    for (const solutionId of ids) {
      await this.deleteBySolutionId(solutionId);
    }
  },

  async deleteNodesBySolutionGroupId(solutionGroupIds): Promise<void> {
    if (client == null) return;

    const toRemove: string[] = [];

    for (const [workflowId, groupId] of solutionGroupIdByWorkflowId.entries()) {
      if (solutionGroupIds.includes(groupId)) {
        const solutionId: string | undefined = solutionIdByWorkflowId.get(workflowId);

        if (solutionId != null) {
          toRemove.push(solutionId);
        }
      }
    }

    for (const solutionId of toRemove) {
      await this.deleteBySolutionId(solutionId);
    }
  },

  async getAllInstalledSolutionsNames(): Promise<string[]> {
    return Array.from(installedBySolutionId.keys());
  },

  async getInstalledSolutionHandles(): Promise<InstalledSolutionHandle[]> {
    return Array.from(installedBySolutionId.entries()).map(([solutionId, workflowId]) => ({
      runtimeInternalId: workflowId,
      solutionId,
      solutionGroupId: solutionGroupIdByWorkflowId.get(workflowId) ?? null,
      workLogicId: workLogicIdByWorkflowId.get(workflowId) ?? null,
    }));
  },

  async getSolutionNamespace(runtimeInternalId): Promise<string | null> {
    return solutionIdByWorkflowId.get(runtimeInternalId) ?? null;
  },

  async getSolutionLogicalParts(runtimeInternalId) {
    const solutionNamespace: string | undefined = solutionIdByWorkflowId.get(runtimeInternalId);
    const solutionGroupId: string | undefined = solutionGroupIdByWorkflowId.get(runtimeInternalId);

    if (solutionNamespace == null || solutionGroupId == null) {
      return null;
    }

    return { solutionNamespace, solutionGroupId };
  },

  async getHealth() {
    // The n8n child process is considered started once it is spawned and has
    // not exited. If the process crashed, n8nProcess is null (we clear it in
    // the exit handler). Installed solutions come from the local in-memory
    // index, not a round-trip to n8n, so this is cheap.
    const started: boolean = n8nProcess != null;
    const installedSolutions: string[] = Array.from(installedBySolutionId.keys());

    return { started, installedSolutions };
  },
};
