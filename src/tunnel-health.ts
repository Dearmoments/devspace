import {
  controlScheduledTask,
  scheduledTaskSnapshot,
  type AdminServiceState,
} from "./admin-control.js";

const DEFAULT_METRICS_URLS = [20241, 20242, 20243, 20244, 20245]
  .map((port) => `http://127.0.0.1:${port}/metrics`);
const DEFAULT_CHECK_INTERVAL_MS = 10_000;
const DEFAULT_FAILURE_THRESHOLD = 3;

export interface CloudflareTunnelProbeResult {
  taskState: AdminServiceState;
  healthy: boolean;
  restartEligible: boolean;
  haConnections?: number;
  detail?: string;
}

export interface CloudflareTunnelHealthSnapshot extends CloudflareTunnelProbeResult {
  checkedAt?: string;
  consecutiveFailures: number;
}

export interface CloudflareTunnelMonitorOptions {
  probe?: () => Promise<CloudflareTunnelProbeResult>;
  restart?: () => Promise<void>;
  intervalMs?: number;
  failureThreshold?: number;
}

export class CloudflareTunnelMonitor {
  private readonly probe: () => Promise<CloudflareTunnelProbeResult>;
  private readonly restart: () => Promise<void>;
  private readonly intervalMs: number;
  private readonly failureThreshold: number;
  private timer?: NodeJS.Timeout;
  private started = false;
  private operation?: Promise<void>;
  private consecutiveFailures = 0;
  private latest: CloudflareTunnelHealthSnapshot = {
    taskState: "unknown",
    healthy: false,
    restartEligible: false,
    detail: "尚未检查 Cloudflare 边缘连接。",
    consecutiveFailures: 0,
  };

  constructor(options: CloudflareTunnelMonitorOptions = {}) {
    this.probe = options.probe ?? defaultCloudflareTunnelProbe;
    this.restart = options.restart
      ?? (() => controlScheduledTask("DevSpace Cloudflare Tunnel", "restart"));
    this.intervalMs = options.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.runAndSchedule();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  snapshot(): CloudflareTunnelHealthSnapshot {
    return { ...this.latest };
  }

  async checkNow(): Promise<void> {
    if (this.operation) return this.operation;
    const operation = this.evaluateProbe();
    this.operation = operation;
    try {
      await operation;
    } finally {
      if (this.operation === operation) this.operation = undefined;
    }
  }

  private async runAndSchedule(): Promise<void> {
    try {
      await this.checkNow();
    } catch (error) {
      console.error("cloudflare tunnel health check failed", error);
    } finally {
      if (this.started) {
        this.timer = setTimeout(() => void this.runAndSchedule(), this.intervalMs);
        this.timer.unref();
      }
    }
  }

  private async evaluateProbe(): Promise<void> {
    let result: CloudflareTunnelProbeResult;
    try {
      result = await this.probe();
    } catch (error) {
      result = {
        taskState: "unknown",
        healthy: false,
        restartEligible: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    if (!result.restartEligible || result.healthy) {
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures += 1;
    }

    this.latest = {
      ...result,
      checkedAt: new Date().toISOString(),
      consecutiveFailures: this.consecutiveFailures,
    };

    if (this.consecutiveFailures < this.failureThreshold) return;

    this.consecutiveFailures = 0;
    console.error(
      `cloudflare tunnel has no healthy edge connection after ${this.failureThreshold} consecutive checks; restarting`,
    );
    try {
      await this.restart();
      this.latest = {
        ...this.latest,
        detail: "Cloudflare 边缘连接连续异常，已触发 Tunnel 重启。",
        consecutiveFailures: 0,
      };
    } catch (error) {
      this.latest = {
        ...this.latest,
        detail: `Tunnel 自动重启失败：${error instanceof Error ? error.message : String(error)}`,
        consecutiveFailures: 0,
      };
      throw error;
    }
  }
}

export async function defaultCloudflareTunnelProbe(): Promise<CloudflareTunnelProbeResult> {
  const task = await scheduledTaskSnapshot("DevSpace Cloudflare Tunnel");
  if (task.state !== "running") {
    return {
      taskState: task.state,
      healthy: false,
      restartEligible: false,
      detail: task.state === "stopped"
        ? "Cloudflare Tunnel 计划任务已停止。"
        : "无法确认 Cloudflare Tunnel 计划任务状态。",
    };
  }

  const configuredMetricsUrl = process.env.DEVSPACE_CLOUDFLARED_METRICS_URL;
  const lookup = await findCloudflaredHaConnections(
    configuredMetricsUrl ? [configuredMetricsUrl] : DEFAULT_METRICS_URLS,
  );
  if (lookup.haConnections === undefined) {
    return {
      taskState: task.state,
      healthy: false,
      restartEligible: true,
      detail: `无法读取 cloudflared 边缘连接指标：${lookup.failures.join("；")}`,
    };
  }

  return {
    taskState: task.state,
    healthy: lookup.haConnections > 0,
    restartEligible: true,
    haConnections: lookup.haConnections,
    detail: lookup.haConnections > 0
      ? `Cloudflare 边缘连接：${lookup.haConnections}`
      : "Cloudflare 边缘连接：0",
  };
}

export async function findCloudflaredHaConnections(
  metricsUrls: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ haConnections?: number; metricsUrl?: string; failures: string[] }> {
  const results = await Promise.all(metricsUrls.map(async (metricsUrl) => {
    try {
      const response = await fetchImpl(metricsUrl, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) {
        return { metricsUrl, failure: `${metricsUrl} 返回 ${response.status}` };
      }
      const haConnections = parseCloudflaredHaConnections(await response.text());
      if (haConnections === undefined) {
        return { metricsUrl, failure: `${metricsUrl} 缺少边缘连接数` };
      }
      return { metricsUrl, haConnections };
    } catch (error) {
      return {
        metricsUrl,
        failure: `${metricsUrl}：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }));

  const success = results.find((result) => result.haConnections !== undefined);
  const failures = results.flatMap((result) => result.failure ? [result.failure] : []);
  return success
    ? { haConnections: success.haConnections, metricsUrl: success.metricsUrl, failures }
    : { failures };
}

export function parseCloudflaredHaConnections(metrics: string): number | undefined {
  for (const line of metrics.split(/\r?\n/)) {
    const match = /^cloudflared_tunnel_ha_connections(?:\{[^}]*\})?\s+([0-9]+(?:\.[0-9]+)?)$/.exec(line.trim());
    if (!match) continue;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}
