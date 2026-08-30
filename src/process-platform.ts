import { basename, join, win32 as winPath } from "node:path";
import { existsSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export interface ShellCommand {
  executable: string;
  args: string[];
}

export interface OpenFolderCommand {
  executable: string;
  args: string[];
}

export interface KillableProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

interface ProcessTreeRuntime {
  platform: NodeJS.Platform;
  killGroup(pid: number, signal: NodeJS.Signals): void;
  killWindowsTree(pid: number): boolean;
}

const defaultProcessTreeRuntime: ProcessTreeRuntime = {
  platform: process.platform,
  killGroup: (pid, signal) => process.kill(-pid, signal),
  killWindowsTree: (pid) => {
    const result = spawnSync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  },
};

const LOGIN_SHELLS = new Set(["bash", "ksh", "zsh"]);
const POSIX_SHELLS = new Set(["ash", "dash", "sh"]);

export function resolveShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ShellCommand {
  if (platform === "win32") {
    // DevSpace's command contract is Bash, including on Windows.  Passing
    // ComSpec here makes POSIX commands (printf, &&, quoting, etc.) behave
    // differently from the documented shell and also changes the encoding of
    // command output.  Prefer an installed Git/MSYS/WSL Bash and leave a
    // normal PATH lookup as the final fallback so the eventual spawn error is
    // explicit when Bash is genuinely unavailable.
    const bash = resolveWindowsBash(environment);
    return {
      executable: bash,
      args: ["-c", command],
    };
  }

  const configuredShell = environment.SHELL;
  const shellName = configuredShell ? basename(configuredShell) : "";
  if (configuredShell && LOGIN_SHELLS.has(shellName)) {
    return { executable: configuredShell, args: ["-lc", command] };
  }
  if (configuredShell && POSIX_SHELLS.has(shellName)) {
    return { executable: configuredShell, args: ["-c", command] };
  }

  return { executable: "/bin/sh", args: ["-c", command] };
}

function resolveWindowsBash(environment: NodeJS.ProcessEnv): string {
  const explicit = environment.DEVSPACE_BASH_PATH?.trim();
  if (explicit) return explicit;

  const configuredShell = environment.SHELL?.trim();
  if (configuredShell && /(?:^|[\\/])bash(?:\.exe)?$/i.test(configuredShell)) {
    return configuredShell;
  }

  const programFiles = environment.ProgramFiles;
  const programFilesX86 = environment["ProgramFiles(x86)"];
  const localAppData = environment.LOCALAPPDATA;
  const candidates = [
    programFiles ? winPath.join(programFiles, "Git", "bin", "bash.exe") : undefined,
    programFiles ? winPath.join(programFiles, "Git", "usr", "bin", "bash.exe") : undefined,
    programFilesX86 ? winPath.join(programFilesX86, "Git", "bin", "bash.exe") : undefined,
    programFilesX86 ? winPath.join(programFilesX86, "Git", "usr", "bin", "bash.exe") : undefined,
    localAppData ? winPath.join(localAppData, "Programs", "Git", "bin", "bash.exe") : undefined,
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  const pathValue = Object.entries(environment).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  for (const entry of pathValue.split(";")) {
    const trimmed = entry.trim().replace(/^"|"$/g, "");
    if (!trimmed) continue;
    const candidate = winPath.join(trimmed, "bash.exe");
    if (existsSync(candidate)) return candidate;
  }

  // Let CreateProcess perform the final PATH lookup.  This keeps the failure
  // on the command operation (with a useful Bash-not-found error) instead of
  // silently falling back to cmd.exe.
  return "bash.exe";
}

export function resolveOpenFolderCommand(
  path: string,
  platform: NodeJS.Platform = process.platform,
): OpenFolderCommand {
  if (!path) throw new Error("Folder path is required.");
  switch (platform) {
    case "win32":
      return { executable: "explorer.exe", args: [path] };
    case "darwin":
      return { executable: "open", args: [path] };
    case "linux":
    case "freebsd":
    case "openbsd":
    case "sunos":
      return { executable: "xdg-open", args: [path] };
    default:
      throw new Error(`Opening folders is not supported on ${platform}.`);
  }
}

export function openFolder(
  path: string,
  platform: NodeJS.Platform = process.platform,
  spawnProcess: typeof spawn = spawn,
): Promise<void> {
  const command = resolveOpenFolderCommand(path, platform);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawnProcess(command.executable, command.args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

export function terminateProcessTree(
  child: KillableProcess,
  signal: NodeJS.Signals,
  detached: boolean,
  runtime: ProcessTreeRuntime = defaultProcessTreeRuntime,
): void {
  if (runtime.platform === "win32" && child.pid) {
    if (runtime.killWindowsTree(child.pid)) return;
  } else if (detached && child.pid) {
    try {
      runtime.killGroup(child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }

  child.kill(signal);
}
