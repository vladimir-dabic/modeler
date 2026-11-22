import { z } from 'zod';
import type { ModelDocument } from '../model/Document';
import type { Entity, Group } from '../model/types';
import { checkPrintFit, printerVolume, WORKSPACES } from '../model/workspaces';
import { ApiError, entityLine, OperationContext, validateEntity, type ApiHost, type ApiResult, type ChangeSummary } from './core';
import { OPERATIONS, type OperationDef } from './operations';

export interface CallMeta {
  /** Who is calling; recorded for future activity history. */
  source?: 'ui' | 'assistant' | 'mcp' | 'test';
  /** Undo-history label, e.g. "AI: add 4 shelves". Defaults to the operation name. */
  label?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const ALIAS = /^\$[A-Za-z_][\w-]*$/;
const MAX_BATCH = 200;

const BatchInput = z.strictObject({
  operations: z
    .array(
      z.strictObject({
        name: z.string().min(1).describe('Operation name, e.g. "add_box"'),
        input: z.record(z.string(), z.unknown()).describe('That operation\'s input'),
        as: z.string().regex(/^[A-Za-z_][\w-]*$/).optional().describe('Name the result; later steps can use "$name" wherever an id is expected'),
      }),
    )
    .min(1)
    .max(MAX_BATCH),
  label: z.string().max(80).optional().describe('Short undo-history label for the whole batch, e.g. "add 4 shelves"'),
});

function labelFor(name: string): string {
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The Modeler API (ADR 0008): the one way to change the model. The UI, the in-app AI
 * assistant and the MCP server all call it. See docs/modeler-api.md.
 */
export class ModelerApi {
  private readonly ops = new Map<string, OperationDef<any>>();
  private readonly ctx: OperationContext;

  constructor(
    readonly doc: ModelDocument,
    readonly host?: ApiHost,
  ) {
    this.ctx = new OperationContext(doc, host);
    for (const op of OPERATIONS) this.ops.set(op.name, op);
    this.ops.set('apply_operations', {
      name: 'apply_operations',
      kind: 'write',
      description:
        'Run several operations as ONE atomic step (all or nothing, one undo). Name a step\'s result with "as" and refer to it later as "$name" (in ids lists, group, about). Use this to build a whole assembly in a single call.',
      input: BatchInput,
      run: (_ctx, input: z.output<typeof BatchInput>) => this.runBatch(input),
    });
  }

  /** Operation definitions (for building tool lists). */
  operations(): OperationDef<any>[] {
    return [...this.ops.values()];
  }

  /** Tool definitions for AI clients (Claude tools / MCP): name, description, JSON Schema. */
  toolDefinitions(opts: { includeHostOps?: boolean } = {}): ToolDefinition[] {
    return this.operations()
      .filter((op) => opts.includeHostOps || op.kind !== 'host')
      .map((op) => {
        const schema = z.toJSONSchema(op.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
        delete schema.$schema;
        return { name: op.name, description: op.description, input_schema: schema };
      });
  }

  /** Run one operation synchronously. Host operations need callAsync. */
  call(name: string, input: unknown = {}, meta: CallMeta = {}): ApiResult {
    const op = this.ops.get(name);
    if (!op) return this.fail(new ApiError('not_found', `Unknown operation "${name}"`, `Operations: ${[...this.ops.keys()].join(', ')}`));
    if (op.kind === 'host') return this.fail(new ApiError('unsupported', `${name} is asynchronous`, 'Use callAsync.'));
    return this.execute(op, input, meta);
  }

  async callAsync(name: string, input: unknown = {}, meta: CallMeta = {}): Promise<ApiResult> {
    const op = this.ops.get(name);
    if (op?.kind === 'host') {
      try {
        const parsed = this.parse(op, input);
        return { ok: true, data: await op.runAsync!(this.ctx, parsed) };
      } catch (err) {
        return this.fail(err);
      }
    }
    return this.call(name, input, meta);
  }

  // ---- execution --------------------------------------------------------------------

  private parse(op: OperationDef<any>, input: unknown, pathPrefix = '') {
    const result = op.input.safeParse(input ?? {});
    if (result.success) return result.data;
    const issue = result.error.issues[0];
    const path = [pathPrefix, ...issue.path.map(String)].filter(Boolean).join('.');
    const more = result.error.issues.length > 1 ? ` (+${result.error.issues.length - 1} more)` : '';
    throw new ApiError('invalid_input', `${op.name}: ${path ? `${path}: ` : ''}${issue.message}${more}`, undefined, path || undefined);
  }

  private execute(op: OperationDef<any>, input: unknown, meta: CallMeta): ApiResult {
    try {
      const parsed = this.parse(op, input);
      if (op.kind !== 'write') return { ok: true, data: op.run!(this.ctx, parsed) };
      return this.runWrite(op, parsed, meta);
    } catch (err) {
      return this.fail(err);
    }
  }

  /** One transaction: run, validate everything that changed, commit, or roll back on any error. */
  private runWrite(op: OperationDef<any>, parsed: unknown, meta: CallMeta): ApiResult {
    const { doc } = this;
    const before = new Map(doc.entities.map((e) => [e.id, JSON.stringify(e)]));
    const groupsBefore = new Map(doc.groups.map((g) => [g.id, g.name]));
    const token = doc.checkpoint();
    const own = !doc.inTransaction;
    if (own) doc.begin();
    try {
      const data = op.run!(this.ctx, parsed);
      doc.syncComponents(before);
      const changes = this.diff(before, groupsBefore);
      for (const id of changes.touched) validateEntity(doc.get(id)!);
      if (own) doc.commit(meta.label ?? (parsed as { label?: string }).label ?? labelFor(op.name));
      const warnings = this.warnings(changes.touched);
      return { ok: true, data, changes: changes.summary, ...(warnings.length ? { warnings } : {}) };
    } catch (err) {
      doc.rollback(token);
      if (own) doc.cancel();
      return this.fail(err);
    }
  }

  private runBatch(input: z.output<typeof BatchInput>) {
    const aliases = new Map<string, string[]>();
    const steps: { name: string; ids?: string[] }[] = [];
    input.operations.forEach((step, i) => {
      const where = `step ${i + 1} (${step.name})`;
      const op = this.ops.get(step.name);
      if (!op) throw new ApiError('not_found', `${where}: unknown operation`, `Operations: ${[...this.ops.keys()].join(', ')}`);
      if (op.name === 'apply_operations' || op.kind === 'host' || op.kind === 'history') {
        throw new ApiError('invalid_input', `${where}: ${op.name} can't run inside a batch`);
      }
      let parsed: unknown;
      try {
        parsed = this.parse(op, this.substitute(step.input, aliases), `operations.${i}.input`);
      } catch (err) {
        throw this.prefix(err, where);
      }
      let data: unknown;
      try {
        data = op.run!(this.ctx, parsed);
      } catch (err) {
        throw this.prefix(err, where);
      }
      const ids = (data as { ids?: string[] } | undefined)?.ids;
      if (step.as) aliases.set(step.as, ids ?? []);
      steps.push({ name: step.name, ...(ids ? { ids } : {}) });
    });
    const all = [...new Set(steps.flatMap((s) => s.ids ?? []))];
    return { steps: steps.length, ids: all, aliases: Object.fromEntries(aliases) };
  }

  /** Replace "$alias" strings: inside arrays they expand to all ids, elsewhere to a single id. */
  private substitute(value: unknown, aliases: Map<string, string[]>): unknown {
    const lookup = (s: string) => {
      const ids = aliases.get(s.slice(1));
      if (!ids) throw new ApiError('invalid_input', `Unknown alias "${s}"`, 'Name an earlier step with "as".');
      return ids;
    };
    if (typeof value === 'string' && ALIAS.test(value)) {
      const ids = lookup(value);
      if (ids.length !== 1) throw new ApiError('invalid_input', `"${value}" refers to ${ids.length} parts here; use it inside an ids list`);
      return ids[0];
    }
    if (Array.isArray(value)) {
      return value.flatMap((v) => (typeof v === 'string' && ALIAS.test(v) ? lookup(v) : [this.substitute(v, aliases)]));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.substitute(v, aliases)]));
    }
    return value;
  }

  private prefix(err: unknown, where: string): ApiError {
    if (err instanceof ApiError) return new ApiError(err.code, `${where}: ${err.message.replace(/^[a-z_]+: /, '')}`, err.hint, err.path);
    return new ApiError('internal', `${where}: ${(err as Error)?.message ?? String(err)}`);
  }

  private diff(before: Map<string, string>, groupsBefore: Map<string, string>) {
    const { doc } = this;
    const after = new Map(doc.entities.map((e) => [e.id, e]));
    const added: Entity[] = [];
    const updated: Entity[] = [];
    for (const [id, e] of after) {
      const prev = before.get(id);
      if (prev === undefined) added.push(e);
      else if (prev !== JSON.stringify(e)) updated.push(e);
    }
    const removed = [...before.keys()].filter((id) => !after.has(id)).map((id) => {
      const e = JSON.parse(before.get(id)!) as Entity;
      return `${id} "${e.name}"`;
    });
    const groupsAfter = new Map(doc.groups.map((g) => [g.id, g]));
    const groupsAdded = [...groupsAfter.values()].filter((g) => !groupsBefore.has(g.id));
    const groupsRemoved = [...groupsBefore.entries()].filter(([id]) => !groupsAfter.has(id));
    const summary: ChangeSummary = {
      added: added.map((e) => entityLine(e, doc.groups)),
      updated: updated.map((e) => entityLine(e, doc.groups)),
      removed,
    };
    if (groupsAdded.length) summary.groups_added = groupsAdded.map((g: Group) => `${g.id} "${g.name}"`);
    if (groupsRemoved.length) summary.groups_removed = groupsRemoved.map(([id, name]) => `${id} "${name}"`);
    return { summary, touched: [...added, ...updated].map((e) => e.id) };
  }

  /** Print-fit problems for the parts this call touched (Print workspace only). */
  private warnings(touched: string[]): string[] {
    if (!touched.length || !WORKSPACES[this.doc.workspace].printPlate) return [];
    const set = new Set(touched);
    return checkPrintFit(this.doc.entities, printerVolume(this.doc.printer))
      .filter((i) => set.has(i.id))
      .map((i) => `${i.id} "${i.name}" ${i.message}`);
  }

  private fail(err: unknown): ApiResult {
    if (err instanceof ApiError) {
      return { ok: false, error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}), ...(err.path ? { path: err.path } : {}) } };
    }
    console.error(err);
    return { ok: false, error: { code: 'internal', message: (err as Error)?.message ?? String(err) } };
  }
}
