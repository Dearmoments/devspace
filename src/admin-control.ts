import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
