import type { ApiResult } from '../api/core';
import type { ModelerApi } from '../api/ModelerApi';
import { parseDocumentFile } from '../model/io';
import { BRIDGE_PROTOCOL, CLOSE_PROTOCOL, CLOSE_REPLACED, DEFAULT_BRIDGE_PORT, type BridgeMessage, type BridgeRequest, type TabFile } from './protocol';

/** The part of the WebSocket API we use, so tests can pass Node's `ws` client. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'close' | 'error' | 'message', fn: (ev: any) => void): void;
}

export type BridgeStatus = 'off' | 'waiting' | 'connected';

export interface BridgeClientOptions {
  port?: number;
  /** How long to wait between connection attempts while waiting for the server. */
  retryMs?: number;
  createSocket?: (url: string) => SocketLike;
  onStatus?: (status: BridgeStatus, why?: string) => void;
  /**
   * Called before each request runs. The app cancels a tool operation in progress here,
   * so an AI change never lands inside the user's open transaction.
   */
  beforeRequest?: () => void;
  /** Called after each request that changed the model, with its undo label (for a toast). */
  onModelChange?: (label: string) => void;
}

const OPEN = 1;

/**
 * The app side of the live MCP bridge (ADR 0013). After the user clicks "Connect AI" it
 * dials the local MCP server, retrying until one is running, and runs the server's
 * requests on the tab's ModelerApi. It never touches files; the server does that in Node.
 */
export class BridgeClient {
  private socket: SocketLike | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private _status: BridgeStatus = 'off';
  readonly url: string;

  constructor(
    private readonly api: ModelerApi,
    private readonly opts: BridgeClientOptions = {},
  ) {
    this.url = `ws://127.0.0.1:${opts.port ?? DEFAULT_BRIDGE_PORT}`;
  }

  get status(): BridgeStatus {
    return this._status;
  }

  /** Start connecting (and keep retrying until stop()). */
  start(): void {
    if (this._status !== 'off') return;
    this.setStatus('waiting');
    this.dial();
  }

  stop(why?: string): void {
    clearTimeout(this.retryTimer);
    const s = this.socket;
    this.socket = null;
    if (s && s.readyState <= OPEN) s.close(1000, 'disconnect');
    this.setStatus('off', why);
  }

  private setStatus(status: BridgeStatus, why?: string) {
    if (status === this._status && !why) return;
    this._status = status;
    this.opts.onStatus?.(status, why);
  }

  private dial() {
    const socket = this.opts.createSocket ? this.opts.createSocket(this.url) : (new WebSocket(this.url) as SocketLike);
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      const hello: BridgeMessage = { type: 'hello', protocol: BRIDGE_PROTOCOL, app: 'modeler' };
      socket.send(JSON.stringify(hello));
    });
    socket.addEventListener('message', (ev) => {
      if (this.socket !== socket) return;
      void this.onMessage(socket, String(ev.data));
    });
    // A failed dial fires error then close; handle everything in close.
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (ev?.code === CLOSE_REPLACED) return this.stop('Another tab took over the AI connection');
      if (ev?.code === CLOSE_PROTOCOL) return this.stop(`The MCP server speaks a different bridge version (${ev.reason || 'mismatch'}); update the app or the server`);
      const was = this._status;
      this.setStatus('waiting', was === 'connected' ? 'AI disconnected; waiting for it to come back' : undefined);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        if (this._status === 'waiting' && !this.socket) this.dial();
      }, this.opts.retryMs ?? 2000);
    });
  }

  private async onMessage(socket: SocketLike, text: string) {
    let msg: BridgeRequest | { type: 'welcome' };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'welcome') {
      this.setStatus('connected');
      return;
    }
    if (this._status !== 'connected') return;
    const result = await this.handle(msg);
    if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: 'result', id: msg.id, result } satisfies BridgeMessage));
  }

  private async handle(msg: BridgeRequest): Promise<ApiResult> {
    const { doc } = this.api;
    try {
      if (msg.type !== 'get_file') this.opts.beforeRequest?.();
      if (msg.type === 'call') {
        const result = await this.api.callAsync(msg.name, msg.input, { source: 'mcp', label: msg.label });
        if (result.ok && result.changes) this.opts.onModelChange?.(msg.label ?? msg.name);
        return result;
      }
      if (msg.type === 'get_file') return { ok: true, data: { file: doc.toFile(), selection: [...doc.selection] } satisfies TabFile };
      if (msg.type === 'load_file') {
        // Re-validate: the tab trusts nothing it is sent.
        const file = parseDocumentFile(JSON.stringify(msg.file));
        doc.load(file, false, msg.label);
        this.opts.onModelChange?.(msg.label);
        return { ok: true, data: { parts: file.entities.length } };
      }
      return { ok: false, error: { code: 'invalid_input', message: `Unknown bridge request "${(msg as { type: string }).type}"` } };
    } catch (err) {
      return { ok: false, error: { code: 'internal', message: (err as Error)?.message ?? String(err) } };
    }
  }
}
