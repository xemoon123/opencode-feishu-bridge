"use strict";
/**
 * const 重赋值静态检查的回归测试：node scripts/test-const-reassign.js
 * 既确认检查器能抓到「跨作用域 const 重赋值」，也确认它不误报形参遮蔽 / 属性赋值 / === / += 等合法写法。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CHECKER = path.join(__dirname, "check-const-reassign.js");
const DIST = path.join(__dirname, "..", "dist");

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
function runChecker(targets) {
    return spawnSync(process.execPath, [CHECKER].concat(targets), { encoding: "utf8" });
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofbs-const-"));
function fixture(name, lines) {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, lines.join("\n") + "\n");
    return p;
}

// 1. 模块级 const 在嵌套函数里被整体赋值 → 必须报错（这正是当初 pendingProbeCache 的病）
const bad = fixture("bad.js", [
    "const cache = { a: 1 };",
    "async function f() { if (x) { cache = { a: 2 }; } }",
]);
const badRun = runChecker([bad]);
ok("跨作用域 const 重赋值被抓到", badRun.status === 1 && badRun.stderr.indexOf("cache") !== -1, badRun.stderr);

// 2. 形参遮蔽 / 箭头形参遮蔽 → 不应误报
const shadow = fixture("shadow.js", [
    "const cfg = { a: 1 };",
    "function g(cfg) { cfg = { a: 2 }; return cfg; }",
    "const arrow = (cfg) => { cfg = 3; return cfg; };",
]);
const shadowRun = runChecker([shadow]);
ok("形参遮蔽不误报", shadowRun.status === 0, shadowRun.stderr);

// 3. 属性赋值 / 严格相等 / 复合赋值 / 同名 let 遮蔽 → 不应误报
const lookalike = fixture("lookalike.js", [
    "const obj = { a: 1 };",
    "function k() { obj.a = 2; }",
    "const cmp = 1;",
    "function l() { if (cmp === 2) { return cmp; } }",
    "const sum = 1;",
    "function m() { let sum = 0; sum += 1; return sum; }",
]);
const lookalikeRun = runChecker([lookalike]);
ok("属性赋值/===/复合赋值/let 遮蔽不误报", lookalikeRun.status === 0, lookalikeRun.stderr);

// 4. 真实 dist（按目录传入，顺带覆盖目录展开）→ 必须干净
const distRun = runChecker([DIST]);
ok("dist/ 无 const 重赋值", distRun.status === 0, distRun.stderr);
ok("目录参数被展开（输出含跳过计数）", distRun.stdout.indexOf("跳过") !== -1, distRun.stdout);

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("\nPASS " + pass + " FAIL " + fail);
process.exit(fail ? 1 : 0);
