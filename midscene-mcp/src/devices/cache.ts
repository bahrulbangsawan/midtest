import type { DeviceOpts } from './types.ts';

/** The Midscene agent options that actually switch the task cache on. */
export interface OpsiCacheAgent {
  cacheId?: string;
  cache?: { id: string };
}

/**
 * Translate our `DeviceOpts` into the agent options that actually build a `TaskCache`.
 *
 * `cacheId` alone is **not** enough. `processCacheConfig(cache, cacheId)` in
 * `@midscene/core/dist/es/utils.mjs` only reaches its `cacheId` branch when the
 * `MIDSCENE_CACHE` env var is truthy; with `cache === undefined` and the env var unset
 * it returns `undefined`, `Agent` skips `new TaskCache(...)`, and every replay pays the
 * vision model in full — while `run_scenario` advertises the opposite.
 *
 * The fix is the modern `cache` option, which takes the `void 0 !== cache` branch
 * regardless of the environment. It must be the object form: `Agent#processCacheConfig`
 * calls `validateAgentCacheInput(opts.cache)` first, and that function *throws* on the
 * bare `cache: true` ("cache: true requires an explicit cache ID"). `{ id }` passes
 * validation and is returned as-is, so `Agent` constructs the `TaskCache`.
 *
 * `cacheId` is kept alongside it: it is still a valid `AgentOpt`, and it keeps the id
 * identical on the legacy env-var path.
 *
 * Both adapters go through here so the two cannot drift apart.
 */
export function opsiCache(opts: DeviceOpts): OpsiCacheAgent {
  if (!opts.cacheId) return {};
  return { cacheId: opts.cacheId, cache: { id: opts.cacheId } };
}
