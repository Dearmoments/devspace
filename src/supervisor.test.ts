import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { backendProxyHeaders, DevSpaceChildController } from "./supervisor.js";

class FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCalls: Array<NodeJS.Signals | number | undefined> = [];
  deferExitEventOnKill = false;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push(signal);
    if (this.exitCode !== null) return false;
    this.exitCode = 0;
    this.signalCode = typeof signal === "string" ? signal : null;
    if (!this.deferExitEventOnKill) {
      queueMicrotask(() => this.emit("exit", this.exitCode, this.signalCode));
    }
    return true;
  }

  emitDeferredExit(): void {
    this.emit("exit", this.exitCode, this.signalCode);
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
  assert.equal(spawns[0]?.env.DEVSPACE_TRUST_PROXY, "1");

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

test("supervisor normalizes forwarded client IP before proxying to the backend", () => {
  assert.equal(
    backendProxyHeaders({
      host: "devspace.example.com",
      "cf-connecting-ip": "203.0.113.25",
      "x-forwarded-for": "198.51.100.9, 192.0.2.7",
    }, "127.0.0.1")["x-forwarded-for"],
    "203.0.113.25",
  );

  assert.equal(
    backendProxyHeaders({ "x-forwarded-for": "198.51.100.9" }, "::ffff:127.0.0.1")["x-forwarded-for"],
    "127.0.0.1",
  );
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

test("unhealthy backend is restarted even when the child process is still running", async () => {
  let nextPid = 300;
  let healthy = true;
  const children: FakeChild[] = [];
  const spawnProcess = (() => {
    const child = new FakeChild(nextPid++);
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof nodeSpawn;

  const controller = new DevSpaceChildController({
    backendPort: 8767,
    getSchemaRevision: () => 4,
    cliPath: "C:/devspace/dist/cli.js",
    spawnProcess,
    healthCheck: async () => healthy,
    restartDelayMs: 1,
    healthCheckIntervalMs: 5,
    healthCheckFailureThreshold: 2,
  });

  await controller.start();
  healthy = false;
  await waitFor(() => children[0]?.killCalls.length === 1, "unhealthy backend termination");
  healthy = true;
  await waitFor(
    () => controller.snapshot().state === "running" && controller.snapshot().pid === 301,
    "replacement backend startup",
  );

  assert.equal(children[0]?.killCalls[0], "SIGTERM");
  assert.equal(children.length, 2);
  assert.equal(controller.snapshot().state, "running");
  assert.equal(controller.snapshot().pid, 301);

  await controller.shutdown();
});

test("a stale child exit event does not overwrite the replacement backend state", async () => {
  let nextPid = 400;
  const children: FakeChild[] = [];
  const spawnProcess = (() => {
    const child = new FakeChild(nextPid++);
    if (children.length === 0) child.deferExitEventOnKill = true;
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof nodeSpawn;

  const controller = new DevSpaceChildController({
    backendPort: 8768,
    getSchemaRevision: () => 5,
    cliPath: "C:/devspace/dist/cli.js",
    spawnProcess,
    healthCheck: async () => true,
    restartDelayMs: 1,
    healthCheckIntervalMs: 5,
  });

  await controller.start();
  await controller.restart();
  assert.equal(controller.snapshot().state, "running");
  assert.equal(controller.snapshot().pid, 401);

  children[0]?.emitDeferredExit();

  assert.equal(controller.snapshot().state, "running");
  assert.equal(controller.snapshot().pid, 401);

  await controller.shutdown();
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, description: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(10);
  }
}
