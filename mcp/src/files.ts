/// <reference types="node" />
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { ApiError, type FileHost } from '../../src/api/core';

const MAX_READ = 20 * 1024 * 1024;

const exists = (path: string) => stat(path).then(() => true, () => false);

/**
 * File access for the MCP server, limited to one working folder (ADR 0013): paths are
 * resolved against it, and anything that ends up outside it (`..`, absolute paths,
 * symlinks) is refused.
 */
export class NodeFileHost implements FileHost {
  currentPath?: string;

  private constructor(readonly root: string) {}

  static async create(root: string): Promise<NodeFileHost> {
    const real = await realpath(resolve(root));
    if (!(await stat(real)).isDirectory()) throw new Error(`Not a folder: ${root}`);
    return new NodeFileHost(real);
  }

  async readText(path: string): Promise<string> {
    const full = this.lexical(path);
    let real: string;
    try {
      real = await realpath(full);
    } catch {
      throw new ApiError('not_found', `No file "${path}"`, `Paths are relative to ${this.root}`, 'path');
    }
    this.check(real, path);
    const info = await stat(real);
    if (!info.isFile()) throw new ApiError('invalid_input', `"${path}" is not a file`, undefined, 'path');
    if (info.size > MAX_READ) throw new ApiError('invalid_input', `"${path}" is too large (${Math.round(info.size / 1e6)} MB)`, undefined, 'path');
    return readFile(real, 'utf8');
  }

  async write(path: string, data: string | Uint8Array): Promise<string> {
    const full = this.lexical(path);
    // The nearest existing folder (and the file, if it exists and is a symlink) must
    // resolve inside the root, before anything is created.
    let dir = dirname(full);
    while (!(await exists(dir))) dir = dirname(dir);
    this.check(await realpath(dir), path, true);
    await mkdir(dirname(full), { recursive: true });
    const existing = await realpath(full).catch(() => null);
    if (existing) this.check(existing, path);
    await writeFile(full, data);
    return relative(this.root, full);
  }

  private lexical(path: string): string {
    const full = resolve(this.root, path);
    this.check(full, path);
    return full;
  }

  private check(full: string, shown: string, allowRoot = false) {
    const rel = relative(this.root, full);
    if ((rel === '' && !allowRoot) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ApiError('invalid_input', `"${shown}" is outside the working folder`, `Use a path inside ${this.root}`, 'path');
    }
  }
}
