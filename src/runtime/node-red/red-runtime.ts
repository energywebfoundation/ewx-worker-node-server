import { type Express } from 'express';
import { type Runtime, type UpsertSolutionInput, type InstalledSolutionHandle } from '../runtime';
import {
  startRedServer,
  upsertSolution as redUpsertSolution,
  deleteNodeById,
  deleteAll as redDeleteAll,
  deleteNodesBySolutionGroupId as redDeleteByGroupIds,
  getAllInstalledSolutionsNames as redGetAll,
  getInstalledSolution as redGetInstalled,
  getTabNodes as redGetTabNodes,
  getSolutionNamespace as redGetSolutionNamespace,
  getSolutionLogicalParts as redGetLogicalParts,
  getNodeEnv as redGetNodeEnv,
} from '../../node-red/red';

/**
 * Node-RED runtime. Wraps the existing src/node-red/red.ts logic behind the
 * Runtime interface. Behavior is byte-identical to the pre-runtime-refactor
 * code, preserved for production flows on the chain today.
 */
export const nodeRedRuntime: Runtime = {
  id: 'node-red',

  // NodeRedV1 is the current chain value. Empty string is also handled because
  // solutions deployed before the runtime-type field existed default to NR.
  executionEnvironments: ['NodeRedV1', ''],

  async start(app: Express): Promise<void> {
    await startRedServer(app);
  },

  async upsertSolution(input: UpsertSolutionInput): Promise<void> {
    await redUpsertSolution(
      input.solutionGroupId,
      input.solutionId,
      input.solution,
      input.workLogicId,
      input.excludedNodes,
      input.workerAddress,
      input.flowContent,
    );
  },

  async deleteBySolutionId(solutionId): Promise<void> {
    const existing = await redGetInstalled(solutionId);

    if (existing != null) {
      await deleteNodeById(existing.id);
    }
  },

  async deleteAll(): Promise<void> {
    await redDeleteAll();
  },

  async deleteNodesBySolutionGroupId(solutionGroupIds): Promise<void> {
    await redDeleteByGroupIds(solutionGroupIds);
  },

  async getAllInstalledSolutionsNames(): Promise<string[]> {
    return await redGetAll();
  },

  async getInstalledSolutionHandles(): Promise<InstalledSolutionHandle[]> {
    const tabs = await redGetTabNodes();

    return tabs.map((t) => ({
      runtimeInternalId: t.id,
      solutionId: redGetNodeEnv(t, 'EWX_SOLUTION_ID', false) ?? null,
      solutionGroupId: redGetNodeEnv(t, 'EWX_SOLUTION_GROUP_ID', false) ?? null,
      workLogicId: redGetNodeEnv(t, 'EWX_WORKLOGIC_ID', false) ?? null,
    }));
  },

  async getSolutionNamespace(runtimeInternalId): Promise<string | null> {
    return await redGetSolutionNamespace(runtimeInternalId);
  },

  async getSolutionLogicalParts(runtimeInternalId) {
    return await redGetLogicalParts(runtimeInternalId);
  },
};
