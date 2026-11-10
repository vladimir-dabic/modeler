/// <reference types="node" />
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ModelerApi } from '../src/api';
import { generateApiReference } from '../src/api/reference';
import { ModelDocument } from '../src/model/Document';

const FILE = 'docs/api-reference.md';

describe('docs/api-reference.md', () => {
  it('matches the operation definitions (run `npm run docs:api` to update)', () => {
    const md = generateApiReference(new ModelerApi(new ModelDocument()));
    if (process.env.UPDATE_DOCS) writeFileSync(FILE, md);
    let current = '';
    try {
      current = readFileSync(FILE, 'utf8');
    } catch {
      // missing file fails below
    }
    expect(current, 'API reference is stale: run `npm run docs:api`').toBe(md);
  });
});
