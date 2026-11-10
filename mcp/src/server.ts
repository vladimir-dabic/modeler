/// <reference types="node" />
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ModelerApi } from '../../src/api/ModelerApi';
import type { ApiResult } from '../../src/api/core';
import { fullGuide } from '../../src/api/guide';
import { ModelDocument } from '../../src/model/Document';
import { parseDocumentFile } from '../../src/model/io';
import type { BridgeServer } from './bridge';
import type { NodeFileHost } from './files';

export const SERVER_VERSION = '0.1.0';

/** Operations that run in Node even in live mode (they touch files; the tab never does). */
const FILE_OPS = new Set(['open_file', 'save_file', 'export_stl', 'import_dxf']);
/** File operations that change the model: in live mode their result is pushed to the tab. */
const PUSH_BACK = new Set(['open_file', 'import_dxf']);

const STATUS_TOOL = {
  name: 'connection_status',
  description:
    'Where your calls go. "live": the modeler open in the user\'s browser (changes appear there as undo steps, render_views works). "headless": this server\'s own in-memory model (use open_file / save_file / export_stl). Call this first.',
  inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
};

const MCP_NOTES = `This MCP server has two modes (see connection_status):
- live: the user clicked "Connect AI" in the open modeler app. Every call edits that model; the user sees it happen and can undo each call.
- headless: no app is connected. Calls edit an in-memory model in this server. open_file / save_file / export_stl read and write files in the working folder (paths are relative to it).
File operations always run in this server, also in live mode (save_file then saves what the app shows).`;

export interface ModelerServerOptions {
  files: NodeFileHost;
  /** A started bridge, or undefined when the live bridge is off or its port was taken. */
  bridge?: BridgeServer;
  /** Human-readable bridge state for connection_status, e.g. "listening on ws://127.0.0.1:47830". */
  bridgeStatus: string;
}

function labelFor(name: string, input: unknown): string {
  const given = (input as { label?: unknown } | null)?.label;
  const text = typeof given === 'string' && given.trim() ? given.trim() : name.replace(/_/g, ' ');
  return `AI: ${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * The Modeler MCP server: every Modeler API operation as an MCP tool (same names, schemas
 * and descriptions), routed to the connected app tab when there is one, else to a
 * headless in-memory document. See docs/ai-integration.md and ADR 0013.
 */
export function createModelerServer(opts: ModelerServerOptions) {
  const { files, bridge } = opts;
  const local = new ModelerApi(new ModelDocument(), { files });
  const kinds = new Map(local.operations().map((op) => [op.name, op.kind]));
  const tools = [
    STATUS_TOOL,
    ...local.toolDefinitions({ includeHostOps: true }).map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema as typeof STATUS_TOOL.inputSchema })),
  ];
  const live = () => !!bridge?.connected;
  /** Remind once per headless stretch that changes are not in the app. */
  let headlessNoted = false;
  if (bridge) bridge.onChange = () => (headlessNoted = false);

  async function fileOp(name: string, input: unknown, label: string): Promise<ApiResult> {
    if (!live()) return local.callAsync(name, input, { source: 'mcp', label });
    // Live: run on a scratch copy of the tab's document, in Node.
    const scratch = new ModelerApi(new ModelDocument(), { files });
    if (name !== 'open_file') {
      const { file, selection } = await bridge!.getFile();
      scratch.doc.load(parseDocumentFile(JSON.stringify(file)), true);
      scratch.doc.setSelection(selection);
    }
    const result = await scratch.callAsync(name, input, { source: 'mcp', label });
    if (PUSH_BACK.has(name) && result.ok) {
      const pushed = await bridge!.loadFile(scratch.doc.toFile(), label);
      if (!pushed.ok) return pushed;
    }
    return result;
  }

  async function route(name: string, input: unknown): Promise<ApiResult> {
    if (name === STATUS_TOOL.name) {
      return {
        ok: true,
        data: {
          mode: live() ? 'live' : 'headless',
          bridge: opts.bridgeStatus,
          working_folder: files.root,
          current_file: files.currentPath ?? null,
          headless_parts: local.doc.entities.length,
        },
      };
    }
    const label = labelFor(name, input);
    const path = (input as { path?: unknown })?.path;
    if (FILE_OPS.has(name)) {
      const verb = name === 'open_file' ? 'Open' : name === 'import_dxf' ? 'Import' : '';
      return fileOp(name, input, verb && typeof path === 'string' ? `AI: ${verb} ${path}` : label);
    }
    if (live()) return bridge!.call(name, input, label);
    const result = await local.callAsync(name, input, { source: 'mcp', label });
    const kind = kinds.get(name);
    if (result.ok && (kind === 'write' || kind === 'settings') && !headlessNoted) {
      headlessNoted = true;
      const note = bridge
        ? 'No app is connected, so this changed the MCP server\'s own model, not one in the browser. Use save_file / export_stl to keep it, or ask the user to click Connect AI in the app.'
        : 'Headless mode: this changed the MCP server\'s own model. Use save_file / export_stl to keep it.';
      result.warnings = [...(result.warnings ?? []), note];
    }
    return result;
  }

  const server = new Server(
    { name: 'modeler', version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: `${fullGuide()}\n\n${MCP_NOTES}` },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    let result: ApiResult;
    try {
      result = await route(name, args ?? {});
    } catch (err) {
      result = { ok: false, error: { code: 'internal', message: (err as Error)?.message ?? String(err) } };
    }
    return toToolResult(name, result);
  });

  return { server, local };
}

/** ApiResult → MCP tool result: compact JSON text, plus PNG image blocks for render_views. */
export function toToolResult(name: string, result: ApiResult): CallToolResult {
  if (result.ok && name === 'render_views') {
    const images = (result.data as { images: { view: string; png: string }[] }).images;
    return {
      content: [
        { type: 'text', text: JSON.stringify({ ok: true, data: { views: images.map((i) => i.view) } }) },
        ...images.map((i) => ({ type: 'image' as const, data: i.png, mimeType: 'image/png' })),
      ],
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(result.ok ? {} : { isError: true }) };
}
