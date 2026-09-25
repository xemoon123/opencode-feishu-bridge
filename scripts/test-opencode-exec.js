"use strict";
/**
 * opencode-exec 回归测试（无需 Windows 机器，注入 platform/where/readFile/exists 模拟）：
 *   node scripts/test-opencode-exec.js
 */
const path = require("node:path");
const exec = require(path.join(__dirname, "..", "dist", "opencode-exec.js"));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
    if (cond) {
        pass += 1;
        console.log("  ok   " + name);
    }
    else {
        fail += 1;
        console.log("  FAIL " + name + (extra !== undefined ? " :: " + String(extra).slice(0, 300) : ""));
    }
}

// Windows 路径统一用正斜杠书写，Windows API 均接受，便于在 POSIX 上跑单测
const NPM_DIR = "C:/Users/me/AppData/Roaming/npm";
const SHIM = NPM_DIR + "/opencode.cmd";
const REAL_EXE = NPM_DIR + "/node_modules/opencode-ai/bin/opencode.exe";
const SHIM_TEXT = [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%dp0%/node_modules/opencode-ai/bin/opencode.exe" %*',
    "",
].join("\r\n");

// 1. 非 Windows：直接交给 PATH
const posix = exec.resolveOpenCodeCommand({ platform: "darwin", env: {} });
ok("POSIX 直接用 opencode", posix.command === "opencode" && posix.useCmdShell === false && posix.kind === "path", JSON.stringify(posix));

// 2. OPENCODE_BIN 覆盖
const ovPosix = exec.resolveOpenCodeCommand({ platform: "linux", env: { OPENCODE_BIN: "/opt/oc/bin/opencode" } });
ok("POSIX: OPENCODE_BIN 覆盖", ovPosix.command === "/opt/oc/bin/opencode" && ovPosix.useCmdShell === false && ovPosix.kind === "override", JSON.stringify(ovPosix));
const ovExe = exec.resolveOpenCodeCommand({ platform: "win32", env: { OPENCODE_BIN: "C:/tools/opencode.exe" } });
ok("Windows: OPENCODE_BIN 指向 exe 时直启", ovExe.command === "C:/tools/opencode.exe" && ovExe.useCmdShell === false, JSON.stringify(ovExe));
const ovCmd = exec.resolveOpenCodeCommand({ platform: "win32", env: { OPENCODE_BIN: "C:/tools/opencode.cmd" } });
ok("Windows: OPENCODE_BIN 指向 .cmd 时走 cmd.exe", ovCmd.useCmdShell === true, JSON.stringify(ovCmd));

// 3. Windows 能找到真正的 exe → 直启
const winExe = exec.resolveOpenCodeCommand({ platform: "win32", env: {}, which: () => [NPM_DIR + "/opencode.exe"] });
ok("Windows 找到 opencode.exe → 直启", winExe.command === NPM_DIR + "/opencode.exe" && winExe.useCmdShell === false && winExe.kind === "exe", JSON.stringify(winExe));

// 4. Windows 只有 .cmd 垫片，能解析出真实 exe → 直启（避免 cmd.exe 中间层与孤儿进程）
const winShim = exec.resolveOpenCodeCommand({
    platform: "win32",
    env: {},
    which: () => [SHIM],
    readFile: (file) => {
        if (file === SHIM) {
            return SHIM_TEXT;
        }
        throw new Error("ENOENT");
    },
    exists: (file) => file === REAL_EXE,
});
ok("Windows 解析 .cmd 垫片 → 真实 exe", winShim.command === REAL_EXE && winShim.useCmdShell === false && winShim.kind === "exe-shim", JSON.stringify(winShim));

// 5. 垫片目标不存在 → 退化为 cmd.exe 拉起垫片
const winFallback = exec.resolveOpenCodeCommand({ platform: "win32", env: {}, which: () => [SHIM], readFile: () => SHIM_TEXT, exists: () => false });
ok("Windows 垫片解析失败 → cmd.exe 兜底", winFallback.command === SHIM && winFallback.useCmdShell === true && winFallback.kind === "cmd-shim", JSON.stringify(winFallback));

// 6. 什么都没找到 → 仍然尝试用 cmd.exe 解析 PATH
const winNone = exec.resolveOpenCodeCommand({ platform: "win32", env: {}, which: () => [] });
ok("Windows 未找到 → cmd.exe 兜底", winNone.command === "opencode" && winNone.useCmdShell === true && winNone.kind === "cmd-shell", JSON.stringify(winNone));

// 7. 非 Windows 平台不看 where.exe
const noWhere = exec.resolveOpenCodeCommand({ platform: "darwin", env: {}, which: () => { throw new Error("不该在 POSIX 上调用 where"); } });
ok("POSIX 不调用 where", noWhere.kind === "path");

// 8. shell 引用
ok("POSIX 无特殊字符不加引号", exec.quoteShellArg("/Users/me/Code/xRustDesk", "darwin") === "/Users/me/Code/xRustDesk");
ok("POSIX 含空格用单引号", exec.quoteShellArg("/Users/me/My Code", "darwin") === "'/Users/me/My Code'");
ok("Windows 含空格用双引号", exec.quoteShellArg("C:/My Code/x", "win32") === '"C:/My Code/x"');
ok("Windows 无特殊字符不加引号", exec.quoteShellArg("C:/tmp/x", "win32") === "C:/tmp/x");
ok("cmd 转义 &", exec.quoteForCmd("a&b") === '"a&b"');
ok("cmd 转义内嵌引号", exec.quoteForCmd('a"b') === '"a""b"');

// 9. cmd 命令行整体再包一层（cmd /s /c 会剥掉最外层引号）
const line = exec.buildCmdLine("C:/Program Files/npm/opencode.cmd", ["serve", "--port", "4096"]);
ok("cmd 命令行外层包裹", line.startsWith('""') && line.endsWith('"') && line.includes("--port 4096"), line);

// 10. 目录解析（跨平台分析 Windows 路径）
ok("dirnameFor Windows 路径", exec.dirnameFor(SHIM) === NPM_DIR, exec.dirnameFor(SHIM));
ok("dirnameFor POSIX 路径", exec.dirnameFor("/usr/local/bin/opencode") === "/usr/local/bin");
ok("dirnameFor Windows 反斜杠路径", exec.dirnameFor("C:\\a\\b\\opencode.cmd") === "C:\\a\\b", exec.dirnameFor("C:\\a\\b\\opencode.cmd"));

// 11. 缓存可重置（避免测试间串味）
exec.resetOpenCodeCommandCache();
ok("resetOpenCodeCommandCache 可调用", true);

console.log("\nPASS " + pass + " FAIL " + fail);
process.exit(fail ? 1 : 0);
