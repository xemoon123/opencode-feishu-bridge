"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isWindowsPlatform = isWindowsPlatform;
exports.resolveOpenCodeCommand = resolveOpenCodeCommand;
exports.resolveShimTarget = resolveShimTarget;
exports.dirnameFor = dirnameFor;
exports.buildCmdLine = buildCmdLine;
exports.quoteForCmd = quoteForCmd;
exports.quoteShellArg = quoteShellArg;
exports.spawnOpenCode = spawnOpenCode;
exports.terminateChild = terminateChild;
exports.killProcessTreeWindows = killProcessTreeWindows;
exports.resetOpenCodeCommandCache = resetOpenCodeCommandCache;
/**
 * opencode CLI 的启动/终止抽象层（跨平台）。
 *
 * 背景：Windows 上 `npm i -g opencode-ai` 只会暴露 npm 生成的 `opencode.cmd` / `opencode.ps1`
 * 垫片，而 Node 的 spawn 在 Windows 下走 CreateProcess：不带扩展名时只会补 `.exe`，
 * 找不到 `.cmd`；显式传 `.cmd` 则从 Node 18.20.2 / 20.12 / 21.7 的安全修复起直接 EINVAL。
 * 因此这里按优先级解析：OPENCODE_BIN 覆盖 → 真 .exe → 解析 .cmd 垫片里的真实目标 →
 * 兜底用 `cmd.exe /d /s /c` 拉起垫片。
 *
 * 终止进程同样有平台差异：POSIX 用 SIGTERM/SIGKILL，Windows 没有信号语义，
 * 且经 cmd.exe 拉起时子进程是 cmd 的孩子，直接 kill 父进程会留下孤儿 serve 占用端口，
 * 所以 Windows 一律用 `taskkill /PID <pid> /T /F` 结束整棵进程树。
 */
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const OPENCODE_BIN_ENV = "OPENCODE_BIN";
/** 默认命令名（非 Windows 直接交给 PATH） */
const DEFAULT_COMMAND = "opencode";
function isWindowsPlatform(platform) {
    return (platform === undefined || platform === null ? process.platform : platform) === "win32";
}
/** 解析结果缓存：桥运行期间不会变，避免每次 spawn 都执行 where.exe */
let cachedCommand = null;
let cachedPlatform = null;
function resetOpenCodeCommandCache() {
    cachedCommand = null;
    cachedPlatform = null;
}
/** where.exe / which 查找，返回全部命中路径 */
function defaultWhich(name, platform) {
    const tool = isWindowsPlatform(platform) ? "where.exe" : "which";
    try {
        const result = (0, node_child_process_1.spawnSync)(tool, [name], { encoding: "utf8", windowsHide: true });
        if (result.status !== 0 || !result.stdout) {
            return [];
        }
        return String(result.stdout)
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
    }
    catch (error) {
        return [];
    }
}
/** 取目录：兼容在 POSIX 上分析 Windows 路径（单测场景），Windows 路径走 win32 语义 */
function dirnameFor(file) {
    return /^[A-Za-z]:[\\/]/.test(String(file)) ? node_path_1.win32.dirname(String(file)) : node_path_1.dirname(String(file));
}
/**
 * 从 npm 生成的 .cmd 垫片里解析真实可执行文件。
 * cmd-shim 生成的垫片形如： "%dp0%\node_modules\opencode-ai\bin\opencode.exe" %*
 */
function resolveShimTarget(shimPath, deps) {
    const readFile = deps && deps.readFile ? deps.readFile : (file) => (0, node_fs_1.readFileSync)(file, "utf8");
    const exists = deps && deps.exists ? deps.exists : (file) => (0, node_fs_1.existsSync)(file);
    let text;
    try {
        text = readFile(shimPath, "utf8");
    }
    catch (error) {
        return undefined;
    }
    const dir = dirnameFor(shimPath);
    const matches = String(text).match(/"[^"\r\n]*\.(?:exe|cmd|bat)"/gi) || [];
    for (const raw of matches) {
        const expanded = raw.slice(1, -1)
            .replace(/%dp0%/gi, dir)
            .replace(/%~dp0/gi, dir + "\\")
            .replace(/%DIR%/gi, dir);
        if (/\.(exe|cmd|bat)$/i.test(expanded) && exists(expanded)) {
            return expanded;
        }
    }
    return undefined;
}
/**
 * 解析如何启动 opencode。
 * 返回 { command, useCmdShell, kind, source }
 *   kind: override | path | exe | exe-shim | cmd-shim | cmd-shell
 */
function resolveOpenCodeCommand(options) {
    const opts = options || {};
    const platform = opts.platform === undefined ? process.platform : opts.platform;
    const env = opts.env || process.env;
    const override = String(env[OPENCODE_BIN_ENV] || "").trim();
    if (override) {
        return {
            command: override,
            useCmdShell: isWindowsPlatform(platform) && /\.(cmd|bat)$/i.test(override),
            kind: "override",
            source: OPENCODE_BIN_ENV
        };
    }
    if (!isWindowsPlatform(platform)) {
        return { command: DEFAULT_COMMAND, useCmdShell: false, kind: "path", source: "PATH" };
    }
    const which = opts.which || ((name) => defaultWhich(name, platform));
    const found = which(DEFAULT_COMMAND) || [];
    const exe = found.find((item) => /\.exe$/i.test(item));
    if (exe) {
        return { command: exe, useCmdShell: false, kind: "exe", source: exe };
    }
    const shim = found.find((item) => /\.(cmd|bat)$/i.test(item));
    if (shim) {
        const target = resolveShimTarget(shim, { readFile: opts.readFile, exists: opts.exists });
        if (target && /\.exe$/i.test(target)) {
            return { command: target, useCmdShell: false, kind: "exe-shim", source: shim + " -> " + target };
        }
        return { command: shim, useCmdShell: true, kind: "cmd-shim", source: shim };
    }
    return { command: DEFAULT_COMMAND, useCmdShell: true, kind: "cmd-shell", source: "fallback" };
}
/** 带缓存的解析（spawnOpenCode 默认使用） */
function resolveOpenCodeCommandCached(options) {
    const opts = options || {};
    const platform = opts.platform === undefined ? process.platform : opts.platform;
    if (cachedCommand && cachedPlatform === platform) {
        return cachedCommand;
    }
    cachedCommand = resolveOpenCodeCommand(opts);
    cachedPlatform = platform;
    return cachedCommand;
}
/** cmd.exe 参数引用：无特殊字符时原样，否则双引号包裹 */
function quoteForCmd(value) {
    const text = String(value);
    if (text.length > 0 && !/[\s"&|<>^()]/.test(text)) {
        return text;
    }
    return '"' + text.split('"').join('""') + '"';
}
/**
 * 组装 cmd.exe 的命令行。`cmd /s /c` 会剥掉最外层引号，
 * 所以整体再包一层，避免含空格的可执行文件路径被截断。
 */
function buildCmdLine(command, args) {
    const parts = [command].concat(args || []).map(quoteForCmd);
    return '"' + parts.join(" ") + '"';
}
/** 按平台生成 shell 引用（POSIX 单引号 / Windows 双引号），用于 /status 里给出的命令 */
function quoteShellArg(value, platform) {
    const text = String(value);
    if (isWindowsPlatform(platform)) {
        return quoteForCmd(text);
    }
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) {
        return text;
    }
    const Q = String.fromCharCode(39);
    return Q + text.split(Q).join(Q + '"' + Q + '"' + Q) + Q;
}
/**
 * 启动 opencode 进程，屏蔽平台差异。
 * 返回 { child, plan }；调用方拿到 child 后照常接 stdout/stderr/close。
 */
function spawnOpenCode(args, options) {
    const opts = options || {};
    const platform = opts.platform === undefined ? process.platform : opts.platform;
    const env = opts.env || process.env;
    const plan = opts.plan || resolveOpenCodeCommandCached({ platform: platform, env: env, which: opts.which, readFile: opts.readFile, exists: opts.exists });
    const spawnOptions = {
        cwd: opts.cwd,
        env: env,
        stdio: opts.stdio === undefined ? "pipe" : opts.stdio,
        windowsHide: opts.windowsHide === undefined ? true : opts.windowsHide
    };
    if (plan.useCmdShell) {
        const comspec = String(env.ComSpec || env.COMSPEC || "cmd.exe");
        const line = buildCmdLine(plan.command, args);
        const child = (0, node_child_process_1.spawn)(comspec, ["/d", "/s", "/c", line], Object.assign({}, spawnOptions, { windowsVerbatimArguments: true }));
        return { child: child, plan: plan };
    }
    const child = (0, node_child_process_1.spawn)(plan.command, args, spawnOptions);
    return { child: child, plan: plan };
}
/** Windows：结束整棵进程树（cmd 垫片场景必需） */
function killProcessTreeWindows(pid) {
    if (!pid) {
        return false;
    }
    try {
        const result = (0, node_child_process_1.spawnSync)("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        return result.status === 0;
    }
    catch (error) {
        return false;
    }
}
/**
 * 结束 opencode 子进程。
 * POSIX：SIGTERM → 宽限期后 SIGKILL。
 * Windows：taskkill /T /F（无优雅信号可用），等 close 或宽限期后返回。
 */
async function terminateChild(child, options) {
    const opts = options || {};
    if (!child || child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    const platform = opts.platform === undefined ? process.platform : opts.platform;
    const graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : 5000;
    await new Promise((resolve) => {
        let settled = false;
        let forceTimer = null;
        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            if (forceTimer) {
                clearTimeout(forceTimer);
            }
            resolve();
        };
        child.once("close", finish);
        if (isWindowsPlatform(platform)) {
            killProcessTreeWindows(child.pid);
            forceTimer = setTimeout(finish, graceMs);
            return;
        }
        forceTimer = setTimeout(() => {
            try {
                child.kill("SIGKILL");
            }
            catch (error) {
                // 进程可能已退出
            }
            setTimeout(finish, 300);
        }, graceMs);
        try {
            child.kill("SIGTERM");
        }
        catch (error) {
            try {
                child.kill("SIGKILL");
            }
            catch (innerError) {
                finish();
            }
        }
    });
}
