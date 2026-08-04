import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ToolError } from './errors.ts';

const NAMA_SAH = /^[a-zA-Z0-9_-]+$/;

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
