"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Markdown 表格 → 飞书卡片原生「表格」组件。
 *
 * 背景：OpenCode 的回答里常带 GFM 表格（`| a | b |` + `| --- | --- |`）。飞书富文本
 * post 的 md 标签虽然声称支持 GFM 表格，但表格必须前后留空行，且不少客户端版本
 * 只把它当普通文本渲染（整段竖线原文，读起来很痛苦）。改成卡片 2.0 的原生 table
 * 组件后：有真正的表头、列宽、单元格换行/省略可点开查看，长表格自动分页。
 *
 * 非表格部分仍然交给卡片的 markdown 组件（2.0 的 markdown 支持标题/列表/代码块/
 * 引用等完整 CommonMark 子集），观感与原来的 post md 基本一致。
 */
/** 表格列数上限：超过就不当表格处理（退回 markdown 原文） */
const TABLE_MAX_COLUMNS = 20;
/** 单表最多解析多少行（卡片表格本身分页展示，这里防极端大表） */
const TABLE_MAX_ROWS = 500;
/** 单元格文本上限（超出截断，避免整张卡片撑爆 30KB） */
const CELL_MAX_CHARS = 600;
/** 卡片 2.0 元素上限 200，留些余量 */
const CARD_MAX_ELEMENTS = 180;
/** 卡片消息 content 上限 30KB，留些余量 */
const CARD_MAX_BYTES = 29000;

/** 去掉行首/行尾的分隔竖线（保留 \\| 转义） */
function stripOuterPipes(line) {
    let text = String(line).trim();
    if (text.startsWith("|")) {
        text = text.slice(1);
    }
    if (text.endsWith("|") && !text.endsWith("\\|")) {
        text = text.slice(0, -1);
    }
    return text;
}
/** 按未转义的 | 切分一行；\\| 还原为字面量 | */
function splitTableRow(line) {
    const body = stripOuterPipes(line);
    const cells = [];
    let buffer = "";
    for (let i = 0; i < body.length; i += 1) {
        const ch = body[i];
        if (ch === "\\" && body[i + 1] === "|") {
            buffer += "|";
            i += 1;
            continue;
        }
        if (ch === "|") {
            cells.push(buffer);
            buffer = "";
            continue;
        }
        buffer += ch;
    }
    cells.push(buffer);
    return cells.map((cell) => cell.trim());
}
/** GFM 分隔行：只由 -、:、| 和空白组成，且至少一个 - */
function isSeparatorRow(line) {
    const text = String(line).trim();
    if (!text.includes("-")) {
        return false;
    }
    return /^[\s:|-]+$/.test(text);
}
function isFenceLine(line) {
    return /^\s*(```|~~~)/.test(String(line));
}
/** 单元格值：折行压平、截断、去掉会破坏 lark_md 的裸换行 */
function normalizeCell(value) {
    let text = String(value == null ? "" : value).replace(/\s*\r?\n\s*/g, " ").trim();
    if (text.length > CELL_MAX_CHARS) {
        text = text.slice(0, CELL_MAX_CHARS - 1) + "…";
    }
    return text;
}
/**
 * 把一段 Markdown 切成 [{ type: "md", text }] 与 [{ type: "table", header, rows }] 序列。
 * 代码围栏内的内容一律当作 md（不识别表格）。
 */
function parseMarkdownSegments(text) {
    const lines = String(text == null ? "" : text).split("\n");
    const segments = [];
    let buffer = [];
    let inFence = null;
    const flush = () => {
        if (buffer.length > 0) {
            segments.push({ type: "md", text: buffer.join("\n") });
            buffer = [];
        }
    };
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const fence = /^\s*(```+|~~~+)/.exec(line);
        if (fence) {
            if (inFence && line.trim().startsWith(inFence)) {
                inFence = null;
            }
            else if (!inFence) {
                inFence = fence[1].slice(0, 3);
            }
            buffer.push(line);
            continue;
        }
        if (!inFence && line.includes("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
            const header = splitTableRow(line);
            const separator = splitTableRow(lines[i + 1]);
            if (header.length >= 1 && header.length === separator.length && header.length <= TABLE_MAX_COLUMNS) {
                const rows = [];
                let j = i + 2;
                while (j < lines.length && rows.length < TABLE_MAX_ROWS) {
                    const candidate = lines[j];
                    if (candidate.trim() === "" || !candidate.includes("|") || isFenceLine(candidate)) {
                        break;
                    }
                    rows.push(splitTableRow(candidate));
                    j += 1;
                }
                if (rows.length > 0) {
                    flush();
                    segments.push({ type: "table", header, rows });
                    i = j - 1;
                    continue;
                }
            }
        }
        buffer.push(line);
    }
    flush();
    return segments;
}
/** 文本里是否存在可渲染的 GFM 表格 */
function hasMarkdownTable(text) {
    return parseMarkdownSegments(text).some((segment) => segment.type === "table");
}
/** 表格 → 卡片 2.0 的 table 组件 */
function buildTableElement(table) {
    const width = table.header.length;
    const columns = table.header.map((title, index) => ({
        name: "c" + String(index),
        display_name: normalizeCell(title) || " ",
        data_type: "lark_md",
        width: "auto",
        horizontal_align: "left",
        vertical_align: "top"
    }));
    const rows = table.rows.map((cells) => {
        const row = {};
        for (let index = 0; index < width; index += 1) {
            row["c" + String(index)] = normalizeCell(cells[index]);
        }
        return row;
    });
    return {
        tag: "table",
        page_size: Math.min(Math.max(rows.length, 1), 10),
        row_height: "auto",
        row_max_height: "320px",
        header_style: {
            text_align: "left",
            text_size: "normal",
            background_style: "grey",
            bold: true,
            lines: 1
        },
        columns,
        rows
    };
}
/**
 * 构建表格卡片。
 * mode = "table"    ：表格用原生 table 组件，其余段落用卡片 markdown（推荐）
 * mode = "markdown" ：整段塞进一个卡片 markdown 组件（由卡片自己渲染 GFM 表格）
 */
function buildTableCard(text, options) {
    const opts = options || {};
    const mode = opts.mode === "markdown" ? "markdown" : "table";
    const source = String(text == null ? "" : text);
    const elements = [];
    if (mode === "markdown") {
        elements.push({ tag: "markdown", content: source });
    }
    else {
        const segments = parseMarkdownSegments(source);
        for (const segment of segments) {
            if (elements.length >= CARD_MAX_ELEMENTS) {
                break;
            }
            if (segment.type === "table") {
                elements.push(buildTableElement(segment));
                continue;
            }
            const content = segment.text.replace(/\n{3,}/g, "\n\n").trim();
            if (content) {
                elements.push({ tag: "markdown", content });
            }
        }
        if (elements.length === 0) {
            elements.push({ tag: "markdown", content: source });
        }
    }
    const card = { schema: "2.0", config: { update_multi: true }, body: { elements } };
    if (opts.header) {
        card.header = {
            title: { tag: "plain_text", content: String(opts.header) },
            template: opts.template || "blue"
        };
    }
    return card;
}
/** 卡片是否在飞书 30KB 限制内 */
function isCardWithinLimit(card) {
    return Buffer.byteLength(JSON.stringify(card), "utf8") <= CARD_MAX_BYTES;
}
exports.TABLE_MAX_COLUMNS = TABLE_MAX_COLUMNS;
exports.CARD_MAX_BYTES = CARD_MAX_BYTES;
exports.splitTableRow = splitTableRow;
exports.isSeparatorRow = isSeparatorRow;
exports.normalizeCell = normalizeCell;
exports.parseMarkdownSegments = parseMarkdownSegments;
exports.hasMarkdownTable = hasMarkdownTable;
exports.buildTableElement = buildTableElement;
exports.buildTableCard = buildTableCard;
exports.isCardWithinLimit = isCardWithinLimit;
