import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseYamlScript } from '@midscene/core/yaml';
import { ToolError } from './errors.ts';

const NAMA_SAH = /^[a-zA-Z0-9_-]+$/;

/**
 * How many budget units one replay of `yaml` costs.
 *
 * Every entry in every task's `flow` counts as one unit. Counting *all* steps rather
 * than only the `ai*` ones is deliberate: this is a cost guard, so it must round
 * towards charging more, and Midscene's flow vocabulary grows between releases — a
 * key this file has never heard of must not be free by default. The few genuinely
 * free steps (`sleep`, `javascript`, `logScreenshot`) are cheap to over-charge and
 * rare in the scenarios this server writes.
 *
 * The parser is Midscene's own `parseYamlScript`, the same one `runYaml` feeds, so the
 * count cannot drift from what actually executes.
 *
 * One flow key is refused outright rather than counted — see `LANGKAH_TAK_TERBATAS`.
 */
export function hitungLangkahSkenario(yaml: string): number {
  let skrip: { tasks?: Array<{ flow?: unknown[] }> };
  try {
    skrip = parseYamlScript(yaml);
  } catch (err) {
    throw new ToolError(
      'INTERNAL',
      `scenario YAML could not be parsed, so its cost cannot be capped: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const tasks = Array.isArray(skrip?.tasks) ? skrip.tasks : [];
  let jumlah = 0;
  for (const [iTask, task] of tasks.entries()) {
    const flow = Array.isArray(task?.flow) ? task.flow : [];
    for (const [iLangkah, langkah] of flow.entries()) {
      tolakLangkahTakTerbatas(langkah, iTask, iLangkah);
    }
    jumlah += flow.length;
  }
  return jumlah;
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
        'query) already produce. Each of those is counted and charged individually, and ' +
        'each one caches.',
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
