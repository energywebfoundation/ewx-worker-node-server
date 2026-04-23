import { type Express } from 'express';
import { type SolutionGroupId, type SolutionId, type WorkerAddress } from '../polkadot/polka';

/**
 * A runtime is a workflow execution engine (Node-RED, n8n, ...) that the worker
 * drives. Every runtime exposes the same contract so the solution loop does not
 * need to know which one is behind a given solution.
 *
 * The contract intentionally mirrors the existing Node-RED code's public
 * surface from src/node-red/red.ts, so back-porting that code into the NR
 * runtime implementation is a pure refactor with no behavior change.
 */
export interface Runtime {
  /** Stable identifier used in logs and by the registry. */
  readonly id: 'node-red' | 'n8n';

  /**
   * Execution environment values on the chain that this runtime should handle.
   * The chain stores a string on each solution at workload.executionEnvironment.
   * If that string matches one of these values, the solution is routed here.
   */
  readonly executionEnvironments: readonly string[];

  /**
   * One-time initialization. For NR this runs RED.init + RED.start. For n8n
   * this spawns the child process and waits until the REST API is reachable.
   * Called during main bootstrap.
   */
  start: (app: Express) => Promise<void>;

  /**
   * Install or update a solution's flow. Idempotent: if the same solutionId
   * is already installed with the same worklogicId, this is a no-op.
   */
  upsertSolution: (input: UpsertSolutionInput) => Promise<void>;

  /** Remove a single solution by its chain-level solutionId. */
  deleteBySolutionId: (solutionId: SolutionId) => Promise<void>;

  /** Remove every solution installed in this runtime. Called on boot. */
  deleteAll: () => Promise<void>;

  /** Remove every solution whose solution group appears in the given list. */
  deleteNodesBySolutionGroupId: (solutionGroupIds: string[]) => Promise<void>;

  /** List solution IDs currently installed in this runtime. */
  getAllInstalledSolutionsNames: () => Promise<string[]>;

  /**
   * Return a runtime-opaque handle describing an installed solution so the
   * solution loop can ask about it via getSolutionNamespace /
   * getSolutionLogicalParts. The only assumption the caller makes is that
   * entries can be filtered and counted.
   */
  getInstalledSolutionHandles: () => Promise<InstalledSolutionHandle[]>;

  /**
   * Given a runtime-internal identifier (e.g. an NR tab id, or an n8n workflow
   * id), return the solution namespace it is running. Returns null if the id
   * is not known to this runtime.
   */
  getSolutionNamespace: (runtimeInternalId: string) => Promise<string | null>;

  /**
   * Given a runtime-internal identifier, return both the solution namespace
   * and solution group id for it. Used by the vote router and status endpoints.
   */
  getSolutionLogicalParts: (
    runtimeInternalId: string,
  ) => Promise<{ solutionNamespace: string; solutionGroupId: string } | null>;

  /**
   * Return this runtime's current health: whether it is started and what
   * solutions are installed. Used by the /health/readiness endpoint.
   */
  getHealth: () => Promise<RuntimeHealth>;
}

export interface RuntimeHealth {
  /** True if the runtime has successfully booted and is ready to handle work. */
  started: boolean;
  /** Solution IDs currently installed in this runtime. */
  installedSolutions: string[];
}

/**
 * Discriminated identifier used when a caller wants to resolve a solution by
 * either its NR tab id or its chain-level solutionId. Makes intent explicit at
 * call sites and avoids ambiguous (undefined, 'value') argument shapes.
 */
export type SolutionIdentifier =
  | { kind: 'noderedId'; value: string }
  | { kind: 'solutionId'; value: string };

export interface UpsertSolutionInput {
  solutionGroupId: SolutionGroupId;
  solutionId: SolutionId;
  /** The full on-chain Solution object (for EWX_SOLUTION env). */
  solution: object;
  workLogicId: string;
  /** Node types the worker should refuse to install (e.g. 'file', 'exec'). */
  excludedNodes: string[];
  workerAddress: WorkerAddress;
  /** The already-fetched flow JSON from IPFS or local source. */
  flowContent: string;
}

export interface InstalledSolutionHandle {
  /** Runtime-internal id, e.g. NR tab id or n8n workflow id. */
  runtimeInternalId: string;
  /** The chain-level solutionId this handle represents, or null if missing. */
  solutionId: string | null;
  /** The chain-level solutionGroupId this handle represents, or null. */
  solutionGroupId: string | null;
  /** The worklogic id recorded in the installed instance, or null. */
  workLogicId: string | null;
}
