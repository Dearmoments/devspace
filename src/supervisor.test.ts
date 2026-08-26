import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { DevSpaceChildController } from "./supervisor.js";

class FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCalls: Array<NodeJS.Signals | number | undefined> = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push(signal);
    if (this.exitCode !== null) return false;
    this.exitCode = 0;
    this.signalCode = typeof signal === "string" ? signal : null;
    queueMicrotask(() => this.emit("exit", this.exitCode, this.signalCode));
    return true;
  }

  crash(code = 1): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    queueMicrotask(() => this.emit("exit", code, null));
  }
}

test("supervisor child controller starts, stops, and passes internal runtime settings", async () => {
  let nextPid = 100;
  let revision = 7;
  const children: FakeChild[] = [];
  const spawns: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const spawnProcess = ((command: string, args: readonly string[] = [], options: { env?: NodeJS.ProcessEnv } = {}) => {
    const child = new FakeChild(nextPid++);
    children.push(child);
    spawns.push({ command, args, env: options.env ?? {} });
    return child as unknown as ChildProcess;
  }) as unknown as typeof nodeSpawn;

  const controller = new DevSpaceChildController({
    backendPort: 8765,
    getSchemaRevision: () => revision,
    cliPath: "C:/devspace/dist/cli.js",
    spawnProcess,
    healthCheck: async () => true,
    restartDelayMs: 1,
  });

  await controller.start();
  assert.equal(controller.snapshot().state, "running");
  assert.equal(controller.snapshot().pid, 100);
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0]?.args, ["C:/devspace/dist/cli.js", "serve"]);
  assert.equal(spawns[0]?.env.HOST, "127.0.0.1");
  assert.equal(spawns[0]?.env.PORT, "8765");
  assert.equal(spawns[0]?.env.DEVSPACE_SUPERVISOR_CHILD, "1");
  assert.equal(spawns[0]?.env.DEVSPACE_SCHEMA_REVISION, "7");

  revision = 8;
  await controller.restart();
  assert.equal(children[0]?.killCalls[0], "SIGTERM");
  assert.equal(controller.snapshot().state, "running");
  assert.equal(controller.snapshot().pid, 101);
  assert.equal(spawns[1]?.env.DEVSPACE_SCHEMA_REVISION, "8");

  await controller.stop();
  assert.equal(children[1]?.killCalls[0], "SIGTERM");
  assert.equal(controller.snapshot().state, "stopped");
  assert.equal(controller.snapshot().pid, undefined);
});

test("unexpected backend exit is restarted while desired state is running", async () => {
  let nextPid = 200;
  const children: FakeChild[] = [];
  const spawnProcess = (() => {
    const child = new FakeChild(nextPid++);
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof nodeSpawn;

  const controller = new DevSpaceChildController({
    backendPort: 8766,
    getSchemaRevision: () => 3,
    cliPath: "C:/devspace/dist/cli.js",
    spawnProcess,
    healthCheck: async () => true,
    restartDelayMs: 1,
  });

  await controller.start();
  children[0]?.crash(23);
  await delay(25);

  assert.equal(children.length, 2);
  assert.equal(controller.snapshot().state, "running");
  assert.equal(controller.snapshot().pid, 201);
  assert.equal(controller.snapshot().lastExitCode, 23);

  await controller.shutdown();
  await delay(0);
  assert.equal(controller.snapshot().state, "stopped");
  assert.equal(children.length, 2, "shutdown must not schedule another automatic restart");
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
