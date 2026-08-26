import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEVSPACE_SERVER_TASK_NAME = "DevSpace Server";

export type WindowsPrivilegeLevel = "administrator" | "limited" | "unknown" | "unsupported";
export type WindowsTaskRunLevel = "highest" | "limited" | "unknown" | "missing" | "unsupported";

export interface WindowsAdminModeSnapshot {
  supported: boolean;
  supervisor: WindowsPrivilegeLevel;
  mcpServer: WindowsPrivilegeLevel;
  taskRunLevel: WindowsTaskRunLevel;
  adminMode: boolean;
}

export interface WindowsAdminModeChangeRequest {
  ok: true;
  enabled: boolean;
  targetRunLevel: "highest" | "limited";
  uacRequested: boolean;
  restarting: true;
}

let currentPrivilegePromise: Promise<WindowsPrivilegeLevel> | undefined;

export function currentWindowsPrivilegeLevel(): Promise<WindowsPrivilegeLevel> {
  if (process.platform !== "win32") return Promise.resolve("unsupported");
  currentPrivilegePromise ??= detectCurrentWindowsPrivilege();
  return currentPrivilegePromise;
}

export async function scheduledTaskRunLevel(taskName = DEVSPACE_SERVER_TASK_NAME): Promise<WindowsTaskRunLevel> {
  if (process.platform !== "win32") return "unsupported";

  const script = [
    `$task = Get-ScheduledTask -TaskName ${powershellLiteral(taskName)} -ErrorAction SilentlyContinue`,
    `if ($null -eq $task) { 'missing' } else { [string]$task.Principal.RunLevel }`,
  ].join("; ");

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ], { timeout: 5_000, windowsHide: true });
    return normalizeTaskRunLevel(stdout.trim());
  } catch {
    return "unknown";
  }
}

export async function windowsAdminModeSnapshot(
  mcpServer: WindowsPrivilegeLevel,
  taskName = DEVSPACE_SERVER_TASK_NAME,
): Promise<WindowsAdminModeSnapshot> {
  if (process.platform !== "win32") {
    return {
      supported: false,
      supervisor: "unsupported",
      mcpServer,
      taskRunLevel: "unsupported",
      adminMode: false,
    };
  }

  const [supervisor, taskRunLevel] = await Promise.all([
    currentWindowsPrivilegeLevel(),
    scheduledTaskRunLevel(taskName),
  ]);
  return {
    supported: true,
    supervisor,
    mcpServer,
    taskRunLevel,
    adminMode: supervisor === "administrator" && taskRunLevel === "highest",
  };
}

export async function requestWindowsAdminModeChange(
  enabled: boolean,
  taskName = DEVSPACE_SERVER_TASK_NAME,
): Promise<WindowsAdminModeChangeRequest> {
  if (process.platform !== "win32") throw new Error("Administrator mode is only available on Windows.");

  const currentPrivilege = await currentWindowsPrivilegeLevel();
  const launchId = randomUUID();
  const runtimeDir = join(homedir(), ".devspace", "runtime", "admin-mode");
  const helperPath = join(runtimeDir, `helper-${launchId}.ps1`);
  const launcherPath = join(runtimeDir, `launcher-${launchId}.ps1`);
  const helperScript = buildAdminModeTransitionScript(taskName, enabled);
  const launcherScript = buildRunAsLauncherScript(helperPath, enabled, launchId);

  await mkdir(runtimeDir, { recursive: true });
  await writeFile(helperPath, helperScript, "utf8");
  await writeFile(launcherPath, launcherScript, "utf8");
  try {
    await launchInteractivePowerShell(launcherPath, enabled, launchId);
  } catch (error) {
    await Promise.allSettled([
      rm(helperPath, { force: true }),
      rm(launcherPath, { force: true }),
    ]);
    throw error;
  }

  return {
    ok: true,
    enabled,
    targetRunLevel: enabled ? "highest" : "limited",
    uacRequested: currentPrivilege !== "administrator",
    restarting: true,
  };
}

export function buildAdminModeTransitionScript(taskName: string, enabled: boolean): string {
  const runLevel = enabled ? "HighestAvailable" : "LeastPrivilege";
  const mode = enabled ? "enabled" : "disabled";
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$taskName = ${powershellLiteral(taskName)}`,
    `$logDir = Join-Path $env:USERPROFILE '.devspace\\logs'`,
    `$logPath = Join-Path $logDir 'admin-mode-transition.log'`,
    `New-Item -ItemType Directory -Path $logDir -Force | Out-Null`,
    `"$(Get-Date -Format o) helper-start admin-mode ${mode}: task=$taskName runLevel=${runLevel} integrity=high" | Add-Content -LiteralPath $logPath`,
    `Start-Sleep -Milliseconds 1200`,
    `try {`,
    `  $xmlText = Export-ScheduledTask -TaskName $taskName -ErrorAction Stop`,
    `  [xml]$xml = $xmlText`,
    `  $namespace = $xml.DocumentElement.NamespaceURI`,
    `  $manager = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)`,
    `  $manager.AddNamespace('t', $namespace)`,
    `  $runLevelNode = $xml.SelectSingleNode('//t:Principals/t:Principal/t:RunLevel', $manager)`,
    `  if ($null -eq $runLevelNode) {`,
    `    $principalNode = $xml.SelectSingleNode('//t:Principals/t:Principal', $manager)`,
    `    if ($null -eq $principalNode) { throw 'Scheduled task principal was not found.' }`,
    `    $runLevelNode = $xml.CreateElement('RunLevel', $namespace)`,
    `    [void]$principalNode.AppendChild($runLevelNode)`,
    `  }`,
    `  $runLevelNode.InnerText = '${runLevel}'`,
    `  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue`,
    `  Start-Sleep -Milliseconds 350`,
    `  Register-ScheduledTask -TaskName $taskName -Xml $xml.OuterXml -Force | Out-Null`,
    `  Start-ScheduledTask -TaskName $taskName`,
    `  "$(Get-Date -Format o) admin-mode ${mode}: task=$taskName runLevel=${runLevel}" | Add-Content -LiteralPath $logPath`,
    `} catch {`,
    `  "$(Get-Date -Format o) admin-mode transition failed: $($_.Exception.Message)" | Add-Content -LiteralPath $logPath`,
    `  throw`,
    `}`,
  ].join("\r\n");
}

export function normalizeWindowsPrivilegeLevel(value: unknown): WindowsPrivilegeLevel {
  return value === "administrator" || value === "limited" || value === "unsupported" ? value : "unknown";
}

export function normalizeTaskRunLevel(value: string): WindowsTaskRunLevel {
  switch (value.trim().toLowerCase()) {
    case "highest":
    case "highestavailable":
      return "highest";
    case "limited":
    case "leastprivilege":
      return "limited";
    case "missing":
      return "missing";
    case "":
      return "unknown";
    default:
      return "unknown";
  }
}

async function detectCurrentWindowsPrivilege(): Promise<WindowsPrivilegeLevel> {
  const script = [
    `$identity = [Security.Principal.WindowsIdentity]::GetCurrent()`,
    `$principal = New-Object Security.Principal.WindowsPrincipal($identity)`,
    `$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`,
    `if ($isAdmin) { 'administrator' } else { 'limited' }`,
  ].join("; ");

  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ], { timeout: 5_000, windowsHide: true });
    const value = stdout.trim().toLowerCase();
    return value === "administrator" ? "administrator" : value === "limited" ? "limited" : "unknown";
  } catch {
    return "unknown";
  }
}

export function buildRunAsLauncherScript(helperPath: string, enabled: boolean, launchId = "test-launch"): string {
  const mode = enabled ? "enable" : "disable";
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$logDir = Join-Path $env:USERPROFILE '.devspace\\logs'`,
    `$logPath = Join-Path $logDir 'admin-mode-launcher.log'`,
    `$helperPath = ${powershellLiteral(helperPath)}`,
    `New-Item -ItemType Directory -Path $logDir -Force | Out-Null`,
    `"$(Get-Date -Format o) launcher-start id=${launchId} mode=${mode} session=$([System.Diagnostics.Process]::GetCurrentProcess().SessionId)" | Add-Content -LiteralPath $logPath`,
    `try {`,
    `  $powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'`,
    `  $quotedHelper = '"' + $helperPath + '"'`,
    `  $arguments = @('-NoProfile', '-File', $quotedHelper)`,
    `  $process = Start-Process -FilePath $powershell -Verb RunAs -ArgumentList $arguments -PassThru -Wait`,
    `  "$(Get-Date -Format o) launcher-finished id=${launchId} mode=${mode} exitCode=$($process.ExitCode)" | Add-Content -LiteralPath $logPath`,
    `} catch {`,
    `  "$(Get-Date -Format o) launcher-failed id=${launchId} mode=${mode} error=$($_.Exception.Message)" | Add-Content -LiteralPath $logPath`,
    `  throw`,
    `} finally {`,
    `  Remove-Item -LiteralPath $helperPath -Force -ErrorAction SilentlyContinue`,
    `  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue`,
    `}`,
  ].join("\r\n");
}

async function launchInteractivePowerShell(launcherPath: string, enabled: boolean, launchId: string): Promise<void> {
  const mode = enabled ? "enable" : "disable";
  const logDir = join(homedir(), ".devspace", "logs");
  const parentLogPath = join(logDir, "admin-mode-parent.log");
  const powershell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

  await mkdir(logDir, { recursive: true });
  await appendParentLog(parentLogPath, `parent-launch-start mode=${mode} executable=${powershell} launcher=${launcherPath}`);

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(powershell, [
      "-NoProfile",
      "-File",
      launcherPath,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });
  } catch (error) {
    await appendParentLog(parentLogPath, `parent-launch-failed mode=${mode} error=${errorMessage(error)}`);
    throw error;
  }

  try {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = appendLimitedOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendLimitedOutput(stderr, chunk);
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await appendParentLog(parentLogPath, `parent-launch-spawned id=${launchId} mode=${mode} pid=${child.pid ?? "unknown"}`);

    const earlyExit = new Promise<never>((_, reject) => {
      child.once("exit", (code, signal) => {
        reject(new Error([
          `PowerShell launcher exited before handshake: code=${code ?? "null"} signal=${signal ?? "null"}.`,
          stdout ? `stdout=${sanitizeProcessOutput(stdout)}` : "",
          stderr ? `stderr=${sanitizeProcessOutput(stderr)}` : "",
        ].filter(Boolean).join(" ")));
      });
    });

    await Promise.race([
      waitForLauncherHandshake(join(logDir, "admin-mode-launcher.log"), launchId),
      earlyExit,
    ]);
    await appendParentLog(parentLogPath, `parent-launch-ready id=${launchId} mode=${mode}`);
  } catch (error) {
    await appendParentLog(parentLogPath, `parent-launch-failed mode=${mode} error=${errorMessage(error)}`);
    throw error;
  }
}

async function waitForLauncherHandshake(path: string, launchId: string): Promise<void> {
  const expected = `launcher-start id=${launchId} `;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const content = await readFile(path, "utf8");
      if (content.includes(expected)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("PowerShell launcher process was created but did not begin execution within 3 seconds. Security software may have blocked or terminated it.");
}

async function appendParentLog(path: string, message: string): Promise<void> {
  await appendFile(path, `${new Date().toISOString()} ${message}\r\n`, "utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.replaceAll("\r", " ").replaceAll("\n", " ") : String(error);
}

function appendLimitedOutput(current: string, chunk: Buffer | string): string {
  const next = current + String(chunk);
  return next.length > 4_096 ? next.slice(-4_096) : next;
}

function sanitizeProcessOutput(value: string): string {
  return value.trim().replaceAll("\r", " ").replaceAll("\n", " ").slice(-2_048);
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
