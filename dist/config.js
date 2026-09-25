"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const zod_1 = require("zod");
const CONFIG_FILE_PATH = (0, node_path_1.join)((0, node_os_1.homedir)(), ".config", "opencode", "feishu-bridge", "config.json");
function failAndExit(message) {
    console.error(message);
    process.exit(1);
    throw new Error(message);
}
function loadConfigFile(filePath) {
    let rawText = "";
    try {
        rawText = (0, node_fs_1.readFileSync)(filePath, "utf8");
    }
    catch (error) {
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
            ? error.code
            : "";
        if (code === "ENOENT") {
            return createConfigInteractively(filePath);
        }
        const detail = error instanceof Error ? error.message : String(error);
        failAndExit(`配置文件读取失败: ${filePath}\n${detail}`);
    }
    try {
        return JSON.parse(rawText);
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failAndExit(`配置文件 JSON 解析失败: ${filePath}\n${detail}`);
    }
}
function readLineFromTty(prompt) {
    process.stdout.write(prompt);
    const chunks = [];
    const buffer = Buffer.alloc(1);
    const stdinFd = typeof process.stdin.fd === "number" ? process.stdin.fd : 0;
    while (true) {
        let bytesRead = 0;
        try {
            bytesRead = (0, node_fs_1.readSync)(stdinFd, buffer, 0, 1, null);
        }
        catch (error) {
            const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
                ? error.code
                : "";
            if (code === "EAGAIN" || code === "EINTR") {
                continue;
            }
            const detail = error instanceof Error ? error.message : String(error);
            failAndExit(`读取终端输入失败: ${detail}`);
        }
        if (bytesRead === 0) {
            break;
        }
        const byte = buffer[0];
        if (byte === 10) {
            break;
        }
        if (byte !== 13) {
            chunks.push(byte);
        }
    }
    return Buffer.from(chunks).toString("utf8").trim();
}
function promptWithDefault(label, defaultValue) {
    const value = readLineFromTty(`${label} [${defaultValue}]: `);
    return value || defaultValue;
}
function promptRequired(label) {
    while (true) {
        const value = readLineFromTty(`${label}: `);
        if (value) {
            return value;
        }
        console.log(`${label} 不能为空，请重新输入。`);
    }
}
function promptNumber(label, defaultValue, validator) {
    while (true) {
        const raw = promptWithDefault(label, String(defaultValue));
        const parsed = Number(raw);
        if (Number.isInteger(parsed) && (!validator || validator(parsed))) {
            return parsed;
        }
        console.log(`${label} 必须是有效整数，请重新输入。`);
    }
}
function createConfigInteractively(filePath) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        failAndExit(`配置文件不存在: ${filePath}\n请在交互终端中运行，或手动创建该文件（可参考 config.example.json）。`);
    }
    console.log(`未找到配置文件，将通过交互创建: ${filePath}`);
    const feishuAppId = promptRequired("feishuAppId");
    const feishuAppSecret = promptRequired("feishuAppSecret");
    const allowedOpenIdRaw = readLineFromTty("allowedOpenId（逗号分隔，可留空）: ");
    const opencodeModel = readLineFromTty("opencodeModel（可留空）: ");
    const opencodeTimeout = promptNumber("opencodeTimeout（毫秒）", 300000, (value) => value > 0);
    const opencodeWorkdir = promptWithDefault("opencodeWorkdir", (0, node_path_1.join)((0, node_os_1.homedir)(), "OpenCode"));
    const opencodeServeHost = promptWithDefault("opencodeServeHost", "127.0.0.1");
    const opencodeServePort = promptNumber("opencodeServePort", 4096, (value) => value >= 1 && value <= 65535);
    const allowedOpenId = allowedOpenIdRaw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    const configObject = {
        feishuAppId,
        feishuAppSecret,
        allowedOpenId,
        opencodeTimeout,
        opencodeWorkdir,
        opencodeServeHost,
        opencodeServePort
    };
    if (opencodeModel) {
        configObject.opencodeModel = opencodeModel;
    }
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(filePath), { recursive: true });
    (0, node_fs_1.writeFileSync)(filePath, `${JSON.stringify(configObject, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    console.log(`配置文件已创建: ${filePath}`);
    return configObject;
}
const schema = zod_1.z.object({
    feishuAppId: zod_1.z.string().min(1),
    feishuAppSecret: zod_1.z.string().min(1),
    allowedOpenId: zod_1.z.union([zod_1.z.string(), zod_1.z.array(zod_1.z.string())]).optional(),
    opencodeModel: zod_1.z.string().optional(),
    opencodeTimeout: zod_1.z.coerce.number().int().positive().default(300000),
    opencodeWorkdir: zod_1.z.preprocess((value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value), zod_1.z.string().trim().min(1).default((0, node_path_1.join)((0, node_os_1.homedir)(), "OpenCode"))),
    opencodeServeHost: zod_1.z.string().min(1).default("127.0.0.1"),
    opencodeServePort: zod_1.z.coerce.number().int().min(1).max(65535).default(4096)
});
const parsed = schema.safeParse(loadConfigFile(CONFIG_FILE_PATH));
if (!parsed.success) {
    console.error(`配置文件校验失败: ${CONFIG_FILE_PATH}`);
    for (const issue of parsed.error.issues) {
        console.error(`- ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
}
const opencodeWorkdir = parsed.data.opencodeWorkdir;
try {
    if (!(0, node_fs_1.statSync)(opencodeWorkdir).isDirectory()) {
        console.error(`配置文件校验失败:\n- opencodeWorkdir: 不是目录 (${opencodeWorkdir})`);
        process.exit(1);
    }
}
catch {
    console.error(`配置文件校验失败:\n- opencodeWorkdir: 目录不存在或不可访问 (${opencodeWorkdir})`);
    process.exit(1);
}
const allowedOpenIdValues = Array.isArray(parsed.data.allowedOpenId)
    ? parsed.data.allowedOpenId
    : (parsed.data.allowedOpenId ?? "").split(",");
const allowedOpenIds = new Set(allowedOpenIdValues
    .map((item) => item.trim())
    .filter(Boolean));
if (allowedOpenIds.size === 0) {
    console.warn("[config]: allowedOpenId 为空，当前允许所有 open_id 接入。请注意安全风险。");
}
const opencodeTimeoutMs = parsed.data.opencodeTimeout;
exports.config = {
    appId: parsed.data.feishuAppId,
    appSecret: parsed.data.feishuAppSecret,
    allowedOpenIds,
    opencodeModel: parsed.data.opencodeModel?.trim() || undefined,
    opencodeTimeoutMs,
    opencodeWorkdir,
    opencodeServeHost: parsed.data.opencodeServeHost,
    opencodeServePort: parsed.data.opencodeServePort
};
