import type { ModelerApi } from './ModelerApi';

/**
 * Markdown reference for every operation, generated from the same definitions the API
 * uses at runtime (descriptions + JSON Schemas). tests/api-reference.test.ts keeps
 * docs/api-reference.md in sync; `npm run docs:api` regenerates it.
 */

type Schema = Record<string, any>;

function typeOf(s: Schema | undefined): string {
  if (!s) return 'any';
  if (s.enum) return s.enum.map((v: unknown) => JSON.stringify(v)).join(' \\| ');
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.anyOf || s.oneOf) return (s.anyOf ?? s.oneOf).map(typeOf).join(' \\| ');
  if (s.type === 'array') {
    if (Array.isArray(s.prefixItems)) return `[${s.prefixItems.map(typeOf).join(', ')}]`;
    return `${typeOf(s.items)}[]`;
  }
  if (s.type === 'object') {
    const keys = Object.keys(s.properties ?? {});
    return keys.length ? `{ ${keys.join(', ')} }` : 'object';
  }
  if (s.type === 'integer') return 'integer';
  return s.type ?? 'any';
}

const KIND_NOTE: Record<string, string> = {
  read: 'read (no change)',
  write: 'write (one undo step)',
  settings: 'settings (not undoable)',
  history: 'undo / redo',
  host: 'needs a host capability (async)',
};

export function generateApiReference(api: ModelerApi): string {
  const ops = api.operations();
  const tools = new Map(api.toolDefinitions({ includeHostOps: true }).map((t) => [t.name, t]));
  const lines: string[] = [
    '# Modeler API reference',
    '',
    '> Generated from `src/api` by `npm run docs:api`. Do not edit by hand: change the operation',
    '> descriptions/schemas in code instead. Design and conventions: [modeler-api.md](modeler-api.md).',
    '',
    'All lengths are millimetres, angles degrees, world Z-up. Write operations return `{ ids }` (usable as `$alias` in `apply_operations`).',
    '',
    '| Operation | Kind |',
    '|---|---|',
    ...ops.map((op) => `| [\`${op.name}\`](#${op.name.replace(/_/g, '_')}) | ${KIND_NOTE[op.kind]} |`),
    '',
  ];
  for (const op of ops) {
    const schema = tools.get(op.name)!.input_schema as Schema;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    const required = new Set<string>(schema.required ?? []);
    lines.push(`## ${op.name}`, '', `*${KIND_NOTE[op.kind]}*`, '', op.description, '');
    const keys = Object.keys(props);
    if (keys.length) {
      lines.push('| Field | Type | Required | Notes |', '|---|---|---|---|');
      for (const k of keys) {
        const p = props[k];
        const note = (p.description ?? '').replace(/\|/g, '\\|');
        lines.push(`| \`${k}\` | ${typeOf(p).replace(/\n/g, ' ')} | ${required.has(k) ? 'yes' : ''} | ${note} |`);
      }
      lines.push('');
    } else {
      lines.push('No input.', '');
    }
  }
  return lines.join('\n');
}
