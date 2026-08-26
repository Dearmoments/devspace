import { execFile, spawn } from "node:child_process";
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
  const helperScript = buildAdminModeTransitionScript(taskName, enabled);
  const encodedHelper = encodePowerShell(helperScript);
  const launcherScript = buildRunAsLauncherScript(encodedHelper, enabled);

  launchInteractivePowerShell(launcherScript);

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

export function buildRunAsLauncherScript(encodedHelper: string, enabled: boolean): string {
  const mode = enabled ? "enable" : "disable";
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$logDir = Join-Path $env:USERPROFILE '.devspace\\logs'`,
    `$logPath = Join-Path $logDir 'admin-mode-launcher.log'`,
    `New-Item -ItemType Directory -Path $logDir -Force | Out-Null`,
    `"$(Get-Date -Format o) launcher-start mode=${mode} session=$([System.Diagnostics.Process]::GetCurrentProcess().SessionId)" | Add-Content -LiteralPath $logPath`,
    `try {`,
    `  $powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'`,
    `  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ${powershellLiteral(encodedHelper)})`,
    `  $process = Start-Process -FilePath $powershell -Verb RunAs -ArgumentList $arguments -PassThru -Wait`,
    `  "$(Get-Date -Format o) launcher-finished mode=${mode} exitCode=$($process.ExitCode)" | Add-Content -LiteralPath $logPath`,
    `} catch {`,
    `  "$(Get-Date -Format o) launcher-failed mode=${mode} error=$($_.Exception.Message)" | Add-Content -LiteralPath $logPath`,
    `  throw`,
    `}`,
  ].join("\r\n");
}

function launchInteractivePowerShell(script: string): void {
  const powershell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const child = spawn(powershell, [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodePowerShell(script),
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
