import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Request, Response } from "express";
import {
  adminCoreToolStates,
  applyAdminSettings,
  controlScheduledTask,
  discoverProjects,
  errorMessage,
  persistAdminSettings,
  readAdminLog,
  scheduledTaskSnapshot,
  type AdminServiceStatus,
} from "./admin-control.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { getLocalAgentProviderAvailabilitySnapshot } from "./local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import { LocalAgentClient } from "./local-agent-client.js";
import {
  normalizeWindowsPrivilegeLevel,
  requestWindowsAdminModeChange,
  windowsAdminModeSnapshot,
} from "./windows-privileges.js";

const DEVSPACE_VERSION = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as { version: string }
).version;
const DEFAULT_BACKEND_START_TIMEOUT_MS = 10_000;
const DEFAULT_BACKEND_RESTART_DELAY_MS = 1_000;
const DEFAULT_BACKEND_HEALTH_CHECK_INTERVAL_MS = 10_000;
const DEFAULT_BACKEND_HEALTH_CHECK_FAILURE_THRESHOLD = 3;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type BackendProcessState = "running" | "starting" | "stopping" | "stopped";

export interface BackendProcessSnapshot {
  state: BackendProcessState;
  pid?: number;
  startedAt?: string;
  lastExitCode?: number | null;
  lastExitSignal?: NodeJS.Signals | null;
}

export interface DevSpaceChildControllerOptions {
  backendPort: number;
  getSchemaRevision: () => number;
  cliPath?: string;
  env?: NodeJS.ProcessEnv;
  startTimeoutMs?: number;
  restartDelayMs?: number;
  healthCheckIntervalMs?: number;
  healthCheckFailureThreshold?: number;
  spawnProcess?: typeof spawn;
  healthCheck?: (backendPort: number) => Promise<boolean>;
}

export class DevSpaceChildController {
  private readonly backendPort: number;
  private readonly getSchemaRevision: () => number;
  private readonly cliPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly startTimeoutMs: number;
  private readonly restartDelayMs: number;
  private readonly healthCheckIntervalMs: number;
  private readonly healthCheckFailureThreshold: number;
  private readonly spawnProcess: typeof spawn;
  private readonly healthCheck: (backendPort: number) => Promise<boolean>;
  private child?: ChildProcess;
  private state: BackendProcessState = "stopped";
  private desiredRunning = true;
  private shuttingDown = false;
  private startedAt?: string;
  private lastExitCode?: number | null;
  private lastExitSignal?: NodeJS.Signals | null;
  private restartTimer?: NodeJS.Timeout;
  private healthCheckTimer?: NodeJS.Timeout;
  private consecutiveHealthCheckFailures = 0;
  private operation?: Promise<void>;

  constructor(options: DevSpaceChildControllerOptions) {
    this.backendPort = options.backendPort;
    this.getSchemaRevision = options.getSchemaRevision;
    this.cliPath = options.cliPath ?? fileURLToPath(new URL("./cli.js", import.meta.url));
    this.env = options.env ?? process.env;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_BACKEND_START_TIMEOUT_MS;
    this.restartDelayMs = options.restartDelayMs ?? DEFAULT_BACKEND_RESTART_DELAY_MS;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? DEFAULT_BACKEND_HEALTH_CHECK_INTERVAL_MS;
    this.healthCheckFailureThreshold = options.healthCheckFailureThreshold
      ?? DEFAULT_BACKEND_HEALTH_CHECK_FAILURE_THRESHOLD;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.healthCheck = options.healthCheck ?? defaultBackendHealthCheck;
  }

  snapshot(): BackendProcessSnapshot {
    return {
      state: this.state,
      pid: this.child?.pid,
      startedAt: this.startedAt,
      lastExitCode: this.lastExitCode,
      lastExitSignal: this.lastExitSignal,
    };
  }

  async start(): Promise<void> {
    this.desiredRunning = true;
    this.clearRestartTimer();
    if (this.state === "running" || this.state === "starting") return this.operation;
    return this.runExclusive(async () => {
      if (this.child && this.child.exitCode === null) return;
      this.state = "starting";
      const child = this.spawnProcess(process.execPath, [this.cliPath, "serve"], {
        env: {
          ...this.env,
          HOST: "127.0.0.1",
          PORT: String(this.backendPort),
          DEVSPACE_SUPERVISOR_CHILD: "1",
          DEVSPACE_SCHEMA_REVISION: String(this.getSchemaRevision()),
          DEVSPACE_TRUST_PROXY: "1",
        },
        stdio: ["ignore", "inherit", "inherit"],
        windowsHide: true,
      });
      this.child = child;
      this.startedAt = new Date().toISOString();
      this.attachExitHandler(child);

      try {
        await this.waitUntilHealthy(child);
        if (this.child !== child || child.exitCode !== null) {
          throw new Error("DevSpace MCP backend exited during startup.");
        }
        this.state = "running";
        this.consecutiveHealthCheckFailures = 0;
        this.scheduleHealthCheck(child);
      } catch (error) {
        if (this.child === child && child.exitCode === null) child.kill("SIGTERM");
        this.state = "stopped";
        throw error;
      }
    });
  }

  async stop(): Promise<void> {
    this.desiredRunning = false;
    this.clearRestartTimer();
    this.clearHealthCheckTimer();
    this.consecutiveHealthCheckFailures = 0;
    return this.runExclusive(async () => {
      const child = this.child;
      if (!child || child.exitCode !== null) {
        this.child = undefined;
        this.state = "stopped";
        return;
      }
      this.state = "stopping";
      child.kill("SIGTERM");
      const exited = await waitForChildExit(child, 8_000);
      if (!exited && child.exitCode === null) {
        child.kill("SIGKILL");
        await waitForChildExit(child, 2_000);
      }
      if (this.child === child) this.child = undefined;
      this.state = "stopped";
    });
  }

  async restart(): Promise<void> {
    this.desiredRunning = true;
    this.clearRestartTimer();
    this.clearHealthCheckTimer();
    this.consecutiveHealthCheckFailures = 0;
    await this.runExclusive(async () => {
      const child = this.child;
      if (child && child.exitCode === null) {
        this.state = "stopping";
        child.kill("SIGTERM");
        const exited = await waitForChildExit(child, 8_000);
        if (!exited && child.exitCode === null) {
          child.kill("SIGKILL");
          await waitForChildExit(child, 2_000);
        }
      }
      if (this.child === child) this.child = undefined;
      this.state = "stopped";
    });
    await this.start();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.desiredRunning = false;
    this.clearRestartTimer();
    this.clearHealthCheckTimer();
    await this.stop();
  }

  private async runExclusive(operation: () => Promise<void>): Promise<void> {
    if (this.operation) await this.operation;
    const next = operation();
    this.operation = next;
    try {
      await next;
    } finally {
      if (this.operation === next) this.operation = undefined;
    }
  }

  private attachExitHandler(child: ChildProcess): void {
    child.once("exit", (code, signal) => {
      this.lastExitCode = code;
      this.lastExitSignal = signal;
      if (this.child === child) this.child = undefined;
      this.clearHealthCheckTimer();
      this.consecutiveHealthCheckFailures = 0;
      this.state = "stopped";
      if (this.desiredRunning && !this.shuttingDown) this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start().catch((error) => {
        console.error("devspace backend restart failed", error);
        if (this.desiredRunning && !this.shuttingDown) this.scheduleRestart();
      });
    }, this.restartDelayMs);
    this.restartTimer.unref();
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  private scheduleHealthCheck(child: ChildProcess): void {
    this.clearHealthCheckTimer();
    if (!this.desiredRunning || this.shuttingDown || this.child !== child || this.state !== "running") return;
    this.healthCheckTimer = setTimeout(() => {
      this.healthCheckTimer = undefined;
      void this.runHealthCheck(child);
    }, this.healthCheckIntervalMs);
    this.healthCheckTimer.unref();
  }

  private async runHealthCheck(child: ChildProcess): Promise<void> {
    let healthy = false;
    try {
      healthy = await this.healthCheck(this.backendPort);
    } catch {
      healthy = false;
    }
    if (!this.desiredRunning || this.shuttingDown || this.child !== child || this.state !== "running") return;

    if (healthy) {
      this.consecutiveHealthCheckFailures = 0;
      this.scheduleHealthCheck(child);
      return;
    }

    this.consecutiveHealthCheckFailures += 1;
    if (this.consecutiveHealthCheckFailures < this.healthCheckFailureThreshold) {
      this.scheduleHealthCheck(child);
      return;
    }

    this.consecutiveHealthCheckFailures = 0;
    console.error(`devspace backend failed ${this.healthCheckFailureThreshold} consecutive health checks; restarting`);
    try {
      await this.restart();
    } catch (error) {
      console.error("devspace backend health restart failed", error);
      if (this.desiredRunning && !this.shuttingDown) this.scheduleRestart();
    }
  }

  private clearHealthCheckTimer(): void {
    if (this.healthCheckTimer) clearTimeout(this.healthCheckTimer);
    this.healthCheckTimer = undefined;
  }

  private async waitUntilHealthy(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || this.child !== child) {
        throw new Error("DevSpace MCP backend exited before becoming healthy.");
      }
      if (await this.healthCheck(this.backendPort)) return;
      await delay(100);
    }
    throw new Error(`DevSpace MCP backend did not become healthy on 127.0.0.1:${this.backendPort}.`);
  }
}

export interface RunningSupervisor {
  app: express.Express;
  config: ServerConfig;
  backendPort: number;
  controller: DevSpaceChildController;
  startBackend(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateSupervisorOptions {
  backendPort?: number;
  controller?: DevSpaceChildController;
}

export function createSupervisor(
  config = loadConfig(),
  options: CreateSupervisorOptions = {},
): RunningSupervisor {
  const backendPort = options.backendPort ?? parseBackendPort(process.env.DEVSPACE_BACKEND_PORT, config.port);
  if (backendPort === config.port) throw new Error("Supervisor backend port must differ from the public DevSpace port.");

  const app = express();
  let schemaRevision = parseSchemaRevision(process.env.DEVSPACE_SCHEMA_REVISION);
  const controller = options.controller ?? new DevSpaceChildController({
    backendPort,
    getSchemaRevision: () => schemaRevision,
  });
  const localAgentClient = new LocalAgentClient({ stateDir: config.stateDir });

  const resolveProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    getLocalAgentProviderAvailabilitySnapshot(),
  );

  const resolveServices = async (): Promise<AdminServiceStatus[]> => {
    const [cloudflareTask, reverseSshTask, daemonStatus] = await Promise.all([
      scheduledTaskSnapshot("DevSpace Cloudflare Tunnel"),
      scheduledTaskSnapshot("DevSpace Reverse SSH"),
      localAgentClient.status(),
    ]);
    const backend = controller.snapshot();
    const backendState = backend.state === "running"
      ? "running"
      : backend.state === "stopped"
        ? "stopped"
        : "unknown";
    const daemonState = daemonStatus.isErr() ? "stopped" : "running";

    return [
      {
        id: "supervisor",
        name: "DevSpace Supervisor",
        description: "独立控制面与反向代理；即使 MCP Server 停止也保持在线。",
        state: "running",
        pid: process.pid,
        endpoint: `http://${config.host}:${config.port}/admin`,
        controllable: false,
        actions: ["logs"],
        note: `MCP 后端代理端口：127.0.0.1:${backendPort}`,
      },
      {
        id: "devspace-server",
        name: "DevSpace MCP Server",
        description: "提供 OAuth、MCP tools/resources 与工作区执行能力的受管子进程。",
        state: backendState,
        pid: backend.pid,
        endpoint: `http://127.0.0.1:${backendPort}/mcp`,
        controllable: true,
        actions: ["start", "stop", "restart", "logs"],
        note: backend.state === "starting"
          ? "正在启动并等待健康检查。"
          : backend.state === "stopping"
            ? "正在停止。"
            : backend.lastExitCode !== undefined
              ? `最近退出：code=${backend.lastExitCode ?? "null"}${backend.lastExitSignal ? ` signal=${backend.lastExitSignal}` : ""}`
              : undefined,
      },
      {
        id: "cloudflare-tunnel",
        name: "Cloudflare Tunnel",
        description: "DevSpace 公网 HTTPS 隧道；入口仍指向 Supervisor 的 7676。",
        state: cloudflareTask.state,
        taskName: cloudflareTask.taskName,
        endpoint: config.publicBaseUrl,
        controllable: cloudflareTask.state !== "unavailable",
        actions: ["start", "stop", "restart", "logs"],
      },
      {
        id: "agent-daemon",
        name: "Agent Daemon",
        description: "本地子代理运行守护进程。",
        state: daemonState,
        pid: daemonStatus.isErr() ? undefined : daemonStatus.value.pid,
        controllable: true,
        actions: ["start", "stop", "restart", "logs"],
        note: daemonStatus.isErr() ? daemonStatus.error.message : undefined,
      },
      {
        id: "reverse-ssh",
        name: "Reverse SSH",
        description: "备用反向 SSH 通道。",
        state: reverseSshTask.state,
        taskName: reverseSshTask.taskName,
        controllable: reverseSshTask.state !== "unavailable",
        actions: ["start", "stop", "restart", "logs"],
        note: reverseSshTask.state === "unavailable" ? "当前未注册 DevSpace Reverse SSH 计划任务。" : undefined,
      },
    ];
  };

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });
  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );
  app.use("/assets", express.static(uiBuildDirectory(), { immutable: true, maxAge: "1y" }));

  app.get("/admin", (req, res) => {
    if (!isLocalAdminRequest(req)) return res.status(404).send("Not found");
    const html = readFileSync(join(uiBuildDirectory(), "admin.html"), "utf8")
      .replaceAll("./assets/", "/mcp-app-assets/assets/");
    res.type("html").send(html);
  });

  app.use("/api/admin", express.json());
  app.get("/api/admin/status", async (req, res) => {
    if (!isLocalAdminRequest(req)) return res.status(404).json({ error: "Not found" });
    const backend = await tryBackendJson<Record<string, unknown>>(backendPort, "/api/admin/status");
    const tools = adminCoreToolStates(config);
    const backendSnapshot = controller.snapshot();
    const privileges = await windowsAdminModeSnapshot(normalizeWindowsPrivilegeLevel(backend?.windowsPrivilege));
    res.json({
      ...(backend ?? {}),
      ok: true,
      name: "DevSpace",
      version: DEVSPACE_VERSION,
      pid: backendSnapshot.pid ?? 0,
      uptimeSeconds: backend && typeof backend.uptimeSeconds === "number" ? backend.uptimeSeconds : 0,
      host: config.host,
      port: config.port,
      publicBaseUrl: config.publicBaseUrl,
      mcpUrl: new URL("/mcp", config.publicBaseUrl).toString(),
      allowedRoots: config.allowedRoots,
      allowedHosts: config.allowedHosts,
      schemaRevision,
      sessionCount: backend && typeof backend.sessionCount === "number" ? backend.sessionCount : 0,
      tools,
      exposedCoreToolCount: tools.filter((tool) => tool.enabled).length,
      settings: {
        toolMode: config.toolMode,
        widgets: config.widgets,
        skillsEnabled: config.skillsEnabled,
        subagentsEnabled: config.subagents.enabled,
        artifactsEnabled: config.artifactsEnabled,
        disabledTools: config.disabledTools,
      },
      providers: backend?.providers ?? resolveProviders(),
      backendRunning: backendSnapshot.state === "running",
      supervisor: {
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        port: config.port,
        backendPort,
      },
      privileges,
    });
  });

  app.post("/api/admin/privileges/admin-mode", async (req, res) => {
    if (!isLocalAdminRequest(req)) return res.status(404).json({ error: "Not found" });
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be boolean." });
    }
    try {
      res.json(await requestWindowsAdminModeChange(req.body.enabled));
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/admin/services", async (req, res) => {
    if (!isLocalAdminRequest(req)) return res.status(404).json({ error: "Not found" });
    try {
      res.json({ services: await resolveServices() });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/admin/services/:id/:action", async (req, res) => {
    if (!isLocalAdminRequest(req)) return res.status(404).json({ error: "Not found" });
    const action = req.params.action;
    if (action !== "start" && action !== "stop" && action !== "restart") {
      return res.status(400).json({ error: "Unsupported service action." });
    }
    try {
      if (req.params.id === "supervisor") {
        return res.status(409).json({ error: "Supervisor cannot stop itself from its own control plane." });
      }
      if (req.params.id === "devspace-server") {
        if (action === "start") await controller.start();
        else if (action === "stop") await controller.stop();
        else await controller.restart();
      } else if (req.params.id === "cloudflare-tunnel") {
        await controlScheduledTask("DevSpace Cloudflare Tunnel", action);
      } else if (req.params.id === "reverse-ssh") {
        await controlScheduledTask("DevSpace Reverse SSH", action);
      } else if (req.params.id === "agent-daemon") {
        if (action === "stop") {
          const result = await localAgentClient.stop();
          if (result.isErr()) throw result.error;
        } else if (action === "start") {
          const result = await localAgentClient.ensureReady();
          if (result.isErr()) throw result.error;
        } else {
          const stopped = await localAgentClient.stop();
          if (stopped.isErr() && stopped.error.code !== "DAEMON_UNAVAILABLE") throw stopped.error;
          const started = await localAgentClient.ensureReady();
          if (started.isErr()) throw started.error;
        }
      } else {
        return res.status(404).json({ error: "Unknown service." });
      }
      res.json({ ok: true, services: await resolveServices() });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/admin/mcp/sessions", async (req, res) => {
    if (!isLocalAdminRequest(req)) return res.status(404).json({ error: "Not found" });
    const backend = await tryBackendJson<{ sessions?: unknown[] }>(backendPort, "/api/admin/mcp/sessions");
    res.json({ schemaRevision, sessions: backend?.sessions ?? [] });
  });

  app.post("/api/admin/mcp/sessions/disconnect-all", async (req, res) => {
    if (!isLocalAdminRequest(req)) return res.status(404).json({ error: "Not found" });
    if (controller.snapshot().state !== "running") return res.json({ ok: true, closed: 0 });
    try {
      const result = await backendJson<{ closed?: number }>(backendPort, "/api/admin/mcp/sessions/disconnect-all", { method: "POST", body: {} });
      res.json({ ok: true, closed: result.closed ?? 0 });
    } catch (error) {
      res.status(502).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/admin/mcp/sessions/:id/disconnect", async (req, res) => {
    if (!isLocalAdminRequest(req)) return res.status(404).json({ error: "Not found" });
    if (controller.snapshot().state !== "running") return res.status(404).json({ error: "DevSpace MCP Server is stopped." });
    try {
      const result = await backendJson<Record<string, unknown>>(
        backendPort,
        `/api/admin/mcp/sessions/${encodeURIComponent(req.params.id)}/disconnect`,
        { method: "POST", body: {} },
      );
      res.json(result);
    } catch (error) {
      res.status(502).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/admin/mcp/reload", async (req, res) => {
    if (!isLocalAdminRequest(req)) return res.status(404).json({ error: "Not found" });
    const sessions = await tryBackendJson<{ sessions?: unknown[] }>(backendPort, "/api/admin/mcp/sessions");
    schemaRevision += 1;
    const running = controller.snapshot().state !== "stopped";
    try {
      if (running) await controller.restart();
      res.json({ ok: true, schemaRevision, closed: sessions?.sessions?.length ?? 0 });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error), schemaRevision });
    }
  });

  app.post("/api/admin/settings", async (req, res) => {
    if (!isLocalAdminRequest(req)) return res.status(404).json({ error: "Not found" });
    try {
      const previousRuntime = runtimeSettingsFingerprint(config);
      const previousSchema = schemaSettingsFingerprint(config);
      applyAdminSettings(config, req.body);
      const configPath = persistAdminSettings(config);
      const runtimeChanged = previousRuntime !== runtimeSettingsFingerprint(config);
      const schemaChanged = previousSchema !== schemaSettingsFingerprint(config);
      if (schemaChanged) schemaRevision += 1;
      let backendRestarted = false;
      if (runtimeChanged && controller.snapshot().state !== "stopped") {
        await controller.restart();
        backendRestarted = true;
      }
      res.json({
        ok: true,
        configPath,
        schemaRevision,
        reconnectRecommended: schemaChanged,
        backendRestarted,
      });
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/admin/projects", async (req, res) => {
    if (!isLocalAdminRequest(req)) return res.status(404).json({ error: "Not found" });
    try {
      res.json({ projects: await discoverProjects(config) });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/admin/open-folder", async (req, res) => {
    if (!isLocalAdminRequest(req)) return res.status(404).json({ error: "Not found" });
    const target = typeof req.body?.path === "string" ? req.body.path : "";
    try {
      const projects = await discoverProjects(config);
      if (!projects.some((project) => project.path === target)) {
        return res.status(400).json({ error: "Path is not an allowed project" });
      }
      spawn("explorer.exe", [target], { detached: true, stdio: "ignore" }).unref();
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/admin/logs", async (req, res) => {
    if (!isLocalAdminRequest(req)) return res.status(404).json({ error: "Not found" });
    const source = typeof req.query.source === "string" ? req.query.source : "server";
    const lines = Number(req.query.lines ?? 250);
    try {
      if (source === "agent") {
        const result = await localAgentClient.logs(Number.isFinite(lines) ? lines : 250);
        if (result.isErr()) throw result.error;
        return res.json({ source, lines: result.value.split(/\r?\n/).filter(Boolean) });
      }
      if (source !== "server" && source !== "tunnel") {
        return res.status(400).json({ error: "Unknown log source." });
      }
      res.json({ source, lines: await readAdminLog(source, Number.isFinite(lines) ? lines : 250) });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });

  app.get("/healthz", (_req, res) => {
    const backend = controller.snapshot();
    res.json({
      ok: true,
      name: "devspace-supervisor",
      version: DEVSPACE_VERSION,
      backend: backend.state,
      backendPid: backend.pid,
    });
  });

  app.use((req, res) => {
    proxyToBackend(req, res, backendPort);
  });

  return {
    app,
    config,
    backendPort,
    controller,
    startBackend: () => controller.start(),
    close: () => controller.shutdown(),
  };
}

function proxyToBackend(req: Request, res: Response, backendPort: number): void {
  const headers = backendProxyHeaders(req.headers, req.socket.remoteAddress);
  for (const header of HOP_BY_HOP_HEADERS) delete headers[header];
  const proxyRequest = httpRequest({
    hostname: "127.0.0.1",
    port: backendPort,
    method: req.method,
    path: req.originalUrl,
    headers,
  }, (proxyResponse) => {
    res.statusCode = proxyResponse.statusCode ?? 502;
    for (const [name, value] of Object.entries(proxyResponse.headers)) {
      if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
      res.setHeader(name, value);
    }
    proxyResponse.on("error", () => {
      if (!res.headersSent) res.status(502).json({ error: "DevSpace MCP backend response failed." });
      else res.destroy();
    });
    proxyResponse.pipe(res);
  });

  proxyRequest.on("error", (error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    res.status(503).json({
      error: "DevSpace MCP Server is unavailable.",
      detail: error.message,
    });
  });
  req.on("aborted", () => proxyRequest.destroy());
  req.pipe(proxyRequest);
}

export function backendProxyHeaders(
  incoming: IncomingHttpHeaders,
  remoteAddress?: string,
): IncomingHttpHeaders {
  const headers = { ...incoming };
  delete headers["x-forwarded-for"];

  const cloudflareIp = firstHeaderValue(incoming["cf-connecting-ip"]);
  const clientIp = cloudflareIp ?? normalizeRemoteAddress(remoteAddress);
  if (clientIp) headers["x-forwarded-for"] = clientIp;

  return headers;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value?.split(",")[0];
  return first?.trim() || undefined;
}

function normalizeRemoteAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
}

async function backendJson<T>(
  backendPort: number,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${backendPort}${path}`, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(5_000),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : `${response.status} ${response.statusText}`);
  }
  return payload as T;
}

async function tryBackendJson<T>(backendPort: number, path: string): Promise<T | undefined> {
  try {
    return await backendJson<T>(backendPort, path);
  } catch {
    return undefined;
  }
}

async function defaultBackendHealthCheck(backendPort: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${backendPort}/healthz`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function parseBackendPort(value: string | undefined, supervisorPort: number): number {
  if (!value) return supervisorPort === 65_535 ? 65_534 : supervisorPort + 1;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid DEVSPACE_BACKEND_PORT: ${value}`);
  }
  return port;
}

function parseSchemaRevision(value: string | undefined): number {
  const revision = Number(value ?? "1");
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 1;
}

function schemaSettingsFingerprint(config: ServerConfig): string {
  return JSON.stringify({
    toolMode: config.toolMode,
    widgets: config.widgets,
    disabledTools: config.disabledTools,
    skillsEnabled: config.skillsEnabled,
    subagentsEnabled: config.subagents.enabled,
    artifactsEnabled: config.artifactsEnabled,
  });
}

function runtimeSettingsFingerprint(config: ServerConfig): string {
  return JSON.stringify({
    schema: schemaSettingsFingerprint(config),
    allowedRoots: config.allowedRoots,
  });
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

function isLocalAdminRequest(req: Request): boolean {
  const host = (req.hostname ?? "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
