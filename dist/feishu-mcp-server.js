#!/usr/bin/env node
"use strict";
/**
 * opencode 本地 MCP server：把飞书桥能力暴露给模型。
 * 本身是无状态转发器：模型工具调用 → HTTP 转发给桥(127.0.0.1:4100)，
 * 由桥使用"当前任务上下文"的飞书会话上传并发送真实文件。
 */
const http = require("node:http");

const BRIDGE_API_URL = process.env.BRIDGE_API_URL || "http://127.0.0.1:4100";

const TOOLS = [
  {
    name: "feishu_send_file",
    description:
      "把指定文件作为【真实文件消息】发送给飞书对话中的用户。当用户要求把某个文档/文件(md/pdf/代码等)发给他时使用：把文件的绝对路径传给本工具，桥会直接发出文件对象，无需在正文里粘贴文件内容。path 必须在当前工作目录内。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "要发送的文件绝对路径（必须在当前工作目录内）" }
      },
      required: ["path"]
    }
  }
];

function postBridge(pathname, payload) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(BRIDGE_API_URL);
    } catch (e) {
      resolve({ ok: false, error: `BRIDGE_API_URL 无效: ${BRIDGE_API_URL}` });
      return;
    }
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 4100,
      path: pathname,
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ ok: false, error: data || "非 JSON 响应" });
        }
      });
    });
    req.on("error", (error) => resolve({ ok: false, error: String((error && error.message) || error) }));
    req.end(JSON.stringify(payload || {}));
  });
}

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}
function sendToolError(id, message) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: `发送失败：${message}` }], isError: true }
  }) + "\n");
}

async function handle(msg) {
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
    return;
  }
  const id = msg.id;
  try {
    if (msg.method === "initialize") {
      const requested = msg.params && msg.params.protocolVersion;
      const protocolVersion =
        requested === "2025-03-26" || requested === "2025-06-18" || requested === "2024-11-05"
          ? requested
          : "2024-11-05";
      send(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "feishu-bridge-mcp", version: "0.1.0" }
      });
      return;
    }
    if (msg.method === "notifications/initialized") {
      return;
    }
    if (msg.method === "ping") {
      send(id, {});
      return;
    }
    if (msg.method === "tools/list") {
      send(id, { tools: TOOLS });
      return;
    }
    if (msg.method === "tools/call") {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      if (name === "feishu_send_file") {
        const filePath = String((args && args.path) || "").trim();
        if (!filePath) {
          sendToolError(id, "缺少 path 参数");
          return;
        }
        const result = await postBridge("/bridge/send-file", { path: filePath });
        if (result && result.ok === true) {
          send(id, {
            content: [{ type: "text", text: `✅ 已作为文件发送：${result.fileName}（${String(result.bytes)} 字节）` }],
            isError: false
          });
        } else {
          sendToolError(id, (result && result.error) || "未知错误");
        }
        return;
      }
      sendError(id, -32602, `Unknown tool: ${name}`);
      return;
    }
    sendError(id, -32601, `Method not found: ${msg.method}`);
  } catch (error) {
    sendError(id, -32603, String((error && error.message) || error));
  }
}

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) {
      continue;
    }
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      process.stderr.write(`[feishu-bridge-mcp] 无法解析输入: ${line}\n`);
      continue;
    }
    void handle(msg);
  }
});
process.stdin.on("end", () => { process.exit(0); });
