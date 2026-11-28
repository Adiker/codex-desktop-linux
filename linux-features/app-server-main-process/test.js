"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { once, EventEmitter } = require("node:events");
const { MessageChannel } = require("node:worker_threads");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { attach } = require("./bridge-main");
const utility = require("./bridge-utility");
const { patchExtractedApp, patchMain, patchHost } = require("./patch");

class PortAdapter extends EventEmitter {
  constructor(port) {
    super(); this.port = port;
    port.on("message", (data) => this.emit("message", { data }));
    port.on("close", () => this.emit("close"));
  }
  start() { this.port.start(); }
  close() { this.port.close(); }
  postMessage(data) { this.port.postMessage(data); }
}
class ChannelAdapter {
  constructor() {
    const { port1, port2 } = new MessageChannel();
    this.port1 = new PortAdapter(port1); this.port2 = new PortAdapter(port2);
  }
}
const worker = new EventEmitter();
worker.postMessage = (data, ports) => utility.accept({ data, ports });
const cleanup = attach(worker, { MessageChannelMain: ChannelAdapter });
test.after(() => cleanup());

async function output(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

test("bridge forwards stdio with backpressure and exit status", async () => {
  const script = 'process.stdin.pipe(process.stdout);process.stdin.on("end",()=>{process.stderr.write("done");process.exitCode=7})';
  const child = await utility.spawn(process.execPath, ["-e", script], { env: process.env });
  const stdout = output(child.stdout), stderr = output(child.stderr), exit = once(child, "exit");
  const input = "zażółć 🐈".repeat(70_000);
  child.stdin.end(input);
  assert.equal(await stdout, input);
  assert.equal(await stderr, "done");
  assert.deepEqual(await exit, [7, null]);
});

test("bridge reports spawn failures", async () => {
  await assert.rejects(utility.spawn("/nonexistent/codex", [], { env: process.env }), /ENOENT/);
});

test("bridge preserves the requested working directory and environment", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-server-cwd-"));
  try {
    const child = await utility.spawn(process.execPath, ["-e", 'process.stdout.write(JSON.stringify([process.cwd(),process.env.BRIDGE_TEST_VALUE]))'], {
      cwd, env: { ...process.env, BRIDGE_TEST_VALUE: "chosen value" },
    });
    const stdout = output(child.stdout), exit = once(child, "exit");
    assert.deepEqual(JSON.parse(await stdout), [cwd, "chosen value"]);
    assert.deepEqual(await exit, [0, null]);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("bridge preserves the main process no-new-privileges state", { skip: process.platform !== "linux" }, async () => {
  const mainStatus = fs.readFileSync("/proc/self/status", "utf8").match(/^NoNewPrivs:\s*(\d+)/m)[1];
  const script = 'process.stdout.write(require("fs").readFileSync("/proc/self/status","utf8").match(/^NoNewPrivs:\\s*(\\d+)/m)[1])';
  const child = await utility.spawn(process.execPath, ["-e", script], { env: process.env });
  const stdout = output(child.stdout);
  const exit = once(child, "exit");
  assert.equal(await stdout, mainStatus);
  assert.deepEqual(await exit, [0, null]);
});

test("bridge terminates the owned child", async () => {
  const child = await utility.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: process.env });
  const exit = once(child, "exit");
  assert.equal(child.kill(), true);
  assert.deepEqual(await exit, [null, "SIGTERM"]);
});

test("patches the utility fork only at a unique current anchor", () => {
  const main = 'let e=(0,h.j)("app-server-host"),t=(0,s.$Cz)("app-server-host");e.once("spawn",()=>t.info("App server utility started"));let s={"app-server-host":{entry:"app-server-host.js",serviceName:"App server host"}};function(e){let{entry:t,serviceName:r}=s[e];return i.utilityProcess.fork((0,n.join)(__dirname,t),[],{serviceName:r})}';
  assert.match(patchMain(main), /app-server-host.*bridge-main\.js/);
  assert.equal(patchMain(main + main), null);
  assert.equal(patchMain(main.replace('(0,h.j)("app-server-host")', '(0,h.j)("renamed-host")')), null);
  assert.equal(patchMain(main.replace('entry:"app-server-host.js"', 'entry:"renamed-host.js"')), null);
});

test("keeps non-bridged spawn failures synchronous and rejects bridged connect failures", async () => {
  const host = 'this.options.hostConfig.id;process.parentPort.on("message",e=>{});constructor(e,t){this.options=e,this.ioStatsTracker=t,this.stdoutMessageReader=null,this.spawnProcess()}spawnProcess(){let e=this.options.spawnCommand??this.options.executablePath,t=h.K.resolve(e,{env:this.options.env})??e,r=this.options.spawnArgs??this.options.args,i=(0,n.spawn)(t,r,{stdio:["pipe","pipe","pipe"],env:this.options.env,cwd:this.options.cwd});if(!i.pid)throw Error(`Failed to spawn Codex CLI`)};let n="local"===this.options.hostConfig.kind&&null==t.spawnCommand&&null==this.options.startupCommand?await this.options.getAppServerArgs?.(t.executablePath):void 0;return this.kind="stdio",new G({...t,args:[...t.args,...n??[]]},this.ioStatsTracker)';
  const patched = patchHost(host);
  assert.ok(patched);
  assert.match(patched, /bridge-utility\.js/);
  assert.match(patched, /spawnProcess\(codexLinuxChild\)/);
  assert.doesNotMatch(patched, /async spawnProcess/);
  const start = patched.indexOf('let n="local"===this.options.hostConfig.kind');
  const body = patched.slice(start);
  let bridgeCalls = 0;
  const failure = Error("bridge spawn failed");
  const bridge = { spawn: async () => { bridgeCalls++; throw failure; } };
  const load = (name) => name === "node:path" ? { join: () => "bridge" } : bridge;
  const connectionFailure = Error("Failed to spawn Codex CLI");
  const G = class { constructor() { throw connectionFailure; } };
  const connect = new Function("t", "G", "h", "require", `return (async function(){${body}}).call(this)`); // eslint-disable-line no-new-func
  const launch = { executablePath: "/codex", args: [], env: {} };
  const invoke = (hostConfig, options = {}, overrides = {}) => connect.call(
    { options: { hostConfig, ...options } }, { ...launch, ...overrides }, G, { K: { resolve: () => null } }, load,
  );
  for (const [hostConfig, options, overrides] of [
    [{ kind: "ssh", id: "local" }, {}, {}],
    [{ kind: "local", id: "durable" }, {}, {}],
    [{ kind: "local", id: "local" }, { startupCommand: {} }, {}],
    [{ kind: "local", id: "local" }, {}, { spawnCommand: "ssh" }],
  ]) await assert.rejects(invoke(hostConfig, options, overrides), (error) => error === connectionFailure);
  assert.equal(bridgeCalls, 0);
  await assert.rejects(invoke({ kind: "local", id: "local" }), (error) => error === failure);
  assert.equal(bridgeCalls, 1);
  for (const [before, after] of [
    ['h.K.resolve(e,{env:this.options.env})', 'h.X.resolve(e,{env:this.options.env})'],
    ['this.options.startupCommand?', 'this.options.renamedStartup?'],
    ['this.options.hostConfig.kind&&null==t.spawnCommand', 'this.options.hostConfig.type&&null==t.spawnCommand'],
    ['this.spawnProcess()', 'this.spawnChanged()'],
    ['this.options.hostConfig.id;', 'this.options.hostConfig.hostId;'],
  ]) {
    assert.notEqual(host.replace(before, after), host);
    assert.equal(patchHost(host.replace(before, after)), null);
  }
});

test("rejects the shared app-server socket feature combination", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-conflict-"));
  try {
    const config = path.join(dir, "features.json");
    fs.writeFileSync(config, JSON.stringify({ enabled: ["app-server-main-process", "shared-app-server-socket"] }));
    const result = spawnSync(process.execPath, [path.join(__dirname, "../../scripts/lib/linux-features.js"), "--enabled-feature-dirs0"], {
      encoding: "utf8", env: { ...process.env, CODEX_LINUX_FEATURES_CONFIG: config },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /app-server-main-process.*conflicts with.*shared-app-server-socket/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("patches both launch sites in the signed upstream bundle", {
  skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null,
}, async () => {
  const build = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, ".vite", "build");
  const chunks = fs.readdirSync(build).filter((name) => /^early-bootstrap(?:-\d+-[0-9a-f]+)?\.js$/.test(name));
  const patched = chunks.map((name) => patchMain(fs.readFileSync(path.join(build, name), "utf8"))).filter(Boolean);
  assert.equal(patched.length, 1);
  const host = patchHost(fs.readFileSync(path.join(build, "app-server-host.js"), "utf8"));
  assert.ok(host);
  new vm.Script(patched[0]);
  new vm.Script(host);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-server-patch-"));
  try {
    const target = path.join(temp, ".vite", "build");
    fs.mkdirSync(target, { recursive: true });
    for (const name of [...chunks, "app-server-host.js"]) fs.copyFileSync(path.join(build, name), path.join(target, name));
    assert.deepEqual(patchExtractedApp(temp), { matched: true, changed: true });
    assert.deepEqual(patchExtractedApp(temp), { matched: true, changed: false });
    const hostFile = path.join(target, "app-server-host.js");
    const damaged = fs.readFileSync(hostFile, "utf8").replace("codexLinuxChild=await", "incompleteBridge=await");
    fs.writeFileSync(hostFile, damaged);
    assert.equal(patchExtractedApp(temp).matched, false);
    assert.equal(fs.readFileSync(hostFile, "utf8"), damaged);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("closing the utility port terminates children and rejects further launches", async () => {
  const child = await utility.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: process.env });
  const pid = child.pid;
  const closed = new Promise((resolve) => child.once("exit", resolve));
  child.on("error", () => {});
  worker.emit("exit", 0);
  await closed;
  await assert.rejects(utility.spawn(process.execPath, [], { env: process.env }), /disconnected/);
  child.stdin.on("error", () => {});
  const writeError = await new Promise((resolve) => child.stdin.write("late input", resolve));
  assert.match(writeError.message, /bridge disconnected/);
  assert.equal(child.kill(), false);
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("child survived its utility process");
});
