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
 * Known residual gap: `runGherkinScenario` is a single flow item that expands to an
 * arbitrary number of AI steps at runtime, so it is under-charged at 1. Nothing in this
 * server writes that step, and expanding it would mean parsing Gherkin here; the cap
 * still bounds every other shape of scenario.
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
  for (const task of tasks) {
    jumlah += Array.isArray(task?.flow) ? task.flow.length : 0;
  }
  return jumlah;
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
