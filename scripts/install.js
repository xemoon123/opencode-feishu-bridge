#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const HOME = os.homedir();
const NL = String.fromCharCode(10);
const Q = String.fromCharCode(34);

function findObjectClose(text, openIdx) {
  let depth = 0;
  let inStr = false;
  let i = openIdx;
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      if (ch === String.fromCharCode(92)) { i += 2; continue; }
      if (ch === Q) { inStr = false; }
      i += 1; continue;
    }
    if (ch === Q) { inStr = true; i += 1; continue; }
    if (ch === "/" && text[i + 1] === "/") { while (i < text.length && text.charCodeAt(i) !== 10) i += 1; continue; }
    if (ch === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1; i += 2; continue; }
    if (ch === "{") depth += 1;
    if (ch === "}") { depth -= 1; if (depth === 0) return i; }
    i += 1;
  }
  return -1;
}

let text = null;

function entryBlock(mcpServer) {
  const mcpKey = text.indexOf(Q + "mcp" + Q);
  const lineStart = mcpKey >= 0 ? text.lastIndexOf(NL, mcpKey) + 1 : 0;
  const keyLine = text.slice(lineStart, mcpKey >= 0 ? mcpKey : 0);
  const mcpIndent = keyLine.length - keyLine.trimStart().length;
  const ind1 = " ".repeat(mcpIndent + 2);
  const ind2 = " ".repeat(mcpIndent + 4);
  return [
    ind1 + Q + "feishu-bridge" + Q + ": {",
    ind2 + Q + "type" + Q + ": " + Q + "local" + Q + ",",
    ind2 + Q + "command" + Q + ": " + JSON.stringify([process.execPath, mcpServer]) + ",",
    ind2 + Q + "enabled" + Q + ": true,",
    ind2 + Q + "environment" + Q + ": { " + Q + "BRIDGE_API_URL" + Q + ": " + Q + "http://127.0.0.1:4100" + Q + " }",
    ind1 + "}"
  ].join(NL);
}

function ensureMcpEntry(mcpServer) {
  const mcpKey = text.indexOf(Q + "mcp" + Q);
  if (mcpKey < 0) {
    const lastBrace = text.lastIndexOf("}");
    const e = entryBlock(mcpServer);
    const block = "  " + Q + "mcp" + Q + ": {" + NL + e + NL + "  }";
    text = text.slice(0, lastBrace) + block + (lastBrace >= 0 ? "," : "") + NL + text.slice(lastBrace);
    return;
  }
  const open = text.indexOf("{", mcpKey);
  const close = findObjectClose(text, open);
  if (close < 0) { throw new Error("无法解析 opencode.jsonc 的 mcp 段"); }
  const inner = text.slice(open + 1, close).trim();
  const e = entryBlock(mcpServer);
  if (inner === "") {
    text = text.slice(0, open + 1) + NL + e + NL + "  " + text.slice(close);
  } else {
    text = text.slice(0, open + 1) + NL + e + "," + NL + text.slice(open + 1);
  }
}

const skillSrc = path.join(ROOT, "skills", "feishu-bridge", "SKILL.md");
const skillDst = path.join(HOME, ".config", "opencode", "skills", "feishu-bridge", "SKILL.md");
if (!fs.existsSync(skillSrc)) { console.error("[install] 缺少技能源文件: " + skillSrc); process.exit(1); }
fs.mkdirSync(path.dirname(skillDst), { recursive: true });
fs.copyFileSync(skillSrc, skillDst);
console.log("[install] 技能已安装: " + skillDst);

const mcpServer = path.join(ROOT, "dist", "feishu-mcp-server.js");
if (!fs.existsSync(mcpServer)) { console.error("[install] 缺少 MCP 服务文件: " + mcpServer); process.exit(1); }
const cfgPath = path.join(HOME, ".config", "opencode", "opencode.jsonc");
text = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : "{}\n";
if (text.indexOf(Q + "feishu-bridge" + Q) >= 0) {
  console.log("[install] opencode.jsonc 已包含 feishu-bridge，跳过 MCP 注册");
} else {
  ensureMcpEntry(mcpServer);
  fs.writeFileSync(cfgPath, text);
  console.log("[install] 已注册 feishu-bridge MCP: " + mcpServer);
}
console.log("[install] 完成。技能与 MCP 均已就绪。");
