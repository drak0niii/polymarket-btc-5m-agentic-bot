export type PolymarketSocketConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed';

export interface PolymarketSocketLogger {
  debug?: (message: string, metadata?: Record<string, unknown>) => void;
  log?: (message: string, metadata?: Record<string, unknown>) => void;
  warn?: (message: string, metadata?: Record<string, unknown>) => void;
  error?: (message: string, metadata?: Record<string, unknown>) => void;
}

export interface PolymarketSocketTrafficEvent {
  receivedAt: string;
  kind: 'heartbeat' | 'message';
  rawText: string;
}

export interface PolymarketSocketCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface PolymarketSocketClientHandlers {
  onConnecting?: (attempt: number) => void;
  onOpen?: () => void | Promise<void>;
  onTraffic?: (event: PolymarketSocketTrafficEvent) => void | Promise<void>;
  onMessage?: (
    payload: unknown,
    event: PolymarketSocketTrafficEvent,
  ) => void | Promise<void>;
  onClose?: (event: PolymarketSocketCloseEvent) => void | Promise<void>;
  onStale?: (event: { detectedAt: string; staleAfterMs: number }) => void | Promise<void>;
  onPermanentFailure?: (reasonCode: string) => void | Promise<void>;
}

export interface PolymarketSocketClientOptions {
  name: string;
  url: string;
  getInitialSubscriptionMessage: () => Promise<string | Record<string, unknown>> | string | Record<string, unknown>;
  webSocketFactory?: (url: string) => PolymarketSocket;
  heartbeatIntervalMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectMaxAttempts?: number;
  reconnectJitterRatio?: number;
  staleAfterMs: number;
  logger?: PolymarketSocketLogger;
  handlers?: PolymarketSocketClientHandlers;
}

interface PolymarketSocketMessageEvent {
  data: unknown;
}

interface PolymarketSocketCloseFrame {
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

export interface PolymarketSocket {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: PolymarketSocketMessageEvent) => void) | null;
  onclose: ((event: PolymarketSocketCloseFrame) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

function defaultWebSocketFactory(url: string): PolymarketSocket {
  const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (url: string) => PolymarketSocket })
    .WebSocket;
  if (!WebSocketCtor) {
    throw new Error('global_websocket_unavailable');
  }

  return new WebSocketCtor(url);
}

interface Deferred<T> {
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  promise: Promise<T>;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { resolve, reject, promise };
}

export class PolymarketWebSocketClient {
  private readonly heartbeatIntervalMs: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectMaxAttempts: number;
  private readonly reconnectJitterRatio: number;
  private readonly logger: PolymarketSocketLogger;
  private readonly handlers: PolymarketSocketClientHandlers;
  private readonly webSocketFactory: (url: string) => PolymarketSocket;

  private socket: PolymarketSocket | null = null;
  private running = false;
  private expectedClose = false;
  private outboundQueue: string[] = [];
  private heartbeatHandle: NodeJS.Timeout | null = null;
  private staleHandle: NodeJS.Timeout | null = null;
  private reconnectHandle: NodeJS.Timeout | null = null;
  private connectionStatus: PolymarketSocketConnectionStatus = 'idle';
  private reconnectAttempt = 0;
  private connectWaiters = new Set<Deferred<void>>();
  private lastTrafficAt: string | null = null;
  private permanentFailureReason: string | null = null;

  constructor(private readonly options: PolymarketSocketClientOptions) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 500;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 10_000;
    this.reconnectMaxAttempts = options.reconnectMaxAttempts ?? 6;
    this.reconnectJitterRatio = options.reconnectJitterRatio ?? 0.2;
    this.logger = options.logger ?? {};
    this.handlers = options.handlers ?? {};
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
  }

  async start(): Promise<void> {
    if (this.running && this.isOpen()) {
      return;
    }

    this.running = true;
    this.expectedClose = false;
    this.permanentFailureReason = null;
    return this.awaitConnected();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.expectedClose = true;
    this.permanentFailureReason = null;
    this.connectionStatus = 'idle';
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.clearStaleTimer();
    this.rejectConnectWaiters(new Error('socket_stopped'));

    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      try {
        socket.close(1000, 'client_stop');
      } catch {
        // Ignore close failures during shutdown.
      }
    }
  }

  async triggerReconnect(reason = 'reconnect_requested'): Promise<void> {
    if (!this.running) {
      return;
    }

    this.logger.warn?.(`${this.options.name} reconnect requested.`, {
      reason,
    });

    this.clearHeartbeatTimer();
    this.clearStaleTimer();
    this.clearReconnectTimer();

    const socket = this.socket;
    this.socket = null;
    this.expectedClose = false;
    this.connectionStatus = 'disconnected';

    if (socket) {
      try {
        socket.close(4001, reason.slice(0, 120));
      } catch {
        // Best effort only.
      }
    }

    this.scheduleReconnect(reason);
  }

  async send(payload: string | Record<string, unknown>): Promise<void> {
    const serialized =
      typeof payload === 'string' ? payload : JSON.stringify(payload);

    if (!this.isOpen()) {
      this.outboundQueue.push(serialized);
      return;
    }

    this.sendRaw(serialized);
  }

  getConnectionStatus(): PolymarketSocketConnectionStatus {
    return this.connectionStatus;
  }

  getLastTrafficAt(): string | null {
    return this.lastTrafficAt;
  }

  getReconnectAttempt(): number {
    return this.reconnectAttempt;
  }

  getPermanentFailureReason(): string | null {
    return this.permanentFailureReason;
  }

  private async awaitConnected(): Promise<void> {
    if (this.permanentFailureReason) {
      throw new Error(this.permanentFailureReason);
    }

    if (this.isOpen()) {
      return;
    }

    const deferred = createDeferred<void>();
    this.connectWaiters.add(deferred);
    this.connectIfNeeded();
    return deferred.promise;
  }

  private connectIfNeeded(): void {
    if (!this.running || this.socket || this.reconnectHandle) {
      return;
    }

    this.connectionStatus = 'connecting';
    this.reconnectAttempt += 1;
    this.handlers.onConnecting?.(this.reconnectAttempt);

    let socket: PolymarketSocket;
    try {
      socket = this.webSocketFactory(this.options.url);
    } catch (error) {
      const reasonCode =
        error instanceof Error ? error.message : 'websocket_factory_failed';
      this.logger.error?.(`${this.options.name} websocket construction failed.`, {
        reasonCode,
      });
      this.scheduleReconnect(reasonCode);
      return;
    }

    this.socket = socket;
    socket.onopen = () => {
      void this.handleOpen();
    };
    socket.onmessage = (event) => {
      void this.handleMessage(event);
    };
    socket.onclose = (event) => {
      void this.handleClose({
        code: typeof event.code === 'number' ? event.code : 1006,
        reason: typeof event.reason === 'string' ? event.reason : '',
        wasClean: event.wasClean === true,
      });
    };
    socket.onerror = () => {
      this.logger.warn?.(`${this.options.name} websocket emitted an error frame.`);
    };
  }

  private async handleOpen(): Promise<void> {
    this.connectionStatus = 'connected';
    this.reconnectAttempt = 0;
    this.logger.log?.(`${this.options.name} websocket connected.`, {
      url: this.options.url,
    });

    try {
      const initialMessage = await this.options.getInitialSubscriptionMessage();
      await this.send(initialMessage);
      await this.handlers.onOpen?.();
      this.resolveConnectWaiters();
      this.startHeartbeatTimer();
      this.resetStaleTimer();
    } catch (error) {
      const reasonCode =
        error instanceof Error ? error.message : 'initial_subscription_failed';
      this.logger.error?.(`${this.options.name} initial subscription failed.`, {
        reasonCode,
      });
      await this.triggerReconnect(reasonCode);
    }
  }

  private async handleMessage(event: PolymarketSocketMessageEvent): Promise<void> {
    const rawText = await this.readText(event.data);
    const receivedAt = new Date().toISOString();
    this.lastTrafficAt = receivedAt;
    this.resetStaleTimer();

    if (rawText === 'PING') {
      this.sendRaw('PONG');
      return;
    }

    if (rawText === 'PONG') {
      await this.handlers.onTraffic?.({
        receivedAt,
        kind: 'heartbeat',
        rawText,
      });
      return;
    }

    const trafficEvent: PolymarketSocketTrafficEvent = {
      receivedAt,
      kind: 'message',
      rawText,
    };

    await this.handlers.onTraffic?.(trafficEvent);

    let payload: unknown;
    try {
      payload = JSON.parse(rawText);
    } catch {
      this.logger.warn?.(`${this.options.name} websocket received non-JSON payload.`, {
        rawText,
      });
      return;
    }

    await this.handlers.onMessage?.(payload, trafficEvent);
  }

  private async handleClose(event: PolymarketSocketCloseEvent): Promise<void> {
    this.logger.warn?.(`${this.options.name} websocket closed.`, {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
      expectedClose: this.expectedClose,
    });

    this.clearHeartbeatTimer();
    this.clearStaleTimer();
    this.socket = null;
    await this.handlers.onClose?.(event);

    if (!this.running) {
      this.connectionStatus = 'idle';
      return;
    }

    if (this.expectedClose) {
      this.connectionStatus = 'disconnected';
      return;
    }

    this.connectionStatus = 'disconnected';
    this.scheduleReconnect(
      event.reason.trim().length > 0 ? event.reason : `socket_closed_${event.code}`,
    );
  }

  private startHeartbeatTimer(): void {
    this.clearHeartbeatTimer();
    if (this.isOpen()) {
      this.sendRaw('PING');
    }
    this.heartbeatHandle = setInterval(() => {
      if (!this.isOpen()) {
        return;
      }

      this.sendRaw('PING');
    }, this.heartbeatIntervalMs);
  }

  private resetStaleTimer(): void {
    this.clearStaleTimer();
    this.staleHandle = setTimeout(() => {
      if (!this.running) {
        return;
      }

      const detectedAt = new Date().toISOString();
      void this.handlers.onStale?.({
        detectedAt,
        staleAfterMs: this.options.staleAfterMs,
      });
      void this.triggerReconnect('stream_traffic_stale');
    }, this.options.staleAfterMs);
  }

  private scheduleReconnect(reasonCode: string): void {
    if (!this.running) {
      return;
    }

    if (this.reconnectAttempt >= this.reconnectMaxAttempts) {
      this.connectionStatus = 'failed';
      this.permanentFailureReason = `${this.options.name}_reconnect_exhausted:${reasonCode}`;
      this.logger.error?.(`${this.options.name} reconnect attempts exhausted.`, {
        reasonCode,
        reconnectAttempt: this.reconnectAttempt,
      });
      this.rejectConnectWaiters(new Error(this.permanentFailureReason));
      void this.handlers.onPermanentFailure?.(this.permanentFailureReason);
      return;
    }

    const exponentialDelay = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectBaseDelayMs * 2 ** Math.max(0, this.reconnectAttempt - 1),
    );
    const jitterMagnitude = exponentialDelay * this.reconnectJitterRatio;
    const jitter = jitterMagnitude > 0 ? (Math.random() * jitterMagnitude * 2) - jitterMagnitude : 0;
    const delayMs = Math.max(50, Math.round(exponentialDelay + jitter));

    this.clearReconnectTimer();
    this.reconnectHandle = setTimeout(() => {
      this.reconnectHandle = null;
      this.connectIfNeeded();
    }, delayMs);

    this.logger.warn?.(`${this.options.name} websocket reconnect scheduled.`, {
      reasonCode,
      delayMs,
      reconnectAttempt: this.reconnectAttempt,
    });
  }

  private sendRaw(payload: string): void {
    if (!this.isOpen() || !this.socket) {
      this.outboundQueue.push(payload);
      return;
    }

    this.socket.send(payload);

    while (this.outboundQueue.length > 0 && this.isOpen() && this.socket) {
      const queued = this.outboundQueue.shift();
      if (!queued) {
        continue;
      }
      this.socket.send(queued);
    }
  }

  private isOpen(): boolean {
    return this.socket?.readyState === 1;
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatHandle) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
  }

  private clearStaleTimer(): void {
    if (this.staleHandle) {
      clearTimeout(this.staleHandle);
      this.staleHandle = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectHandle) {
      clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
  }

  private resolveConnectWaiters(): void {
    for (const waiter of this.connectWaiters) {
      waiter.resolve();
    }
    this.connectWaiters.clear();
  }

  private rejectConnectWaiters(error: Error): void {
    for (const waiter of this.connectWaiters) {
      waiter.reject(error);
    }
    this.connectWaiters.clear();
  }

  private async readText(data: unknown): Promise<string> {
    if (typeof data === 'string') {
      return data;
    }

    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
      return data.toString('utf8');
    }

    if (data instanceof ArrayBuffer) {
      return Buffer.from(data).toString('utf8');
    }

    if (
      typeof data === 'object' &&
      data !== null &&
      'arrayBuffer' in data &&
      typeof (data as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer === 'function'
    ) {
      const arrayBuffer = await (data as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
      return Buffer.from(arrayBuffer).toString('utf8');
    }

    return String(data ?? '');
  }
}
