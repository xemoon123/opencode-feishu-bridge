#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

const skillDir = path.join(HOME, ".config", "opencode", "skills", "feishu-bridge");
if (fs.existsSync(skillDir)) { fs.rmSync(skillDir, { recursive: true, force: true }); console.log("[uninstall] 已移除技能目录: " + skillDir); }
else { console.log("[uninstall] 技能目录不存在，跳过"); }

const cfgPath = path.join(HOME, ".config", "opencode", "opencode.jsonc");
if (!fs.existsSync(cfgPath)) { console.log("[uninstall] opencode.jsonc 不存在，跳过 MCP 移除"); process.exit(0); }
let text = fs.readFileSync(cfgPath, "utf8");
const keyIdx = text.indexOf(Q + "feishu-bridge" + Q);
if (keyIdx < 0) {
  console.log("[uninstall] opencode.jsonc 无 feishu-bridge 条目");
} else {
  const open = text.indexOf("{", keyIdx);
  const close = findObjectClose(text, open);
  let end = close + 1;
  let j = close + 1;
  while (j < text.length && (text[j] === " " || text.charCodeAt(j) === 9)) j += 1;
  if (text[j] === ",") end = j + 1;
  if (text[end] === NL) end += 1;
  let lineStart = keyIdx;
  while (lineStart > 0 && text[lineStart - 1] !== NL) lineStart -= 1;
  text = text.slice(0, lineStart) + text.slice(end);
  fs.writeFileSync(cfgPath, text);
  console.log("[uninstall] 已移除 opencode.jsonc 的 feishu-bridge MCP");
}
console.log("[uninstall] 完成。技能与 MCP 均已移除。");
