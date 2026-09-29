import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseYamlScript, resolveWebTarget, type WebTargetConfig } from '@midscene/core/yaml';
import { ToolError } from './errors.ts';
import { bersihkanUrl } from './url.ts';

const NAMA_SAH = /^[a-zA-Z0-9_-]+$/;

/** The parsed shape this module reads: the tasks it counts plus the web target aliases. */
type SkripSkenario = { tasks?: Array<{ flow?: unknown[] }> } & WebTargetConfig;

/** Everything `run_scenario` needs to know about a saved scenario before it opens a session. */
export interface AnalisisSkenario {
  /** How many budget units one replay costs — see `hitungLangkah`. */
  langkah: number;
  /** The address the replay must open before the flow runs, if the scenario declares one. */
  url: string | undefined;
}

/**
 * Read a saved scenario once and answer both questions `run_scenario` asks of it.
 *
 * Deliberately *one* function rather than a cost reader and a URL reader side by side:
 * two entry points would mean two `parseYamlScript` calls over the same document, free
 * to disagree after a Midscene upgrade — the budget guard seeing one script and the
 * navigation seeing another. Everything below takes the already-parsed script.
 */
export function analisaSkenario(yaml: string): AnalisisSkenario {
  const skrip = uraikanSkenario(yaml);
  // Order matters: the step guards refuse unbudgetable scenarios, and a scenario that is
  // refused should say so rather than complain about its URL.
  const langkah = hitungLangkah(skrip);
  return { langkah, url: ambilUrl(skrip) };
}

/**
 * How many budget units one replay of `yaml` costs.
 *
 * Kept as the name the cost guard's tests drive, and as a thin projection of
 * `analisaSkenario` — never a second parse of its own.
 */
export function hitungLangkahSkenario(yaml: string): number {
  return analisaSkenario(yaml).langkah;
}

function uraikanSkenario(yaml: string): SkripSkenario {
  try {
    return parseYamlScript(yaml);
  } catch (err) {
    throw new ToolError(
      'INTERNAL',
      `scenario YAML could not be parsed, so its cost cannot be capped: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * The address a replay must open before the flow runs, or `undefined` if the scenario
 * names none.
 *
 * **Why this is read at all.** `Agent.runYaml` (`@midscene/core`, `agent.js:642`) builds a
 * `ScriptPlayer` over the agent it is *already* bound to; nothing in that path navigates.
 * So a `url:` sitting in a saved scenario is inert unless the session opens it first —
 * which is exactly how replay ended up asserting against a blank page.
 *
 * **Why Midscene's own resolver.** Four keys alias the web environment — `page`,
 * `browser`, `web`, `target`. Midscene defines *no* precedence between them: its
 * `resolveWebTarget` (`@midscene/core/dist/lib/yaml/utils.js`, `webTargetSources`)
 * collects every alias present and throws "Only one web target can be specified" the
 * moment two appear, so precedence can never be observed. `parseYamlScript` runs it on
 * every document it loads, which is why a multi-alias scenario is rejected before it
 * reaches this function. Calling that same resolver here — instead of re-deriving the
 * alias list — is what stops this reader from drifting away from the runner it feeds.
 */
function ambilUrl(skrip: SkripSkenario): string | undefined {
  return bersihkanUrl(resolveWebTarget(skrip)?.target?.url);
}

/**
 * Every entry in every task's `flow` reserves one *session-budget operation*. This is
 * deliberately a bounded work guard, not a meter of raw VLM requests: a single
 * Midscene AI operation can re-plan internally and make more than one model call.
 * Counting *all* steps rather than only the `ai*` ones keeps new flow vocabulary from
 * silently bypassing the guard. The few genuinely free steps (`sleep`, `javascript`,
 * `logScreenshot`) are conservatively included too.
 *
 * The parser is Midscene's own `parseYamlScript`, the same one `runYaml` feeds, so the
 * count cannot drift from what actually executes.
 *
 * One flow key is refused outright rather than counted — see `LANGKAH_TAK_TERBATAS`.
 */
function hitungLangkah(skrip: SkripSkenario): number {
  // `parseYamlScript` itself enforces that `tasks` is an array ("property \"tasks\" must
  // be an array in yaml script"), and `ScriptPlayer` calls `.map` on it, so a non-array
  // `tasks` cannot reach a single AI call. `flow` gets neither guarantee — see below.
  const tasks = Array.isArray(skrip?.tasks) ? skrip.tasks : [];
  let jumlah = 0;
  for (const [iTask, task] of tasks.entries()) {
    const flow = task?.flow;
    // A task with no `flow` at all cannot run: `playTask` opens with
    // `assert(flow, 'missing flow in task')`, which throws before any AI call.
    if (flow === undefined) continue;
    tolakBentukFlow(flow, iTask);
    for (const [iLangkah, langkah] of (flow as unknown[]).entries()) {
      tolakLangkahTakTerbatas(langkah, iTask, iLangkah);
    }
    jumlah += (flow as unknown[]).length;
  }
  return jumlah;
}

/**
 * Refuse a `flow` that is present but is not a sequence.
 *
 * This closes a bypass that a `flow`-is-an-array assumption left wide open. Written as a
 * YAML *mapping* rather than a sequence:
 *
 * ```yaml
 * tasks:
 *   - name: t
 *     flow:
 *       s1:
 *         runGherkinScenario: |
 *           Given ...
 * ```
 *
 * `parseYamlScript` accepts it (it validates `tasks` is an array but never checks
 * `flow`), and Midscene runs it: `playTask` does `assert(flow, ...)` — a non-empty object
 * is truthy — then `for (const flowItemIndex in flow)` at `yaml/player.mjs:115`. `for…in`
 * walks object keys, so every value is dispatched exactly as a sequence entry would be.
 * Meanwhile a guard that did `Array.isArray(task.flow) ? task.flow : []` skipped the
 * whole thing, counted 0, and never inspected a single item — so a Gherkin step hidden in
 * a mapping ran unbounded and uncached at a charge of zero.
 *
 * **Rejecting outright, rather than iterating the mapping's values through the same
 * per-item checks.** Both would close today's hole, but only rejection is stable:
 *
 * - `MidsceneYamlTask.flow` is declared `MidsceneYamlFlowItem[]`. A mapping works purely
 *   by accident of `for…in`, against the package's own declared type.
 * - Iterating would mean maintaining an emulation of that accident. If Midscene ever
 *   changes how it walks a non-array `flow`, our count silently drifts again — the exact
 *   failure mode being fixed here, reintroduced one layer down.
 * - Nothing in this server emits a mapping-shaped flow; the exploration tools produce
 *   sequences. Refusing costs real usage nothing.
 *
 * Rejection cannot drift, because an unsupported shape never reaches the runner at all.
 */
function bentukFlow(flow: unknown): string {
  if (flow === null) return 'an empty value';
  return typeof flow === 'object' ? 'a mapping' : `a ${typeof flow}`;
}

function tolakBentukFlow(flow: unknown, iTask: number): void {
  if (Array.isArray(flow)) return;
  throw new ToolError(
    'SCENARIO_UNSUPPORTED',
    `task ${iTask + 1} writes "flow" as ${bentukFlow(flow)}, ` +
      'not a list of steps. Midscene still executes some of these shapes (a mapping is ' +
      'walked with for-in), so they cannot be left uncounted, and their cost cannot be ' +
      'bounded reliably. Write flow as a YAML sequence — one "- " entry per step, e.g. ' +
      '"flow:\\n  - ai: click sign in\\n  - aiAssert: the dashboard is visible" — which is ' +
      'the shape the exploration tools already produce.',
  );
}

/**
 * Flow keys whose cost cannot be bounded before the run, so they are refused instead of
 * counted.
 *
 * `runGherkinScenario` is the whole list today. It is a single flow item that expands at
 * runtime into an unbounded number of AI operations — there is no step cap anywhere in
 * `@midscene/core/dist/es/agent/run-gherkin-scenario.mjs` — so counting it as one step
 * lets a scenario perform arbitrarily many paid calls against a cap of one. Worse,
 * `yaml/player.mjs:150-156` dispatches it with `cacheable: false`, so Midscene's cache
 * never applies to any of those calls: every replay pays the vision model in full, which
 * defeats the "replay is nearly free" premise this product is built on, not merely the
 * budget cap.
 *
 * Rejecting is honest here precisely *because* nothing in this server emits the key: the
 * exploration tools produce `ai` / `aiAssert`-shaped steps, so refusing costs the agent
 * nothing and needs no Gherkin parsing. And it must be refused rather than tolerated,
 * because `save_scenario` takes an arbitrary YAML string straight from the agent — and
 * the agent is exactly who a cost guard exists to bound.
 */
const LANGKAH_TAK_TERBATAS = ['runGherkinScenario'] as const;

/**
 * Mirror Midscene's own dispatch, which branches on `'runGherkinScenario' in flowItem` —
 * key *presence*, not truthiness. A key present but empty still reaches the runner.
 */
function tolakLangkahTakTerbatas(langkah: unknown, iTask: number, iLangkah: number): void {
  if (typeof langkah !== 'object' || langkah === null) return;
  for (const kunci of LANGKAH_TAK_TERBATAS) {
    if (!(kunci in langkah)) continue;
    throw new ToolError(
      'SCENARIO_UNSUPPORTED',
      `scenario uses "${kunci}" (task ${iTask + 1}, step ${iLangkah + 1}), which cannot be ` +
        'budgeted: it expands into an unbounded number of AI operations at run time, and ' +
        'Midscene runs those steps with caching disabled, so every replay pays the vision ' +
        'model in full. Rewrite the flow as explicit steps instead — `ai`, `aiAssert`, ' +
        '`aiWaitFor` and friends, the same shape the exploration tools (act / assert / ' +
        'query) already produce. The guard reserves one session-budget operation for ' +
        'each explicit flow item; eligible operations can use Midscene caching, but one ' +
        'operation may still make multiple internal model calls while it replans.',
    );
  }
}

export class ScenarioStore {
  #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  #validasi(name: string): void {
    if (!NAMA_SAH.test(name)) {
      throw new ToolError(
        'INTERNAL',
        `invalid scenario name "${name}"; use letters, digits, hyphen and underscore only`,
      );
    }
  }

  pathFor(name: string): string {
    this.#validasi(name);
    return join(this.#dir, `${name}.yaml`);
  }

  async save(name: string, yaml: string): Promise<string> {
    const path = this.pathFor(name);
    await mkdir(this.#dir, { recursive: true });
    await writeFile(path, yaml, 'utf8');
    return path;
  }

  async load(name: string): Promise<string> {
    const path = this.pathFor(name);
    try {
      return await readFile(path, 'utf8');
    } catch {
      throw new ToolError('SCENARIO_NOT_FOUND', `scenario "${name}" does not exist`);
    }
  }

  async list(): Promise<string[]> {
    try {
      const berkas = await readdir(this.#dir);
      return berkas
        .filter((f) => f.endsWith('.yaml'))
        .map((f) => f.slice(0, -'.yaml'.length))
        .sort();
    } catch {
      return [];
    }
  }
}
