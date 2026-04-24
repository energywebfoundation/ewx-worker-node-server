# n8n runtime

This document describes the n8n workflow runtime added to the Worker Node. It covers the architecture, lifecycle, auth, known quirks, and operational notes. For general Worker Node documentation see [../README.md](../README.md).

## What this adds

A second workflow runtime that runs alongside Node-RED. Solutions whose chain-declared `executionEnvironment` is `N8nV1` are installed into n8n; every other solution continues to run on Node-RED exactly as before. Both runtimes share the same vote submission pipeline, the same signing key, and the same `localhost:3002/sse/1` endpoint.

The existing Node-RED logic is unchanged. Solutions already declared `NodeRedV1` (or with the field empty) behave byte-identically to the previous release.

## Architecture

A new `src/runtime/` directory introduces a `Runtime` interface with four methods (`start`, `upsertSolution`, `deleteBySolutionId`, `deleteAll`) and two implementations:

- `src/runtime/node-red/red-runtime.ts` wraps the existing `src/node-red/red.ts` behind the new interface. No behavior change.
- `src/runtime/n8n/n8n-runtime.ts` spawns n8n as a managed child process and talks to it over its local REST API.

`src/runtime/registry.ts` owns the runtime instances and picks one per solution. `src/solution.ts` no longer talks to Node-RED directly; it goes through the registry and so treats both runtimes uniformly.

`src/vote.ts` accepts either a `noderedId` (legacy Node-RED path) or a `solutionId` (the new n8n path) in vote POST bodies and resolves the vote against whichever runtime owns the solution.

## Runtime selection

When reconciling each subscribed solution, the worker picks a runtime:

1. If `DEV_RUNTIME_OVERRIDES` names a runtime for this `solutionId`, use that.
2. Otherwise read `workload.executionEnvironment` from the chain:
   - `NodeRedV1` or empty: route to Node-RED (default, backward compatible).
   - `N8nV1`: route to n8n.
   - Anything else: skip the solution and emit a single warning.

If a solution migrates between runtimes across reconciles (chain state change, or the dev override being toggled), the worker removes the solution from its previous runtime before installing it on the new one.

## Lifecycle of an n8n solution

```
┌─────────┐   1   ┌────────────┐  2   ┌─────────────┐  3   ┌────────────┐
│ chain   │ ───▶  │ solution.ts│ ───▶ │ registry.ts │ ───▶ │ n8n        │
│ pallet  │       │ reconcile  │      │ picks n8n   │      │ runtime    │
└─────────┘       └────────────┘      └─────────────┘      └─────┬──────┘
                                                                 │
                   4 create + activate via REST                  │
                      ┌──────────────────────────────────────────┘
                      ▼
               ┌──────────────┐  5   ┌──────────────┐  6   ┌─────────┐
               │ n8n child    │ ───▶ │ schedule     │ ───▶ │ vote.ts │
               │ process      │      │ trigger fires│      │ /sse/1  │
               └──────────────┘      │ every N sec  │      └────┬────┘
                                     └──────────────┘           │
                                                                │ 7 sign
                                                                ▼
                                                          ┌───────────┐
                                                          │ EWX chain │
                                                          └───────────┘
```

1. The worker polls the chain for subscribed solutions.
2. `solution.ts` sees vcc-1, routes it through the registry.
3. Registry picks the n8n runtime based on `executionEnvironment` or dev override.
4. n8n-runtime `POST /rest/workflows` then `POST /rest/workflows/:id/activate` with the `versionId` returned from create.
5. n8n activates the workflow; scheduler registers the trigger.
6. The trigger fires on its cadence; the flow POSTs `{solutionId, root}` to the worker's vote server on `localhost:3002/sse/1`.
7. The worker signs the vote with the operator seed and submits the extrinsic to the configured `VOTING_RPC_URL`.

## Starting n8n

The runtime spawns `node_modules/n8n/bin/n8n start` with a curated environment:

- `N8N_USER_FOLDER=<RED_DIRECTORY>/.n8n`: n8n stores its SQLite database, owner credentials, and encryption key here. Wiped on every boot by the existing `startRedServer` logic, so each start is a fresh instance.
- `N8N_LISTEN_ADDRESS=127.0.0.1` and `N8N_HOST=127.0.0.1`: binds to loopback only.
- `N8N_DISABLE_UI=true` and `N8N_PUBLIC_API_DISABLED=true`: no external surface.
- `N8N_DIAGNOSTICS_ENABLED=false` and `N8N_VERSION_NOTIFICATIONS_ENABLED=false`: no phone-home.
- `EXECUTIONS_MODE=regular`, `EXECUTIONS_DATA_PRUNE=true`, `EXECUTIONS_DATA_MAX_AGE=24`: direct execution on the main instance, aggressive pruning.
- `N8N_DISABLED_MODULES=insights,external-secrets,data-table,mcp,chat-hub,provisioning`: turn off modules the worker doesn't need. The `community-packages` module is kept enabled on purpose; disabling it causes n8n's init hook to query a table that was never created, which crashes the process.

## Readiness detection

TCP-level readiness is not sufficient. n8n starts accepting HTTP connections several hundred milliseconds before its auth middleware and cookie-issuing code are fully wired. During that gap, `/rest/login` and `/rest/owner/setup` can return 2xx without issuing a `Set-Cookie` header, which leaves the worker with no session and every subsequent REST call failing with 401.

To avoid the race, the worker watches n8n's stdout and waits for the end-of-boot marker:

```
Editor is now accessible via:
```

This line is emitted after the HTTP server, middleware, and auth service are all fully initialized. Only after seeing it does the runtime proceed to authenticate.

A 60 second timeout and an exit watcher cover the error cases.

## Authentication

n8n 2.17 enforces REST authentication on `/rest/workflows` and related endpoints even on a loopback-only instance. There is no "disable auth entirely" flag. The runtime handles this with a worker-internal owner account:

1. On first boot the runtime generates a random owner email and a policy-compliant password (32 base64 chars plus markers, satisfying 8-64 length, at least one digit, at least one uppercase).
2. Credentials are persisted at `<RED_DIRECTORY>/.n8n/owner-credentials.json` with `0600` permissions. They never leave the machine.
3. On every boot the runtime `POST /rest/owner/setup` first (succeeds on a fresh n8n instance, harmlessly fails with 400 on an already-initialized one), then falls back to `POST /rest/login`.
4. The `n8n-auth` cookie from the `Set-Cookie` response header is captured and pinned on the axios client. Every subsequent REST call is authenticated.

## Workflow operations

n8n 2.17 requires specific patterns for each operation:

- **Create**: `POST /rest/workflows` with `{name, nodes, connections, settings, active: false, meta: {...}}`. The response contains `{id, versionId, ...}` on `response.data.data`. The `meta` field is used to round-trip the VCC tracking info (`ewxSolutionId`, `ewxSolutionGroupId`, `ewxWorkLogicId`).
- **Activate**: `POST /rest/workflows/:id/activate` with `{versionId}`. The older PATCH-with-`{active: true}` pattern silently no-ops in 2.17 because `UpdateWorkflowDto` does not include `active` among its allowed fields.
- **Delete**: `POST /rest/workflows/:id/archive`, then `DELETE /rest/workflows/:id`. Calling DELETE directly on a non-archived workflow returns `400 Workflow must be archived before it can be deleted`.

The runtime exposes an `archiveAndDeleteWorkflow()` helper that encapsulates the two-step delete and is used by both the rollback path and `deleteBySolutionId`.

## Flow placeholder substitution

Flow JSON can contain `{{EWX_SOLUTION_ID}}` tokens that the runtime substitutes at install time. This lets a single flow file be reused for differently-named solutions without per-solution manual edits.

See `test-flows/vcc-1.json` for the canonical example: the code node emits `solutionId: '{{EWX_SOLUTION_ID}}'` which becomes `solutionId: 'vcc-1'` after substitution.

## Environment variables

See [./env-vars.md](./env-vars.md) for the full list. The ones specific to this runtime:

| Variable                   | Purpose                                                                                               | Default |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | ------- |
| `N8N_INTERNAL_PORT`        | Port n8n binds to on 127.0.0.1.                                                                       | 5678    |
| `DEV_RUNTIME_OVERRIDES`    | Dev-only. Force `solutionId=runtimeId` pairs regardless of chain state. Example: `vcc-1=n8n`.         | (empty) |
| `DEV_LOCAL_FLOW_OVERRIDES` | Dev-only. Load flow JSON from a local file instead of IPFS. Example: `vcc-1=./test-flows/vcc-1.json`. | (empty) |

The two `DEV_*` variables are strictly for local iteration. In production the chain is the source of truth for both the runtime and the flow content.

## Dependencies

- `n8n` is pinned to `2.17.4` in `package.json`. Upgrading requires checking the workflow controller endpoints and DTOs, because n8n's internal REST API is not a stable public interface.
- `package.json` contains a top-level `overrides: { zod: "3.25.67" }`. This is required because earlier versions of `zod` in the dependency tree break `z.discriminatedUnion` inside `@n8n/api-types`. Without the override, n8n's logging subsystem fails to load.

## Operational notes

**Fresh n8n state on every boot.** The existing `startRedServer` logic wipes `RED_DIRECTORY` on every startup. This includes the `.n8n` subdirectory, so the n8n SQLite database, owner credentials, and encryption key are regenerated each time. This keeps boots deterministic and avoids drift between the worker's in-memory solution map and n8n's database.

**If n8n gets into a bad state**, delete the directory manually and restart:

```bash
rm -rf node-red-data/.n8n
```

**Logging is verbose during boot.** n8n emits ~150 migration lines on every start. This is unavoidable without patching n8n and is not harmful. Once boot completes, steady-state logging is quiet.

**The Python task runner warning** (`Failed to start Python task runner in internal mode`) is benign. The worker uses only JavaScript code nodes. Left as-is to avoid divergence from stock n8n.

**`VOTING_RPC_URL` must point to a chain endpoint that accepts extrinsics.** A read-only public RPC will reject vote submissions with `-32000: Extrinsic is not allowed on public ewx node`. Use the worker-node-protocol RPC.

## What is not covered yet

- Cross-runtime solution migration on a running worker has been tested only in one direction (install fresh to n8n). Full rotation (solution moves from NR to n8n and back) is exercised by the reconcile loop but not stress-tested.
- The `VotingRoundSettled` event path has been observed for vcc-1 but not yet for all proof types of the SBP circuit.
- There are no unit tests for the n8n runtime. The branch is verified by end-to-end testing against mainnet.
