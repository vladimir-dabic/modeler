/// <reference types="node" />
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import type { ApiResult } from '../../src/api/core';
import type { DocumentFile } from '../../src/model/types';
import {
  BRIDGE_INFO_PATH,
  BRIDGE_PROTOCOL,
  CLOSE_PROTOCOL,
  CLOSE_REPLACED,
  type BridgeMessage,
  type BridgeRequest,
  type BridgeWelcome,
  type TabFile,
} from '../../src/bridge/protocol';
import { LOCAL_HOST, serveStatic } from './static';

/** Origins of the app allowed to connect by default (Vite dev and preview). */
export const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'];

export interface BridgeServerOptions {
  port: number;
  /** Exact `Origin` values allowed to connect (ADR 0013). */
  origins: string[];
  /** Serve the built web app from this folder on the same port (ADR 0026). */
  appDir?: string;
  /** How long a request may take in the tab (render_views on a big model can be slow). */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

interface Pending {
  resolve(result: ApiResult): void;
  timer: ReturnType<typeof setTimeout>;
}

const HELLO_TIMEOUT = 5000;
const MAX_MESSAGE = 32 * 1024 * 1024;

/**
 * The server end of the live bridge: a WebSocket on 127.0.0.1 that one modeler tab dials
 * after the user clicks "Connect AI". Only the configured app origins may connect; a new
 * tab replaces the old one. Requests are forwarded to the tab and answered with ApiResults.
 */
export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private http: Server | null = null;
  private tab: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly log: (msg: string) => void;
  /** Called when a tab connects or disconnects. */
  onChange?: (connected: boolean) => void;

  constructor(private readonly opts: BridgeServerOptions) {
    this.log = opts.log ?? (() => {});
  }

  get connected(): boolean {
    return this.tab?.readyState === WebSocket.OPEN;
  }

  get port(): number | undefined {
    return (this.http?.address() as AddressInfo | undefined)?.port;
  }

  /** Listen on 127.0.0.1. Rejects if the port is taken (e.g. another MCP server owns it). */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // One port for both: plain HTTP serves the app (when packaged with it), and the
      // WebSocket upgrade is the bridge.
      const appDir = this.opts.appDir;
      const http = createServer((req, res) => {
        // The app served from here asks which port its bridge is on (it may not be the default).
        if (req.url === BRIDGE_INFO_PATH && LOCAL_HOST.test(req.headers.host ?? '')) {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ app: 'modeler', protocol: BRIDGE_PROTOCOL, port: this.port }));
          return;
        }
        if (appDir) serveStatic(appDir, req, res);
        else res.writeHead(404, { 'content-type': 'text/plain' }).end('Modeler MCP bridge. Open the modeler app and click Connect AI.');
      });
      const wss = new WebSocketServer({
        server: http,
        maxPayload: MAX_MESSAGE,
        verifyClient: (info: { origin: string; req: IncomingMessage }) => this.allowed(info.origin, info.req),
      });
      wss.on('connection', (socket) => this.accept(socket));
      // A WebSocketServer re-emits its http server's errors (e.g. EADDRINUSE); without a
      // listener that would crash the process instead of letting start() report it.
      wss.on('error', () => {});
      http.once('error', reject);
      http.listen(this.opts.port, '127.0.0.1', () => {
        this.http = http;
        this.wss = wss;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    this.dropTab('server closing');
    const wss = this.wss;
    const http = this.http;
    this.wss = null;
    this.http = null;
    return new Promise((resolve) => {
      if (!wss || !http) return resolve();
      wss.close(() => {
        http.closeAllConnections?.();
        http.close(() => resolve());
      });
    });
  }

  /** Run an API operation in the tab. */
  call(name: string, input: unknown, label?: string): Promise<ApiResult> {
    return this.request({ type: 'call', name, input, label });
  }

  async getFile(): Promise<TabFile> {
    const result = await this.request({ type: 'get_file' });
    if (!result.ok) throw new Error(result.error.message);
    return result.data as TabFile;
  }

  loadFile(file: DocumentFile, label: string): Promise<ApiResult> {
    return this.request({ type: 'load_file', file, label });
  }

  // ---- internals ------------------------------------------------------------------

  private allowed(origin: string | undefined, req: IncomingMessage): boolean {
    // The Host check stops DNS-rebinding pages; the Origin check stops every other web page.
    const host = req.headers.host ?? '';
    const okHost = LOCAL_HOST.test(host);
    const okOrigin = !!origin && this.opts.origins.includes(origin);
    if (!okHost || !okOrigin) this.log(`refused bridge connection (origin ${origin ?? 'none'}, host ${host})`);
    return okHost && okOrigin;
  }

  private accept(socket: WebSocket) {
    let greeted = false;
    const helloTimer = setTimeout(() => !greeted && socket.close(CLOSE_PROTOCOL, 'no hello'), HELLO_TIMEOUT);
    socket.on('message', (raw) => {
      let msg: BridgeMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!greeted) {
        if (msg.type !== 'hello' || msg.app !== 'modeler' || msg.protocol !== BRIDGE_PROTOCOL) {
          socket.close(CLOSE_PROTOCOL, `server speaks protocol ${BRIDGE_PROTOCOL}`);
          return;
        }
        greeted = true;
        clearTimeout(helloTimer);
        if (this.tab && this.tab !== socket) {
          this.dropTab('replaced by another tab');
        }
        this.tab = socket;
        socket.send(JSON.stringify({ type: 'welcome', protocol: BRIDGE_PROTOCOL, server: 'modeler-mcp' } satisfies BridgeWelcome));
        this.log('app connected');
        this.onChange?.(true);
        return;
      }
      if (msg.type === 'result' && socket === this.tab) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg.result);
      }
    });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (socket !== this.tab) return;
      this.tab = null;
      this.failPending('The app disconnected before answering');
      this.log('app disconnected');
      this.onChange?.(false);
    });
    socket.on('error', (err) => this.log(`bridge socket error: ${err.message}`));
  }

  private dropTab(why: string) {
    const old = this.tab;
    if (!old) return;
    this.tab = null;
    this.failPending(`The app connection was closed (${why})`);
    old.close(CLOSE_REPLACED, why);
    this.onChange?.(false);
  }

  private failPending(message: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: { code: 'unsupported', message, hint: 'Ask the user to reopen the app and click Connect AI.' } });
      this.pending.delete(id);
    }
  }

  private request(body: DistributiveOmit<BridgeRequest, 'id'>): Promise<ApiResult> {
    const tab = this.tab;
    if (!tab || tab.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ ok: false, error: { code: 'unsupported', message: 'No app is connected', hint: 'Ask the user to open the modeler and click Connect AI.' } });
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: { code: 'internal', message: `The app did not answer within ${Math.round((this.opts.timeoutMs ?? 60000) / 1000)} s` } });
      }, this.opts.timeoutMs ?? 60000);
      this.pending.set(id, { resolve, timer });
      tab.send(JSON.stringify({ ...body, id }));
    });
  }
}
