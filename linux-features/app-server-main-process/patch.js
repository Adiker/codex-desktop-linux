"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
const ID = String.raw`[A-Za-z_$][\w$]*`;
const MAIN = new RegExp(
  String.raw`function\((?<kind>${ID})\)\{let\{entry:(?<entry>${ID}),serviceName:(?<service>${ID})\}=(?<map>${ID})\[\k<kind>\];return (?<electron>${ID})\.utilityProcess\.fork\(\(0,(?<path>${ID})\.join\)\(__dirname,\k<entry>\),\[\],\{serviceName:\k<service>\}\)\}`,
  "g",
);
const MAIN_LAUNCH = new RegExp(
  String.raw`\(0,${ID}\.${ID}\)\("app-server-host"\),${ID}=\(0,${ID}\.${ID}\)\("app-server-host"\);${ID}\.once\("spawn",\(\)=>${ID}\.info\("App server utility started"`,
  "g",
);
const MAIN_MAPPING = '"app-server-host":{entry:"app-server-host.js",serviceName:"App server host"}';
const MAIN_RESOURCE = 'require(require("node:path").join(process.resourcesPath,"..",".codex-linux","features","app-server-main-process","bridge-main.js"))';
const UTILITY_RESOURCE = 'require(require("node:path").join(process.resourcesPath,"..",".codex-linux","features","app-server-main-process","bridge-utility.js"))';
const HOST_MARKER = "codexLinuxChild";

function patchMain(source) {
  const matches = [...source.matchAll(MAIN)];
  if (matches.length !== 1 || [...source.matchAll(MAIN_LAUNCH)].length !== 1 ||
      source.split(MAIN_MAPPING).length !== 2) return null;
  const { kind, electron } = matches[0].groups;
  const original = matches[0][0];
  const callStart = original.indexOf("return ") + "return ".length;
  const forkCall = original.slice(callStart, -1);
  const wrapped = original.slice(0, callStart) +
    `((worker)=>(${kind}===\"app-server-host\"&&${MAIN_RESOURCE}.attach(worker,${electron}),worker))(${forkCall})}`;
  return source.replace(original, wrapped);
}

function patchHost(source) {
  const anchors = [
    'process.parentPort.on("message",e=>{',
    'this.options.hostConfig.id',
    'constructor(e,t){this.options=e,this.ioStatsTracker=t,this.stdoutMessageReader=',
    'this.spawnProcess()',
    'spawnProcess(){let e=this.options.spawnCommand??this.options.executablePath,t=h.K.resolve(e,{env:this.options.env})??e,r=this.options.spawnArgs??this.options.args,i=(0,n.spawn)(t,r,{stdio:["pipe","pipe","pipe"],env:this.options.env,cwd:this.options.cwd})',
    'let n="local"===this.options.hostConfig.kind&&null==t.spawnCommand&&null==this.options.startupCommand?await this.options.getAppServerArgs?.(t.executablePath):void 0;return this.kind="stdio",new G({...t,args:[...t.args,...n??[]]},this.ioStatsTracker)',
  ];
  if (anchors.some((anchor) => source.split(anchor).length !== 2) ||
      /\bcodexLinux(?:Options|Child|Executable)\b/.test(source)) return null;
  let result = source;
  result = result.replace(anchors[0], `${anchors[0]}if(e.data?.type==="codex-linux-app-server-bridge"){${UTILITY_RESOURCE}.accept(e);return}`);
  result = result.replace(anchors[3], 'this.spawnProcess(arguments[2])');
  result = result.replace(anchors[4], anchors[4].replace('spawnProcess(){', 'spawnProcess(codexLinuxChild){').replace('i=(0,n.spawn)', 'i=codexLinuxChild??(0,n.spawn)'));
  const args = '{...t,args:[...t.args,...n??[]]}';
  const connect = anchors[5].replace(`return this.kind="stdio",new G(${args},this.ioStatsTracker)`,
    `let codexLinuxOptions=${args},codexLinuxChild;` +
    `if(this.options.hostConfig.kind==="local"&&this.options.hostConfig.id==="local"&&null==t.spawnCommand&&null==this.options.startupCommand){` +
    `let codexLinuxExecutable=codexLinuxOptions.spawnCommand??codexLinuxOptions.executablePath;` +
    `codexLinuxChild=await ${UTILITY_RESOURCE}.spawn(h.K.resolve(codexLinuxExecutable,{env:codexLinuxOptions.env})??codexLinuxExecutable,codexLinuxOptions.spawnArgs??codexLinuxOptions.args,{env:codexLinuxOptions.env,cwd:codexLinuxOptions.cwd})}` +
    `return this.kind="stdio",new G(codexLinuxOptions,this.ioStatsTracker,codexLinuxChild)`);
  return result.replace(anchors[5], connect);
}

function patchExtractedApp(dir) {
  const main = findMainProcessChunks(dir);
  if (!main) return { matched: false, changed: false, reason: "Main-process chunks missing" };
  const files = main.chunks.map((name) => path.join(main.buildDir, name));
  const sources = files.map((file) => fs.readFileSync(file, "utf8"));
  const hostFile = path.join(main.buildDir, "app-server-host.js");
  if (!fs.existsSync(hostFile)) return { matched: false, changed: false, reason: "App-server utility bundle missing" };
  const host = fs.readFileSync(hostFile, "utf8");
  const alreadyMain = sources.filter((s) => s.includes("bridge-main.js"));
  const completeHost = [
    'if(e.data?.type==="codex-linux-app-server-bridge")',
    'this.spawnProcess(arguments[2])',
    'spawnProcess(codexLinuxChild){',
    'i=codexLinuxChild??(0,n.spawn)',
    'this.options.hostConfig.id==="local"',
    'codexLinuxChild=await ',
  ].every((anchor) => host.split(anchor).length === 2);
  if (alreadyMain.length === 1 && completeHost && host.split("bridge-utility.js").length === 3) return { matched: true, changed: false };
  if (alreadyMain.length || host.includes(HOST_MARKER) || host.includes("bridge-utility.js")) return { matched: false, changed: false, reason: "Incomplete bridge patch" };
  const candidates = sources.map(patchMain).map((value, i) => ({ value, i })).filter(({ value }) => value != null);
  const patchedHost = patchHost(host);
  if (candidates.length !== 1 || patchedHost == null) return { matched: false, changed: false, reason: "App-server launch contract changed" };
  fs.writeFileSync(files[candidates[0].i], candidates[0].value);
  fs.writeFileSync(hostFile, patchedHost);
  return { matched: true, changed: true };
}

const descriptors = [{ id: "main-process-app-server-bridge", phase: "extracted-app:pre-webview", ciPolicy: "optional", apply: patchExtractedApp,
  status: (result) => !result?.matched ? "skipped-optional" : result.changed ? "applied" : "already-applied" }];
module.exports = { patchExtractedApp, patchMain, patchHost, descriptors };
