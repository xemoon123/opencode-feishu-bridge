"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildQuestionCard = buildQuestionCard;
exports.buildPermissionCard = buildPermissionCard;
exports.parseTextQuestionAnswer = parseTextQuestionAnswer;
exports.parseTextPermissionAnswer = parseTextPermissionAnswer;
/**
 * 任务内交互的纯函数：卡片构建与文本回答解析。
 * 不依赖飞书 client，便于单元测试。
 */
/**
 * 把 OpenCode 的 question 请求渲染成飞书交互卡片（选项按钮 + 提示文本）。
 */
function buildQuestionCard(questions) {
    const elements = [];
    const lines = [];
    questions.forEach((question, qIndex) => {
        const header = question.header?.trim() || `问题 ${qIndex + 1}`;
        const body = question.question?.trim() || "";
        const options = Array.isArray(question.options) ? question.options : [];
        const multi = question.multiple === true;
        const custom = question.custom !== false;
        lines.push(`**${qIndex + 1}. ${header}**`);
        if (body && body !== header) {
            lines.push(body);
        }
        if (options.length > 0) {
            lines.push(multi ? "（可多选，回复时用逗号分隔）" : "（可回复编号或选项文字，也可直接输入自定义内容）");
        }
        else if (custom) {
            lines.push("（可直接输入内容回答）");
        }
        lines.push("");
        if (options.length > 0) {
            const actions = [];
            options.forEach((option, oIndex) => {
                if (actions.length >= 5) {
                    return;
                }
                actions.push({
                    tag: "button",
                    text: { tag: "plain_text", content: option.label?.slice(0, 20) || `选项 ${oIndex + 1}` },
                    type: oIndex === 0 ? "primary" : "default",
                    value: { kind: "question", q: qIndex, o: oIndex }
                });
            });
            elements.push({
                tag: "div",
                text: {
                    tag: "lark_md",
                    content: options
                        .map((option, oIndex) => `${oIndex + 1}. ${option.label ?? ""}${option.description ? ` — ${option.description}` : ""}`)
                        .join("\n")
                }
            });
            if (actions.length > 0) {
                elements.push({ tag: "action", actions });
            }
        }
    });
    elements.unshift({
        tag: "div",
        text: {
            tag: "lark_md",
            content: lines.join("\n").trim() || "OpenCode 需要你的输入。"
        }
    });
    elements.push({
        tag: "note",
        elements: [{ tag: "plain_text", content: "直接回复消息即可回答（多条问题按 1.xxx；2.xxx 分行或分号分隔）" }]
    });
    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: "plain_text", content: "🤖 OpenCode 需要你的选择/输入" },
            template: "blue"
        },
        elements
    };
}
/**
 * 把 OpenCode 的 permission 请求渲染成飞书授权卡片。
 */
function buildPermissionCard(ask) {
    const permissionLabel = ask.permission || "unknown";
    const patternText = Array.isArray(ask.patterns) ? ask.patterns.join(", ") : "";
    const actions = [
        {
            tag: "button",
            text: { tag: "plain_text", content: "✅ 允许一次" },
            type: "primary",
            value: { kind: "permission", reply: "once" }
        },
        {
            tag: "button",
            text: { tag: "plain_text", content: "♾️ 始终允许" },
            type: "default",
            value: { kind: "permission", reply: "always" }
        },
        {
            tag: "button",
            text: { tag: "plain_text", content: "🚫 拒绝" },
            type: "danger",
            value: { kind: "permission", reply: "reject" }
        }
    ];
    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: "plain_text", content: "🔐 OpenCode 请求授权" },
            template: "orange"
        },
        elements: [
            {
                tag: "div",
                text: {
                    tag: "lark_md",
                    content: `工具 **${permissionLabel}**${patternText ? `\n命令/路径：\`${patternText}\`` : ""}\n\n允许后任务继续执行；拒绝会把这个结果反馈给模型。`
                }
            },
            { tag: "action", actions },
            { tag: "note", elements: [{ tag: "plain_text", content: "也可以直接回复：允许一次 / 始终允许 / 拒绝" }] }
        ]
    };
}
/**
 * 解析用户对 question 的文本回答。
 * 返回 { answers: string[][] }，或 null 表示无法解析（让调用方提示后继续等待）。
 */
function parseTextQuestionAnswer(text, ask) {
    const questions = ask.questions ?? [];
    if (questions.length === 0) {
        return null;
    }
    const raw = (text ?? "").trim();
    if (!raw) {
        return null;
    }
    // 多条问题：按行拆分；行内再按分号/中文分号拆分
    const segments = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const singleQuestion = questions.length === 1;
    const buildAnswer = (question, answerText) => {
        const options = Array.isArray(question.options) ? question.options : [];
        const multi = question.multiple === true;
        const custom = question.custom !== false;
        if (options.length === 0) {
            return [answerText];
        }
        const normalize = (value) => value.trim().replace(/^[A-Za-z]\s*[:：.]\s*/, "").toLowerCase();
        const normAnswer = normalize(answerText);
        if (multi) {
            const picked = answerText
                .split(/[,，、;；]/)
                .map((part) => part.trim())
                .filter(Boolean)
                .map((part) => {
                    const indexMatch = part.match(/^\d+$/);
                    if (indexMatch) {
                        const index = Number(part) - 1;
                        if (index >= 0 && index < options.length) {
                            return options[index].label;
                        }
                    }
                    const hit = options.find((option) => normalize(option.label ?? "") === normalize(part));
                    return hit ? hit.label : undefined;
                })
                .filter(Boolean);
            if (picked.length === 0) {
                return custom ? [answerText] : null;
            }
            return [...new Set(picked)];
        }
        const indexMatch = normAnswer.match(/^\d+$/);
        if (indexMatch) {
            const index = Number(normAnswer) - 1;
            if (index >= 0 && index < options.length) {
                return [options[index].label];
            }
            return custom ? [answerText] : null;
        }
        const hit = options.find((option) => normalize(option.label ?? "") === normAnswer);
        if (hit) {
            return [hit.label];
        }
        return custom ? [answerText] : null;
    };
    if (singleQuestion) {
        const answer = buildAnswer(questions[0], raw);
        if (answer === null) {
            return null;
        }
        return { answers: [answer] };
    }
    // 多条问题：如果段数与问题数一致则一一对应；否则整段按分号拆
    let answerSegments = segments;
    if (answerSegments.length !== questions.length) {
        answerSegments = raw
            .split(/[;；]/)
            .map((part) => part.trim())
            .filter(Boolean);
    }
    if (answerSegments.length !== questions.length) {
        return null;
    }
    const answers = [];
    for (let index = 0; index < questions.length; index += 1) {
        const answer = buildAnswer(questions[index], answerSegments[index]);
        if (answer === null) {
            return null;
        }
        answers.push(answer);
    }
    return { answers };
}
/**
 * 解析用户对 permission 的文本回答。
 */
function parseTextPermissionAnswer(text) {
    const raw = (text ?? "").trim().toLowerCase();
    if (/^(1|允许一次|允许1次|yes|y)$/.test(raw)) {
        return { reply: "once" };
    }
    if (/^(2|始终允许|总是允许|永远允许|always)$/.test(raw)) {
        return { reply: "always" };
    }
    if (/^(3|拒绝|no|n|reject)$/.test(raw)) {
        return { reply: "reject" };
    }
    if (raw.includes("拒绝")) {
        return { reply: "reject", message: text.trim() };
    }
    if (raw.includes("允许")) {
        return { reply: "once" };
    }
    return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// /m 菜单卡片（参考 dsh-im 的菜单卡片设计：按钮回调 + 「回复编号」文本兜底）
// ───────────────────────────────────────────────────────────────────────────────

/**
 * 菜单条目表：cmd 为可执行命令（与主入口命令解析保持一致），label 用于按钮与编号列表，
 * hint 用于编号列表的说明。数组顺序即 buildMenuCard 中 1..N 的展示顺序。
 */
const MENU_ENTRIES = [
    { cmd: "/new", label: "🆕 新会话", hint: "清空上下文，保留当前工作目录开新会话（/reset 回默认目录）" },
    { cmd: "/sessions", label: "📋 会话列表", hint: "查看可恢复的 session（不切换）" },
    { cmd: "/session", label: "🔀 当前会话", hint: "查看当前 attach 的会话；回复 /session <编号|id> 切换" },
    { cmd: "/models", label: "🧠 可用模型", hint: "列出全部可用模型（👈 标注当前）" },
    { cmd: "/model", label: "🎯 当前模型", hint: "查看当前模型；/model <编号|provider/model> 切换" },
    { cmd: "/help", label: "📖 完整指引", hint: "显示使用说明与全部命令" },
    { cmd: "/status", label: "📊 当前状态", hint: "会话、工作目录、队列与运行任务" },
    { cmd: "/esc", label: "⏹ 中断任务", hint: "中断服务端正在执行的任务（等价终端按 Esc）" },
    { cmd: "/stop", label: "🔇 停止转发", hint: "本地停止转发当前任务进展（服务端继续）" },
    { cmd: "/restart", label: "🔄 重启服务", hint: "重启飞书桥（launchd 自动拉起，约 5-15 秒）" }
];

/**
 * 把 /m 的命令表渲染成飞书交互卡片。与任务内 question/permission 卡片保持一致
 * 的卡片 JSON 格式（config + header + elements；按钮 value 在 card.action.trigger 回调中原样返回）。
 *
 * ctx（可选）：
 *   - sessionId / workdir / model：展示当前上下文
 *   - entries：自定义条目表（默认 MENU_ENTRIES）
 *
 * 每个按钮的 value 为 { kind: "menu", cmd: "<命令>" }；
 * 编号列表用于「直接回复编号」的文本兜底（编号 1..N 与 entries 一一对应）。
 */
function buildMenuCard(ctx) {
    ctx = ctx || {};
    const entries = Array.isArray(ctx.entries) && ctx.entries.length > 0 ? ctx.entries : MENU_ENTRIES;
    const contextLines = [];
    const sessionText = ctx.sessionId ? "`" + ctx.sessionId + "`" : "未绑定（下一条消息将新建）";
    const workdirText = ctx.workdir ? "`" + ctx.workdir + "`" : "（未设置，使用默认）";
    contextLines.push("会话：" + sessionText);
    contextLines.push("工作目录：" + workdirText);
    if (ctx.model) {
        contextLines.push("模型：`" + ctx.model + "`");
    }
    const contextText = contextLines.join(String.fromCharCode(10));
    const numberedLines = entries.map(function (entry, index) {
        const head = "**" + String(index + 1) + "** " + entry.label;
        return entry.hint ? head + " — " + entry.hint : head;
    });
    const elements = [
        {
            tag: "div",
            text: {
                tag: "lark_md",
                content: "**当前上下文**" + String.fromCharCode(10) + contextText + String.fromCharCode(10) + "──────────────" + String.fromCharCode(10) + numberedLines.join(String.fromCharCode(10))
            }
        }
    ];
    // 按钮每行两个（顺序与编号列表一致）
    for (let i = 0; i < entries.length; i += 2) {
        const row = entries.slice(i, i + 2);
        const actions = row.map(function (entry) {
            return {
                tag: "button",
                text: { tag: "plain_text", content: String(entry.label).slice(0, 20) },
                type: entry.cmd === "/new" || entry.cmd === "/restart" ? "primary" : "default",
                value: { kind: "menu", cmd: entry.cmd }
            };
        });
        elements.push({ tag: "action", actions: actions });
    }
    elements.push({
        tag: "note",
        elements: [
            { tag: "plain_text", content: "点击上方按钮即可执行；也可直接回复编号（打开菜单后 10 分钟内有效），或输入 /命令 文字。" }
        ]
    });
    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: "plain_text", content: "🤖 OpenCode × 飞书 菜单" },
            template: "blue"
        },
        elements: elements
    };
}

exports.MENU_ENTRIES = MENU_ENTRIES;
exports.buildMenuCard = buildMenuCard;
// ───────────────────────────────────────────────────────────────────────────────
// /m 菜单卡片（卡片 JSON 2.0：下拉选择 + 按钮，参考 dsh-im dsh-feishu 的 menuCard）
// ───────────────────────────────────────────────────────────────────────────────

const NL = String.fromCharCode(10);

function plainText(content) {
    return { tag: "plain_text", content: String(content) };
}
function markdown(content) {
    return { tag: "lark_md", content: String(content) };
}
/** 截断长文本，避免下拉选项 / 按钮文字过长（换行折叠为空格） */
function clipText(value, max) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (text.length <= max) {
        return text;
    }
    return text.slice(0, Math.max(1, max - 1)) + "…";
}
/** select_static 的 initial_index 为 1 基序号，0 表示不预选（2.0 不支持 options.selected） */
function initialIndex(options, currentValue) {
    const index = options.findIndex((option) => option.value === currentValue);
    return index >= 0 ? index + 1 : 0;
}
function cardV2(headerText, elements, template) {
    return {
        schema: "2.0",
        header: { title: plainText(headerText), template: template || "blue" },
        body: { elements }
    };
}
function v2Button(label, value) {
    return {
        tag: "button",
        text: plainText(label),
        type: "default",
        width: "fill",
        behaviors: [{ type: "callback", value }]
    };
}
/** 一行等宽按钮（2.0 用 column_set 表达并排按钮） */
function v2ButtonRow(items) {
    return {
        tag: "column_set",
        flex_mode: "none",
        columns: items.map((item) => ({
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [v2Button(item.label, item.value)]
        }))
    };
}
function v2IconColumn(icon) {
    return {
        tag: "column",
        width: "weighted",
        weight: 0.1,
        vertical_align: "center",
        elements: [{ tag: "div", text: plainText(icon) }]
    };
}
function v2ElementColumn(element) {
    return { tag: "column", width: "weighted", weight: 1, elements: [element] };
}
/**
 * 2.0 下拉选择-单选。回调时飞书把选中项的 value 放在 event.action.option，
 * behaviors.value（{ kind: "pick", pick }）原样放在 event.action.value。
 */
function v2Select(name, placeholder, options, currentValue, pick) {
    return {
        tag: "select_static",
        name,
        placeholder: plainText(placeholder),
        initial_index: initialIndex(options, currentValue),
        options,
        behaviors: [{ type: "callback", value: { kind: "pick", pick } }]
    };
}

/**
 * 新版 /m 菜单卡片（卡片 JSON 2.0）：历史会话 / 历史工作目录 / 可选模型三个下拉选择 + 操作按钮。
 * ctx：
 *   - sessionId / sessionTitle          当前 attach 的会话
 *   - sessions: [{ id, title }]         历史会话下拉（切换 attach）
 *   - workdir / workdirs: string[]      历史工作目录下拉（等价 /new <dir>）
 *   - model / models: [{ id }]          可选模型下拉（等价 /model <id>）
 *   - entries                           操作按钮条目（默认 MENU_ENTRIES，保留编号兜底）
 */
function buildMenuSelectCard(ctx) {
    ctx = ctx || {};
    const entries = Array.isArray(ctx.entries) && ctx.entries.length > 0 ? ctx.entries : MENU_ENTRIES;
    const sessions = Array.isArray(ctx.sessions) ? ctx.sessions.slice(0, 20) : [];
    const workdirs = Array.isArray(ctx.workdirs) ? ctx.workdirs.slice(0, 20) : [];
    const models = Array.isArray(ctx.models) ? ctx.models.slice(0, 40) : [];
    const elements = [];
    const contextLines = [];
    const sessionText = ctx.sessionId
        ? "`" + ctx.sessionId + "`" + (ctx.sessionTitle ? " " + clipText(ctx.sessionTitle, 30) : "")
        : "未绑定（下一条消息将新建）";
    contextLines.push("会话：" + sessionText);
    contextLines.push("工作目录：" + (ctx.workdir ? "`" + ctx.workdir + "`" : "（未设置，使用默认）"));
    contextLines.push("模型：" + (ctx.model ? "`" + ctx.model + "`" : "（使用 OpenCode 默认）"));
    elements.push({ tag: "markdown", content: "**当前上下文**" + NL + contextLines.join(NL) });
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: "**会话 · 工作目录**" });
    const pickColumns = [];
    if (sessions.length > 0) {
        const options = sessions.map((session) => ({
            text: plainText((session.id === ctx.sessionId ? "✓ " : "") + clipText(session.title && String(session.title).trim() ? session.title : session.id, 36)),
            value: session.id
        }));
        pickColumns.push(v2IconColumn("💬"), v2ElementColumn(v2Select("session_pick", "选择会话（切换 attach）", options, ctx.sessionId, "session")));
    }
    if (workdirs.length > 0) {
        const options = workdirs.map((path) => ({
            text: plainText((path === ctx.workdir ? "✓ " : "") + clipText(path, 44)),
            value: path
        }));
        pickColumns.push(v2IconColumn("📂"), v2ElementColumn(v2Select("workdir_pick", "选择工作目录（开启新会话）", options, ctx.workdir, "workdir")));
    }
    if (pickColumns.length > 0) {
        elements.push({ tag: "column_set", flex_mode: "none", columns: pickColumns });
    } else {
        elements.push({ tag: "markdown", content: "暂无可选的会话或工作目录。" });
    }
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: "**模型**" });
    if (models.length > 0) {
        const options = models.map((model) => ({
            text: plainText((model.id === ctx.model ? "✓ " : "") + clipText(model.id, 50)),
            value: model.id
        }));
        elements.push(v2Select("model_pick", "选择模型（下一条消息生效）", options, ctx.model, "model"));
    } else {
        elements.push({ tag: "markdown", content: "未获取到模型列表（可回复 /models 重试）。" });
    }
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: "**操作**" });
    for (let i = 0; i < entries.length; i += 2) {
        const items = entries.slice(i, i + 2).map((entry, offset) => ({
            label: String(i + offset + 1) + ". " + clipText(entry.label, 16),
            value: { kind: "menu", cmd: entry.cmd }
        }));
        elements.push(v2ButtonRow(items));
    }
    elements.push({ tag: "markdown", content: "_下拉选择即刻生效；也可直接回复编号（10 分钟内有效）或输入 /命令。_" });
    return cardV2("🤖 OpenCode × 飞书 菜单", elements);
}

exports.buildMenuSelectCard = buildMenuSelectCard;
