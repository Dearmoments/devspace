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
}

export interface McpSessionRegistryOptions {
  now?: () => number;
}

export class McpSessionRegistry<TTransport extends ClosableMcpTransport> {
  private readonly sessions = new Map<string, McpSessionEntry<TTransport>>();
  private readonly now: () => number;

  constructor(options: McpSessionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
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
    this.sessions.delete(sessionId);
    const [result] = await closeSessions([{ sessionId, transport: entry.transport }]);
    return result;
  }

  get(sessionId: string): TTransport | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;

    entry.lastActivityAt = this.now();
    return entry.transport;
  }

  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  async closeIdle(idleTimeoutMs: number): Promise<McpSessionCloseResult[]> {
    const cutoff = this.now() - idleTimeoutMs;
    const idleSessions: Array<{ sessionId: string; transport: TTransport }> = [];

    for (const [sessionId, entry] of this.sessions) {
      if (entry.lastActivityAt > cutoff) continue;

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
    this.sessions.clear();
    return closeSessions(sessions);
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
