import { invertObject } from '../util/invert-object';

type NodeRedZId = string;
type SolutionNamespace = string;

export type NodeRedSolutionCache = Record<NodeRedZId, SolutionNamespace>;

// Copied from @node-red/runtime
export const NODE_RED_LOG_LEVELS: Record<string, number> = Object.freeze({
  off: 1,
  fatal: 10,
  error: 20,
  warn: 30,
  info: 40,
  debug: 50,
  trace: 60,
  audit: 98,
  metric: 99,
});

export const REVERSED_NODE_RED_LOG_LEVELS: Record<number, string> = Object.freeze(
  invertObject(NODE_RED_LOG_LEVELS),
);

let NODE_RED_SOLUTION_CACHE: NodeRedSolutionCache = {};

export const setNodeRedSolutionCache = (cache: NodeRedSolutionCache): void => {
  NODE_RED_SOLUTION_CACHE = cache;
};

export const getNodeRedSolutionNamespace = (z?: NodeRedZId): SolutionNamespace | undefined => {
  if (z == null) {
    return undefined;
  }

  return NODE_RED_SOLUTION_CACHE[z];
};
