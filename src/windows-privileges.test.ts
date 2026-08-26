import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAdminModeTransitionScript,
  buildRunAsLauncherScript,
  normalizeTaskRunLevel,
} from "./windows-privileges.js";

test("scheduled task run levels normalize to the control-center model", () => {
  assert.equal(normalizeTaskRunLevel("Highest"), "highest");
  assert.equal(normalizeTaskRunLevel("HighestAvailable"), "highest");
  assert.equal(normalizeTaskRunLevel("Limited"), "limited");
  assert.equal(normalizeTaskRunLevel("LeastPrivilege"), "limited");
  assert.equal(normalizeTaskRunLevel("missing"), "missing");
  assert.equal(normalizeTaskRunLevel("unexpected"), "unknown");
});

test("enabling administrator mode rewrites the task to HighestAvailable and restarts it", () => {
  const script = buildAdminModeTransitionScript("DevSpace Server", true);
  assert.match(script, /HighestAvailable/);
  assert.match(script, /Export-ScheduledTask/);
  assert.match(script, /Stop-ScheduledTask/);
  assert.match(script, /Register-ScheduledTask/);
  assert.match(script, /Start-ScheduledTask/);
});

test("disabling administrator mode rewrites the task to LeastPrivilege", () => {
  const script = buildAdminModeTransitionScript("DevSpace Server", false);
  assert.match(script, /LeastPrivilege/);
  assert.doesNotMatch(script, /HighestAvailable/);
});

test("administrator mode launcher requests an interactive RunAs elevation and logs its outcome", () => {
  const script = buildRunAsLauncherScript("encoded-helper", true);
  assert.match(script, /-Verb RunAs/);
  assert.match(script, /-PassThru -Wait/);
  assert.match(script, /admin-mode-launcher\.log/);
  assert.match(script, /launcher-start id=test-launch mode=enable/);
  assert.match(script, /launcher-failed id=test-launch mode=enable/);
  assert.doesNotMatch(script, /WindowStyle.*Hidden/);
});
