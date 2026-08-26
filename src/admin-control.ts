import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ServerConfig, ToolMode, WidgetMode } from "./config.js";
import { expandHomePath } from "./roots.js";
import { loadDevspaceFiles, writeDevspaceConfig } from "./user-config.js";

const execFileAsync = promisify(execFile);

export const ADMIN_CORE_TOOLS = [
  "list_projects",
  "open_workspace",
  "read",
  "write",
  "edit",
  "grep",
  "glob",
  "ls",
  "bash",
] as const;

export type AdminCoreTool = typeof ADMIN_CORE_TOOLS[number];
export type AdminServiceState = "running" | "stopped" | "unavailable" | "unknown";

export interface AdminServiceStatus {
  id: string;
  name: string;
  description: string;
  state: AdminServiceState;
  pid?: number;
  endpoint?: string;
  taskName?: string;
  controllable: boolean;
  actions: Array<"start" | "stop" | "restart" | "logs">;
  note?: string;
}

interface ScheduledTaskSnapshot {
  taskName: string;
  state: AdminServiceState;
}

export function adminCoreToolStates(config: ServerConfig) {
  return ADMIN_CORE_TOOLS.map((name) => ({
    name,
    available: coreToolModeAvailable(config, name),
    enabled: coreToolModeAvailable(config, name) && !config.disabledTools.includes(name),
  }));
}

export async function discoverProjects(config: ServerConfig): Promise<Array<{ name: string; path: string; root: string }>> {
  return (await Promise.all(config.allowedRoots.map(async (root) => {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => ({
      name: entry.name,
      path: join(root, entry.name),
      root,
    }));
  }))).flat().sort((left, right) => left.path.localeCompare(right.path));
}

export function applyAdminSettings(config: ServerConfig, body: unknown): void {
  if (!body || typeof body !== "object") throw new Error("Settings body must be an object.");
  const input = body as Record<string, unknown>;

  if (input.allowedRoots !== undefined) {
    if (!Array.isArray(input.allowedRoots) || input.allowedRoots.length === 0) {
      throw new Error("allowedRoots must contain at least one path.");
    }
    const roots = input.allowedRoots.map((value) => {
      if (typeof value !== "string" || !value.trim()) throw new Error("Each allowed root must be a non-empty path.");
      return resolve(expandHomePath(value.trim()));
    });
    config.allowedRoots = Array.from(new Set(roots));
  }

  if (input.toolMode !== undefined) {
    if (!isToolMode(input.toolMode)) throw new Error("Invalid toolMode.");
    config.toolMode = input.toolMode;
  }
  if (input.widgets !== undefined) {
    if (!isWidgetMode(input.widgets)) throw new Error("Invalid widgets mode.");
    config.widgets = input.widgets;
  }
  if (input.disabledTools !== undefined) {
    if (!Array.isArray(input.disabledTools)) throw new Error("disabledTools must be an array.");
    const tools = input.disabledTools.map((value) => {
      if (typeof value !== "string" || !ADMIN_CORE_TOOLS.includes(value as AdminCoreTool)) {
        throw new Error(`Unknown core tool: ${String(value)}`);
      }
      return value;
    });
    config.disabledTools = Array.from(new Set(tools));
  }
  if (input.skillsEnabled !== undefined) {
    if (typeof input.skillsEnabled !== "boolean") throw new Error("skillsEnabled must be boolean.");
    config.skillsEnabled = input.skillsEnabled;
  }
  if (input.artifactsEnabled !== undefined) {
    if (typeof input.artifactsEnabled !== "boolean") throw new Error("artifactsEnabled must be boolean.");
    config.artifactsEnabled = input.artifactsEnabled;
  }
  if (input.subagentsEnabled !== undefined) {
    if (typeof input.subagentsEnabled !== "boolean") throw new Error("subagentsEnabled must be boolean.");
    config.subagents = { ...config.subagents, enabled: input.subagentsEnabled };
  }
}

export function persistAdminSettings(config: ServerConfig): string {
  const files = loadDevspaceFiles();
  return writeDevspaceConfig({
    ...files.config,
    allowedRoots: config.allowedRoots,
    toolMode: config.toolMode,
    widgets: config.widgets,
    disabledTools: config.disabledTools,
    skillsEnabled: config.skillsEnabled,
    skillPaths: config.skillPaths,
    artifactsEnabled: config.artifactsEnabled,
    subagents: config.subagents,
  });
}

export async function scheduledTaskSnapshot(taskName: string): Promise<ScheduledTaskSnapshot> {
  if (process.platform !== "win32") {
    return { taskName, state: "unavailable" };
  }

  const script = [
    `$task = Get-ScheduledTask -TaskName ${powershellLiteral(taskName)} -ErrorAction SilentlyContinue`,
    `if ($null -eq $task) { '{"exists":false}' } else {`,
    `  [pscustomobject]@{ exists = $true; taskName = $task.TaskName; state = [string]$task.State } | ConvertTo-Json -Compress`,
    `}`,
  ].join("; ");

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ], { timeout: 5_000, windowsHide: true });
    const parsed = JSON.parse(stdout.trim() || "{}") as { exists?: boolean; taskName?: string; state?: string };
    if (!parsed.exists) return { taskName, state: "unavailable" };
    return {
      taskName: parsed.taskName ?? taskName,
      state: normalizeScheduledTaskState(parsed.state),
    };
  } catch {
    return { taskName, state: "unknown" };
  }
}

export async function controlScheduledTask(
  taskName: string,
  action: "start" | "stop" | "restart",
): Promise<void> {
  if (process.platform !== "win32") throw new Error("Scheduled task control is only available on Windows.");

  const literal = powershellLiteral(taskName);
  const command = action === "start"
    ? `Start-ScheduledTask -TaskName ${literal}`
    : action === "stop"
      ? `Stop-ScheduledTask -TaskName ${literal}`
      : `Stop-ScheduledTask -TaskName ${literal} -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 350; Start-ScheduledTask -TaskName ${literal}`;

  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
  ], { timeout: 8_000, windowsHide: true });
}

export async function readAdminLog(source: "server" | "tunnel", lineCount = 250): Promise<string[]> {
  const logDir = join(homedir(), ".devspace", "logs");
  const paths = source === "server"
    ? [
        join(logDir, "scheduled-serve-node.stdout.log"),
        join(logDir, "scheduled-serve-node.stderr.log"),
      ]
    : [join(logDir, "cloudflared-devspace.log")];

  const contents = await Promise.all(paths.map(async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }));

  return contents
    .flatMap((content) => content.split(/\r?\n/).filter(Boolean))
    .slice(-Math.max(1, Math.min(lineCount, 1_000)));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function coreToolModeAvailable(config: ServerConfig, tool: string): boolean {
  if (config.toolMode === "codex") {
    return new Set<string>(["list_projects", "open_workspace", "read"]).has(tool);
  }
  if (config.toolMode === "minimal") {
    return !new Set<string>(["grep", "glob", "ls"]).has(tool);
  }
  return true;
}

function isToolMode(value: unknown): value is ToolMode {
  return value === "minimal" || value === "full" || value === "codex";
}

function isWidgetMode(value: unknown): value is WidgetMode {
  return value === "off" || value === "changes" || value === "full";
}

function normalizeScheduledTaskState(state: string | undefined): AdminServiceState {
  switch (state?.toLowerCase()) {
    case "running":
      return "running";
    case "ready":
    case "disabled":
      return "stopped";
    default:
      return state ? "unknown" : "unavailable";
  }
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
