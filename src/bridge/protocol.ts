import type { ApiResult } from '../api/core';
import type { DocumentFile } from '../model/types';

/**
 * The live bridge between the MCP server (Node) and an open modeler tab (ADR 0013).
 * The tab dials out to the server on 127.0.0.1; the server sends requests, the tab answers.
 * DOM-free: shared by `src/bridge/BridgeClient.ts` and `mcp/src/bridge.ts`.
 */

/** Bump on incompatible message changes; both sides refuse a mismatch. */
export const BRIDGE_PROTOCOL = 1;

/** The fixed local port the server listens on and the app dials (override: `--port` / `?aiPort=`). */
export const DEFAULT_BRIDGE_PORT = 47830;

/** Server → tab. */
export type BridgeRequest =
  /** Run one API operation in the tab (any kind, including render_views). */
  | { type: 'call'; id: number; name: string; input: unknown; label?: string }
  /** Return the tab's document and selection as a `TabFile` (for save_file / export_stl, which run in Node). */
  | { type: 'get_file'; id: number }
  /** Replace the tab's document with this file, as one undo step (open_file). */
  | { type: 'load_file'; id: number; file: DocumentFile; label: string };

/** The answer to `get_file`. */
export interface TabFile {
  file: DocumentFile;
  selection: string[];
}

/** Tab → server. */
export type BridgeMessage =
  | { type: 'hello'; protocol: number; app: 'modeler' }
  | { type: 'result'; id: number; result: ApiResult };

/** Server → tab, once after a valid hello. */
export interface BridgeWelcome {
  type: 'welcome';
  protocol: number;
  server: string;
}

/** WebSocket close code the server uses when another tab takes over the connection. */
export const CLOSE_REPLACED = 4000;
/** WebSocket close code for a protocol mismatch or a malformed hello. */
export const CLOSE_PROTOCOL = 4001;
