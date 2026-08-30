export interface ClosableMcpTransport {
  close(): Promise<void>;
}

export interface McpSessionCloseResult {
  sessionId: string;
  error?: unknown;
}

export interface McpSessionMetadata {
  client?: string;
  schemaRevision?: number;
}

export interface McpSessionSnapshot extends McpSessionMetadata {
  sessionId: string;
  connectedAt: number;
  lastActivityAt: number;
}

interface McpSessionEntry<TTransport> {
  transport: TTransport;
  connectedAt: number;
  lastActivityAt: number;
  metadata: McpSessionMetadata;
  activeConnections: number;
  abandonTimer?: NodeJS.Timeout;
}

export interface McpSessionRegistryOptions {
  now?: () => number;
  abandonGraceMs?: number;
}

export class McpSessionRegistry<TTransport extends ClosableMcpTransport> {
  private readonly sessions = new Map<string, McpSessionEntry<TTransport>>();
  private readonly now: () => number;
  private readonly abandonGraceMs: number;

  constructor(options: McpSessionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.abandonGraceMs = options.abandonGraceMs ?? 30_000;
    if (!Number.isFinite(this.abandonGraceMs) || this.abandonGraceMs < 0) {
      throw new Error("MCP session abandon grace must be a non-negative finite duration.");
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  register(sessionId: string, transport: TTransport, metadata: McpSessionMetadata = {}): void {
    const now = this.now();
    this.sessions.set(sessionId, {
      transport,
      connectedAt: now,
      lastActivityAt: now,
      metadata,
      activeConnections: 0,
    });
  }

  list(): McpSessionSnapshot[] {
    return Array.from(this.sessions, ([sessionId, entry]) => ({
      sessionId,
      connectedAt: entry.connectedAt,
      lastActivityAt: entry.lastActivityAt,
      ...entry.metadata,
    }));
  }

  async close(sessionId: string): Promise<McpSessionCloseResult | undefined> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    this.clearAbandonTimer(entry);
    this.sessions.delete(sessionId);
    const [result] = await closeSessions([{ sessionId, transport: entry.transport }]);
    return result;
  }

  get(sessionId: string): TTransport | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;

    this.touchEntry(entry);
    return entry.transport;
  }

  beginRequest(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    this.clearAbandonTimer(entry);
    entry.activeConnections += 1;
    this.touchEntry(entry);
    return true;
  }

  endRequest(sessionId: string, abnormal = false): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.activeConnections = Math.max(0, entry.activeConnections - 1);
    this.touchEntry(entry);
    if (abnormal && entry.activeConnections === 0) this.scheduleAbandonClose(sessionId, entry);
  }

  remove(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    this.clearAbandonTimer(entry);
    return this.sessions.delete(sessionId);
  }

  async closeIdle(idleTimeoutMs: number): Promise<McpSessionCloseResult[]> {
    const cutoff = this.now() - idleTimeoutMs;
    const idleSessions: Array<{ sessionId: string; transport: TTransport }> = [];

    for (const [sessionId, entry] of this.sessions) {
      if (entry.lastActivityAt > cutoff) continue;

      this.clearAbandonTimer(entry);
      this.sessions.delete(sessionId);
      idleSessions.push({ sessionId, transport: entry.transport });
    }

    return closeSessions(idleSessions);
  }

  async closeAll(): Promise<McpSessionCloseResult[]> {
    const sessions = Array.from(this.sessions, ([sessionId, entry]) => ({
      sessionId,
      transport: entry.transport,
    }));
    for (const entry of this.sessions.values()) this.clearAbandonTimer(entry);
    this.sessions.clear();
    return closeSessions(sessions);
  }

  private touchEntry(entry: McpSessionEntry<TTransport>): void {
    entry.lastActivityAt = this.now();
  }

  private clearAbandonTimer(entry: McpSessionEntry<TTransport>): void {
    if (!entry.abandonTimer) return;
    clearTimeout(entry.abandonTimer);
    entry.abandonTimer = undefined;
  }

  private scheduleAbandonClose(sessionId: string, entry: McpSessionEntry<TTransport>): void {
    this.clearAbandonTimer(entry);
    if (this.abandonGraceMs === 0) {
      void this.close(sessionId);
      return;
    }
    entry.abandonTimer = setTimeout(() => {
      entry.abandonTimer = undefined;
      const current = this.sessions.get(sessionId);
      if (!current || current !== entry || current.activeConnections > 0) return;
      void this.close(sessionId);
    }, this.abandonGraceMs);
    entry.abandonTimer.unref();
  }
}

async function closeSessions<TTransport extends ClosableMcpTransport>(
  sessions: Array<{ sessionId: string; transport: TTransport }>,
): Promise<McpSessionCloseResult[]> {
  return Promise.all(
    sessions.map(async ({ sessionId, transport }) => {
      try {
        await transport.close();
        return { sessionId };
      } catch (error) {
        return { sessionId, error };
      }
    }),
  );
}
