"use strict";
/**
 * table-card.js 回归测试（无依赖，直接 node 运行）：node scripts/test-table-card.js
 * 覆盖 GFM 表格解析、转义竖线、代码围栏排除、误判防护、单元格补齐与卡片结构。
 */
const path = require("node:path");
const tc = require(path.join(__dirname, "..", "dist", "table-card.js"));

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

// 1. 基本表格：前后文字各自成段
const t1 = "看到结论：\n\n| 层 | 位置 | 行为 |\n|---|---|---|\n| 物理键盘 | \`lib.rs:208\` | 同步回调 |\n| 入队 | \`controller.rs:1311\` | 非阻塞 |\n\n后面还有话。";
const s1 = tc.parseMarkdownSegments(t1);
ok("三段：md/table/md", s1.map((s) => s.type).join(">") === "md>table>md", s1.map((s) => s.type).join(">"));
ok("表头解析", JSON.stringify(s1[1].header) === JSON.stringify(["层", "位置", "行为"]));
ok("行解析", s1[1].rows.length === 2 && s1[1].rows[0][0] === "物理键盘");
ok("表格后的文字保留", s1[2].text.trim() === "后面还有话。");

// 2. 转义竖线
const t2 = "| # | 检查项 |\n|---|---|\n| 1 | \`ps aux \\| grep hbbr\` |";
const s2 = tc.parseMarkdownSegments(t2);
ok("转义竖线不切列", s2[0].rows[0][1] === "\`ps aux | grep hbbr\`", JSON.stringify(s2[0].rows[0][1]));

// 3. 代码围栏内不识别表格
const t3 = "\`\`\`\n| a | b |\n|---|---|\n| 1 | 2 |\n\`\`\`\n";
ok("围栏内不算表格", !tc.hasMarkdownTable(t3));

// 4. 误判防护
ok("普通竖线不误判", !tc.hasMarkdownTable("按 Esc | 中断任务\n------\n结束"));
ok("无表头竖线的普通文本", !tc.hasMarkdownTable("hello\n\nworld"));
ok("空文本", !tc.hasMarkdownTable(""));

// 5. 无外框竖线 / 对齐分隔行 / 空表头
ok("无外框竖线也是表格", tc.hasMarkdownTable("用 A | B 表示\n|---|---|\n| 1 | 2 |"));
const t6 = "| | 上游 | 我们 |\n|:---|---:|---:|\n| 卡死上限 | 12s | 30s |";
const s6 = tc.parseMarkdownSegments(t6);
ok("对齐分隔行可用且空表头保留", s6[0].type === "table" && s6[0].header[0] === "");

// 6. 多个表格
const t7 = "| a | b |\n|---|---|\n| 1 | 2 |\n\n中间文字\n\n| c | d |\n|---|---|\n| 3 | 4 |";
ok("可解析多个表格", tc.parseMarkdownSegments(t7).filter((s) => s.type === "table").length === 2);

// 7. 单元格数不齐 → 构建时补齐/截断
const t8 = "| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |";
const el8 = tc.buildTableElement(tc.parseMarkdownSegments(t8)[0]);
ok("缺列补齐为空串", Object.keys(el8.rows[0]).length === 3 && el8.rows[0].c1 === "" && el8.rows[0].c2 === "");
ok("多列被截断", Object.keys(el8.rows[1]).length === 3);

// 8. 卡片结构
const card = tc.buildTableCard(t1);
ok("卡片 schema 2.0 + update_multi", card.schema === "2.0" && card.config.update_multi === true);
ok("卡片元素 md/table/md", card.body.elements.map((e) => e.tag).join(">") === "markdown>table>markdown");
ok("table 组件字段", card.body.elements[1].columns[1].data_type === "lark_md"
    && card.body.elements[1].header_style.background_style === "grey"
    && card.body.elements[1].row_height === "auto");
ok("page_size 在 [1,10]", card.body.elements[1].page_size === 2);
ok("卡片在 30KB 内", tc.isCardWithinLimit(card));
ok("markdown 模式只有一个元素", tc.buildTableCard(t1, { mode: "markdown" }).body.elements.length === 1);

// 9. 超宽表格不当表格处理（退回 markdown 原文）
const wide = "| " + Array.from({ length: 25 }, (_, i) => "c" + i).join(" | ") + " |\n|" + "---|".repeat(25) + "\n| " + Array.from({ length: 25 }, (_, i) => "v" + i).join(" | ") + " |";
ok("超 20 列退回 markdown", !tc.hasMarkdownTable(wide));

console.log("\nPASS " + pass + " FAIL " + fail);
process.exit(fail ? 1 : 0);
