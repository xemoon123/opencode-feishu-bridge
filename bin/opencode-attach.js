#!/usr/bin/env node

const path = require("node:path");
// 复用桥的 opencode 启动抽象：Windows 上 npm 只提供 opencode.cmd 垫片，直接 spawn 会失败
const { spawnOpenCode } = require(path.join(__dirname, "..", "dist", "opencode-exec.js"));

const defaultUrl = "http://127.0.0.1:4096";
const args = process.argv.slice(2);
const hasUrlArg = Boolean(args[0] && !args[0].startsWith("-"));
const url = hasUrlArg ? args[0] : defaultUrl;
const extraArgs = hasUrlArg ? args.slice(1) : args;

const { child, plan } = spawnOpenCode(["attach", url, "--dir", process.cwd(), ...extraArgs], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: process.env
});

if (plan.kind === "cmd-shim" || plan.kind === "cmd-shell") {
  console.error("[attach] 经 cmd.exe 启动:", plan.source);
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error("启动 opencode attach 失败:", error.message);
  process.exit(1);
});
