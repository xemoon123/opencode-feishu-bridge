"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const Lark = __importStar(require("@larksuiteoapi/node-sdk"));
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const node_http_1 = require("node:http");
const node_https_1 = require("node:https");
// 飞书 REST（axios 走 Node 全局 agent）：禁用连接复用，每次请求新建连接，
// 避免长驻进程里 keep-alive 复用失效连接导致发送卡到 30s 超时（现象：外部进程同 SDK 秒回、桥内全部 api_timeout）。
node_http_1.globalAgent = new node_http_1.Agent({ keepAlive: false });
node_https_1.globalAgent = new node_https_1.Agent({ keepAlive: false });
const config_1 = require("./config");
const opencode_1 = require("./opencode");
const interaction_1 = require("./interaction");
const table_card_1 = require("./table-card");
const opencode_exec_1 = require("./opencode-exec");
const client = new Lark.Client({
    appId: config_1.config.appId,
    appSecret: config_1.config.appSecret
});
const wsClient = new Lark.WSClient({
    appId: config_1.config.appId,
    appSecret: config_1.config.appSecret,
    autoReconnect: true,
    loggerLevel: Lark.LoggerLevel.info
});
const handledEvents = new Map();
const allowedOpenIds = new Set(config_1.config.allowedOpenIds);
const allowAllOpenIds = allowedOpenIds.size === 0;
const sessionByUser = new Map();
const modelByUser = new Map();
const workdirByUser = new Map();
/** openId -> 最近使用过的工作目录（最近优先，供 /m 菜单下拉选择） */
const workdirHistoryByUser = new Map();
const WORKDIR_HISTORY_MAX = 10;
const lastChatByOpenId = new Map();
/**
 * 事件订阅目标目录：默认目录 + 当前被 attach（sessionByUser）的会话所在目录。
 * 只有需要向飞书转发事件的目录才值得订阅（不随历史切换累积）。
 */
function computeWatchDirectories() {
    const dirs = new Set([config_1.config.opencodeWorkdir]);
    for (const [openId, sessionId] of sessionByUser.entries()) {
        if (!sessionId) {
            continue;
        }
        const dir = workdirByUser.get(openId) || config_1.config.opencodeWorkdir;
        if (dir) {
            dirs.add(dir);
        }
    }
    return Array.from(dirs);
}
/** 收敛事件订阅到当前 attach 目录集合（替换语义） */
function syncWatchDirectories() {
    (0, opencode_1.setWatchWorkDirectories)(computeWatchDirectories());
}
let isOpenCodeReady = false;
let opencodeReadyPromise;
const userMessageQueues = new Map();
/** /stop 后本地静默（统一事件流不再为该用户转发进展） */
const suppressForwardByOpenId = new Map();
/** /restart 重启前后会话状态持久化文件 */
const SESSION_STATE_FILE = (0, node_path_1.join)((0, node_os_1.homedir)(), ".config/opencode/feishu-bridge/session-state.json");
function persistSessionState() {
    try {
        const users = {};
        const openIds = new Set();
        for (const openId of sessionByUser.keys()) {
            openIds.add(openId);
        }
        for (const openId of workdirByUser.keys()) {
            openIds.add(openId);
        }
        for (const openId of modelByUser.keys()) {
            openIds.add(openId);
        }
        for (const openId of workdirHistoryByUser.keys()) {
            openIds.add(openId);
        }
        for (const openId of openIds) {
            const sessionId = sessionByUser.get(openId);
            const workdir = workdirByUser.get(openId);
            const model = modelByUser.get(openId);
            const chatId = lastChatByOpenId.get(openId);
            const workdirs = workdirHistoryByUser.get(openId);
            if (!sessionId && !workdir && !model && (!Array.isArray(workdirs) || workdirs.length === 0)) {
                continue;
            }
            users[openId] = {
                sessionId: sessionId || undefined,
                workdir: workdir || undefined,
                chatId: chatId || undefined,
                model: model || undefined,
                workdirs: Array.isArray(workdirs) && workdirs.length > 0 ? workdirs : undefined
            };
        }
        (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(SESSION_STATE_FILE), { recursive: true });
        (0, node_fs_1.writeFileSync)(SESSION_STATE_FILE, JSON.stringify({ users }, null, 2));
    }
    catch (error) {
        console.error("[state]: persist_failed", error);
    }
}
function restoreSessionState() {
    try {
        if (!(0, node_fs_1.existsSync)(SESSION_STATE_FILE)) {
            return;
        }
        const raw = (0, node_fs_1.readFileSync)(SESSION_STATE_FILE, "utf8");
        const parsed = JSON.parse(raw);
        const users = parsed?.users ?? {};
        let restored = 0;
        for (const [openId, value] of Object.entries(users)) {
            if (!openId || !value || typeof value !== "object") {
                continue;
            }
            if (typeof value.sessionId === "string" && value.sessionId) {
                sessionByUser.set(openId, value.sessionId);
            }
            if (typeof value.chatId === "string" && value.chatId) {
                lastChatByOpenId.set(openId, value.chatId);
            }
            if (value.workdir && (0, node_fs_1.existsSync)(value.workdir)) {
                workdirByUser.set(openId, value.workdir);
            }
            if (typeof value.model === "string" && value.model) {
                modelByUser.set(openId, value.model);
            }
            if (Array.isArray(value.workdirs)) {
                const dirs = value.workdirs.filter((item) => typeof item === "string" && item).slice(0, WORKDIR_HISTORY_MAX);
                if (dirs.length > 0) {
                    workdirHistoryByUser.set(openId, dirs);
                }
            }
            restored += 1;
        }
        if (restored > 0) {
            console.log(`[state]: restored ${String(restored)} user session(s)`);
        }
    }
    catch (error) {
        console.error("[state]: restore_failed", error);
    }
    syncWatchDirectories();
}
restoreSessionState();
const busyProbeCache = new Map();
const suspectBusySessions = new Set();
/** 桥自身正在执行任务的会话（防被动订阅与主流程双发） */
const activeBridgeSessionByOpenId = new Map();
/** 各用户最近一次消息所在的飞书 chat（用于被动转发目标） */
/** 被动转发：会话 -> 临时聚合状态 */
const passiveSessionState = new Map();
let passiveWatcherAbort = null;
/** 运行中的工具调用（callID -> { tool, at }）：看门狗据此区分合法长任务（如 deveco 构建）与卡死 */
const runningToolCalls = new Map();
/** 记录/更新工具调用状态：仅保留 pending/running 的调用，其余（completed/error）移除 */
function trackRunningToolPart(part) {
    const callID = part?.callID ?? part?.id;
    if (!callID) {
        return;
    }
    const status = part?.state?.status;
    if (status === "running" || status === "pending") {
        const previous = runningToolCalls.get(callID);
        runningToolCalls.set(callID, {
            tool: part?.tool ?? previous?.tool ?? "unknown",
            at: previous?.at ?? Date.now()
        });
    }
    else {
        runningToolCalls.delete(callID);
    }
}
/** 返回最早开始运行的构建类工具（无则 null），供看门狗判断是否处于合法长任务 */
function getRunningToolInfo() {
    let oldest = null;
    for (const info of runningToolCalls.values()) {
        if (!oldest || info.at < oldest.at) {
            oldest = info;
        }
    }
    return oldest ? { since: oldest.at, tool: oldest.tool } : null;
}
/**
 * 当前是否有任务在跑（供看门狗判断"空闲"，决定每日定时重启能否执行）。
 * 三个来源任一命中即视为忙：本地消息队列 / SSE 跟踪到的运行中工具 / 服务端会话状态。
 * 服务端探测失败（如 serve 已无响应）按"空闲"处理——定时重启本身就能修好这种情况。
 */
async function isAnyTaskRunning() {
    for (const queueState of userMessageQueues.values()) {
        if (!queueState) {
            continue;
        }
        if (queueState.activeItem) {
            return true;
        }
        if (Array.isArray(queueState.items) && queueState.items.length > 0) {
            return true;
        }
    }
    if (getRunningToolInfo()) {
        return true;
    }
    for (const [openId, sessionId] of sessionByUser.entries()) {
        if (!sessionId) {
            continue;
        }
        const directory = getCurrentWorkdir(openId) ?? config_1.config.opencodeWorkdir;
        const busy = await probeServerBusy(sessionId, directory);
        if (busy === true) {
            return true;
        }
    }
    return false;
}
/** 任务内交互（question/permission）挂起状态：openId -> PendingAsk */
const pendingAsks = new Map();
/** 交互等待用户回答的默认超时（毫秒），超过后视为用户未回答，由 opencode 层 reject 该请求 */
const ASK_WAIT_TIMEOUT_MS = 600000;
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const RESET_COMMAND = "/reset";
const NEW_COMMAND = "/new";
const STOP_COMMAND = "/stop";
const ESC_COMMAND = "/esc";
const RESTART_COMMAND = "/restart";
const STATUS_COMMAND = "/status";
const SESSION_COMMAND = "/session";
const SESSIONS_COMMAND = "/sessions";
const MODELS_COMMAND = "/models";
const MODEL_COMMAND = "/model";
const HELP_COMMAND = "/help";
const MENU_COMMAND = "/m";
const MENU_ALIAS_COMMAND = "/menu";
/** /m 菜单「回复编号」兜底有效期（参考 dsh-im 的 10 分钟菜单 TTL） */
const MENU_ACTIVE_TTL_MS = 10 * 60 * 1000;
/** openId -> { chatId, expiresAt }：最近一次 /m 菜单所在会话，用于编号兜底（防过期/串台） */
const menuActiveByOpenId = new Map();

function cleanupHandledEvents(now) {
    for (const [eventId, timestamp] of handledEvents.entries()) {
        if (now - timestamp > DEDUPE_TTL_MS) {
            handledEvents.delete(eventId);
        }
    }
}
// ─── 任务内交互（OpenCode question / permission <-> 飞书） ───────────────
/** 飞书发送失败（超时/错误）后的小延迟重试，掩盖偶发网络抖动 */
const FEISHU_SEND_RETRY_DELAY_MS = 1500;
function sleepMs(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function sendInteractiveCard(chatId, card, replyToMessageId, eventId, openId) {
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            const result = await withTimeout(client.im.v1.message.create({
                params: { receive_id_type: "chat_id" },
                data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) }
            }), `send_card open_id=${openId ?? "unknown"}`);
            if (result) {
                return result?.data?.message_id;
            }
        }
        catch (error) {
            lastError = error;
        }
        if (attempt < 2) {
            console.log(`[feishu]: send_card_retry open_id=${openId ?? "unknown"} event_id=${eventId ?? "unknown"} attempt=${attempt}`);
            await sleepMs(FEISHU_SEND_RETRY_DELAY_MS);
        }
    }
    if (lastError) {
        console.error(`[feishu]: send_card_failed open_id=${openId ?? "unknown"} event_id=${eventId ?? "unknown"}`, lastError);
    }
    return undefined;
}
/**
 * 生成 askOpenCode 的 onAsk 回调：把问题/授权渲染到飞书并等待用户回答。
 * 返回 Promise<{answers}|{reply}|null>；null 表示用户未回答（超时/中止/放弃）。
 */
function createAskHandler(params) {
    const { chatId, sourceMessageId, senderOpenId, eventId, signal } = params;
    return async (ask, runSignal) => {
        const openId = senderOpenId;
        let resolved = false;
        let timer;
        let resolveAnswer;
        const answerPromise = new Promise((resolve) => {
            resolveAnswer = resolve;
        });
        const finish = (value) => {
            if (resolved) {
                return;
            }
            resolved = true;
            entry.settled = true;
            if (timer) {
                clearTimeout(timer);
            }
            const current = pendingAsks.get(openId);
            if (current === entry) {
                pendingAsks.delete(openId);
                console.log(`[ask]: settled_removed open_id=${openId} requestID=${entry.requestID}`);
            }
            resolveAnswer(value);
        };
        const entry = {
            kind: ask.kind,
            requestID: ask.requestID,
            sessionID: ask.sessionID,
            questions: ask.questions ?? [],
            permission: ask.permission,
            patterns: ask.patterns,
            taskEventId: params.eventId,
            signal: runSignal,
            settled: false,
            finish
        };
        pendingAsks.set(openId, entry);
        console.log(`[ask]: registered open_id=${openId} event_id=${params.eventId ?? "unknown"} kind=${ask.kind} requestID=${ask.requestID}`);
        // 渲染询问卡片
        const card = ask.kind === "permission" ? interaction_1.buildPermissionCard(ask) : interaction_1.buildQuestionCard(ask.questions ?? []);
        await sendInteractiveCard(chatId, card, sourceMessageId, eventId, openId).catch(() => undefined);
        // 等待回答（受 run 中止/整体超时与交互自身超时约束）
        const runAborted = new Promise((resolve) => {
            if (runSignal?.aborted) {
                resolve();
                return;
            }
            runSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        const outerAborted = new Promise((resolve) => {
            if (signal?.aborted) {
                resolve();
                return;
            }
            signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        timer = setTimeout(() => {
            void safeReplyText(chatId, "⏳ 等待回答超时，已跳过该问题，任务继续。", sourceMessageId, eventId, openId).catch(() => undefined);
            finish(null);
        }, ASK_WAIT_TIMEOUT_MS);
        await Promise.race([answerPromise, runAborted, outerAborted]);
        finish(null);
        return answerPromise.then((value) => {
            if (resolved && value !== undefined) {
                return value;
            }
            return null;
        });
    };
}
/**
 * 把用户文本消息路由到挂起的交互（question/permission）。
 * 返回 true 表示本条消息已作为回答消费（不再入队为新任务）。
 */
async function routeTextToPendingAsk(params) {
    const { chatId, sourceMessageId, senderOpenId, eventId, text, pending } = params;
    if (pending.kind === "question") {
        const parsed = interaction_1.parseTextQuestionAnswer(text, pending);
        if (parsed === null) {
            await safeReplyText(chatId, "❓ 没看懂这个回答。请回复选项编号（如 1）或直接输入内容；多条问题请用分号或换行分隔。", sourceMessageId, eventId, senderOpenId);
            return true;
        }
        pending.finish({ answers: parsed.answers });
        const summary = parsed.answers
            .map((answer, index) => `${index + 1}. ${(answer ?? []).join("、") || "（未填）"}`)
            .join("  ");
        await safeReplyText(chatId, `✅ 已收到你的回答：${summary}`, sourceMessageId, eventId, senderOpenId);
        return true;
    }
    if (pending.kind === "permission") {
        const parsed = interaction_1.parseTextPermissionAnswer(text);
        if (parsed === null) {
            await safeReplyText(chatId, "❓ 请回复：允许一次 / 始终允许 / 拒绝", sourceMessageId, eventId, senderOpenId);
            return true;
        }
        pending.finish(parsed);
        const label = parsed.reply === "always" ? "始终允许" : parsed.reply === "reject" ? "拒绝" : "允许一次";
        await safeReplyText(chatId, `✅ 已收到你的授权决定：${label}`, sourceMessageId, eventId, senderOpenId);
        return true;
    }
    return false;
}
function parseTextContent(content) {
    try {
        const payload = JSON.parse(content);
        return payload.text?.trim() ?? "";
    }
    catch {
        return "";
    }
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
async function listRecentSessionsText(includeResumeHint) {
    const sessions = await (0, opencode_1.listOpenCodeSessionsFromDb)(30);
    if (sessions.length === 0) {
        return "当前没有可用的 OpenCode session。";
    }
    const lines = sessions.map((session, index) => {
        const title = session.title?.trim() ? session.title.trim() : "(无标题)";
        const updatedAt = session.updated ? new Date(session.updated).toLocaleString("zh-CN", { hour12: false }) : "unknown";
        return `${String(index + 1)}. ${session.id} | ${title} | ${updatedAt}`;
    });
    const footer = includeResumeHint ? "\n\n使用方式：/session <编号|session_id>" : "";
    return `可用 session（最近 ${String(sessions.length)} 条）：\n${lines.join("\n")}${footer}`;
}
function isSessionsCommand(text) {
    const sessionsPattern = new RegExp(`^${escapeRegExp(SESSIONS_COMMAND)}(?:\\s+(.+))?$`);
    return sessionsPattern.test(text.trim());
}
function parseResumeCommand(text) {
    const trimmed = text.trim();
    const resumePattern = new RegExp(`^${escapeRegExp(SESSION_COMMAND)}(?:\\s+(.+))?$`);
    const matched = trimmed.match(resumePattern);
    if (!matched) {
        return { isResume: false };
    }
    const rawArg = matched[1]?.trim();
    if (!rawArg) {
        return { isResume: true };
    }
    return {
        isResume: true,
        sessionId: rawArg.split(/\s+/)[0]
    };
}
function isStopCommand(text) {
    const stopPattern = new RegExp(`^${escapeRegExp(STOP_COMMAND)}(?:\\s+)?$`);
    return stopPattern.test(text.trim());
}
function isEscCommand(text) {
    const pattern = new RegExp(`^${escapeRegExp(ESC_COMMAND)}(?:\\s+)?$`);
    return pattern.test(text.trim());
}
function isRestartCommand(text) {
    const restartPattern = new RegExp(`^${escapeRegExp(RESTART_COMMAND)}(?:\\s+)?$`);
    return restartPattern.test(text.trim());
}
function isStatusCommand(text) {
    const statusPattern = new RegExp(`^${escapeRegExp(STATUS_COMMAND)}(?:\s+)?$`);
    return statusPattern.test(text.trim());
}
/**
 * 是否为桥的内置命令（/help /new /reset /session /sessions /models /model /stop /esc /restart /status /m）。
 * 挂起提问时这些命令优先按命令处理，不能被误路由为"回答"。
 */
function isKnownCommand(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
        return false;
    }
    return trimmed === RESET_COMMAND
        || trimmed === STOP_COMMAND
        || trimmed === ESC_COMMAND
        || trimmed === HELP_COMMAND
        || trimmed === STATUS_COMMAND
        || isMenuCommand(trimmed)
        || new RegExp(`^${escapeRegExp(NEW_COMMAND)}(?:\\s+(.+))?$`).test(trimmed)
        || new RegExp(`^${escapeRegExp(SESSION_COMMAND)}(?:\\s+(.+))?$`).test(trimmed)
        || new RegExp(`^${escapeRegExp(SESSIONS_COMMAND)}(?:\\s+(.+))?$`).test(trimmed)
        || new RegExp(`^${escapeRegExp(MODEL_COMMAND)}(?:\\s+(.+))?$`).test(trimmed)
        || new RegExp(`^${escapeRegExp(MODELS_COMMAND)}(?:\\s+)?$`).test(trimmed);
}

function parseNewCommand(text) {
    const trimmed = text.trim();
    const newPattern = new RegExp(`^${escapeRegExp(NEW_COMMAND)}(?:\\s+(.+))?$`);
    const matched = trimmed.match(newPattern);
    if (!matched) {
        return { isNew: false };
    }
    const rawArg = matched[1]?.trim();
    if (!rawArg) {
        return { isNew: true };
    }
    return {
        isNew: true,
        workdir: rawArg
    };
}
function getCurrentWorkdir(openId) {
    return workdirByUser.get(openId) ?? config_1.config.opencodeWorkdir;
}
/** 记录一次使用过的工作目录（最近优先、去重、限长），供 /m 菜单下拉选择 */
function rememberWorkdir(openId, directory) {
    const dir = typeof directory === "string" ? directory.trim() : "";
    if (!openId || !dir) {
        return;
    }
    const list = workdirHistoryByUser.get(openId) ?? [];
    const next = [dir, ...list.filter((item) => item !== dir)].slice(0, WORKDIR_HISTORY_MAX);
    workdirHistoryByUser.set(openId, next);
}
/**
 * 汇总 /m 菜单「工作目录」下拉候选：当前目录 + 历史目录 + 最近会话目录 + 默认目录，
 * 只保留真实存在且可访问的目录，最近优先，最多 20 项。
 */
function collectWorkdirCandidates(openId, sessions, currentWorkdir) {
    const ordered = [];
    const seen = new Set();
    const push = (value) => {
        const dir = typeof value === "string" ? value.trim() : "";
        if (!dir || seen.has(dir)) {
            return;
        }
        seen.add(dir);
        ordered.push(dir);
    };
    push(currentWorkdir);
    for (const dir of workdirHistoryByUser.get(openId) ?? []) {
        push(dir);
    }
    if (Array.isArray(sessions)) {
        for (const session of sessions) {
            push(session && session.directory);
        }
    }
    push(config_1.config.opencodeWorkdir);
    const valid = [];
    for (const dir of ordered) {
        try {
            if ((0, node_fs_1.existsSync)(dir) && (0, node_fs_1.statSync)(dir).isDirectory()) {
                valid.push(dir);
            }
        }
        catch {
            // 不可访问的目录直接跳过
        }
        if (valid.length >= 20) {
            break;
        }
    }
    return valid;
}
function normalizeWorkdirInput(input) {
    if (input === "~") {
        return (0, node_os_1.homedir)();
    }
    if (input.startsWith("~/")) {
        return (0, node_path_1.resolve)((0, node_os_1.homedir)(), input.slice(2));
    }
    return input;
}
function resolveWorkdirInput(input, baseDirectory) {
    const normalized = normalizeWorkdirInput(input.trim());
    if (!normalized) {
        return { ok: false, reason: "目录不能为空。" };
    }
    const candidate = (0, node_path_1.isAbsolute)(normalized) ? (0, node_path_1.resolve)(normalized) : (0, node_path_1.resolve)(baseDirectory, normalized);
    if (!(0, node_fs_1.existsSync)(candidate)) {
        return { ok: false, reason: `目录不存在：${candidate}` };
    }
    try {
        const stat = (0, node_fs_1.statSync)(candidate);
        if (!stat.isDirectory()) {
            return { ok: false, reason: `不是目录：${candidate}` };
        }
    }
    catch {
        return { ok: false, reason: `无法访问目录：${candidate}` };
    }
    return { ok: true, workdir: candidate };
}
function validateExistingWorkdir(directory) {
    const workdir = directory.trim();
    if (!workdir) {
        return { ok: false, reason: "该会话未记录工作目录。" };
    }
    if (!(0, node_fs_1.existsSync)(workdir)) {
        return { ok: false, reason: `会话工作目录不存在：${workdir}` };
    }
    try {
        const stat = (0, node_fs_1.statSync)(workdir);
        if (!stat.isDirectory()) {
            return { ok: false, reason: `会话工作目录不是目录：${workdir}` };
        }
    }
    catch {
        return { ok: false, reason: `会话工作目录不可访问：${workdir}` };
    }
    return { ok: true, workdir };
}
function isModelsCommand(text) {
    return /^\/models(?:\s+)?$/.test(text.trim());
}
function parseModelCommand(text) {
    const trimmed = text.trim();
    const modelPattern = new RegExp(`^${escapeRegExp(MODEL_COMMAND)}(?:\\s+(.+))?$`);
    const matched = trimmed.match(modelPattern);
    if (!matched) {
        return { isModel: false };
    }
    const rawArg = matched[1]?.trim();
    if (!rawArg) {
        return { isModel: true };
    }
    return {
        isModel: true,
        model: rawArg.split(/\s+/)[0]
    };
}
function isHelpCommand(text) {
    return /^\/help(?:\s+)?$/.test(text.trim());
}
/** 生成 /help 的飞书交互指引文本 */
function buildHelpGuide() {
    const defaultWorkdir = config_1.config.opencodeWorkdir;
    const timeoutSec = Math.round((config_1.config.opencodeTimeout ?? 300000) / 1000);
    const lines = [
        "📖 OpenCode × 飞书 交互指引",
        "──────────────────",
        "本机器人由 opencode-feishu-bridge 桥接：飞书消息 → 本机 opencode serve → 回答回传。直接发送文本消息即可提问（当前仅支持文本消息）。",
        "",
        "🛠 常用命令",
        "/help —— 显示本指引",
        "/m —— 打开菜单卡片（点击按钮或回复编号，即可执行常用命令）",
        "/reset —— 清空上下文，回到默认工作目录开新会话",
        "/new —— 清空上下文，保留当前工作目录开新会话",
        "/new <目录> —— 清空上下文，切换到指定目录开新会话",
        "/esc —— 中断服务端正在执行的任务（等价在终端 attach 的界面里按 Esc）",
        "/stop —— 本地停止转发该会话的进展（服务端任务仍在继续）",
        "/restart —— 重启飞书桥服务（自动恢复，约几秒）",
        "/session —— 查看当前 attach 的会话（id + 标题；用 /status 可拿到终端 attach 命令）",
        "/session <编号|session_id> —— 切换/恢复到指定会话",
        "/sessions —— 查看会话列表（不切换）",
        "/model —— 查看当前会话模型（最近实际使用 / 已选择）",
        "/model <编号|provider/model> —— 切换模型（下一条消息生效）",
        "/models —— 列出全部可用模型（👈 标注当前）",
        "/status —— 查看会话状态、工作目录、队列与运行任务（并附本机 attach 该会话的命令）",
        "",
        "🗂 当前配置",
        `默认工作目录：${defaultWorkdir}`,
        `长静默：任务 ${String(timeoutSec)} 秒无输出会给提醒（不中断）｜交互等待超时：10 分钟`,
        "",
        "🤝 任务内交互",
        "OpenCode 运行中需要你选择/输入时，会收到蓝色问题卡片：可点击选项按钮，或直接回复选项编号（如 1）、选项文字或任意内容；多条问题用逗号/分号分隔。",
        "OpenCode 请求工具授权时，会收到橙色授权卡片：允许一次 / 始终允许 / 拒绝，或直接回复文字。",
        "等待超时后问题会被自动跳过、任务继续；发送 /esc 可中断任务并取消挂起的提问。",
        "",
        "💡 小贴士",
        "/help、/reset、/new、/stop、/esc、/session、/sessions、/model、/models、/status、/restart、/m 均为本地命令，不消耗模型额度；其他以 / 开头的未知命令会当作普通问题发送给模型。",
        "任务跑偏或卡住时用 /esc 中断：它会真正让服务端停下当前生成与工具调用（已在终端 attach 的界面里按 Esc 等价），已产生的输出仍会回传。",
        "若你在终端执行 opencode attach http://127.0.0.1:4096 并对当前 attach 的会话发起任务，其进展也会同步转发到这里（带 🖥 标记）。",
        "需要把工作区里的文件作为真实文件发过来时，告诉模型使用 feishu_send_file 工具（feishu-bridge 提供）。",
        `需要调整机器人配置（飞书应用凭证、默认目录、白名单等），请修改 ~/.config/opencode/feishu-bridge/config.json 后重启服务。`
    ];
    return lines.join("\n");
}
/** 是否为 /m（或 /menu）菜单命令 */
function isMenuCommand(text) {
    const trimmed = String(text || "").trim();
    return trimmed === MENU_COMMAND || trimmed === MENU_ALIAS_COMMAND;
}
/** 记录一次菜单展示（编号兜底的有效期与聊天范围判定） */
function rememberMenuShown(openId, chatId) {
    menuActiveByOpenId.set(openId, { chatId, expiresAt: Date.now() + MENU_ACTIVE_TTL_MS });
}
/**
 * 菜单打开后 10 分钟内，把「回复编号」解析为对应菜单命令（参考 dsh-im 的数字兜底）。
 * 过期或不在同一会话内返回 null，避免把编号误吞成普通消息/提问回答。
 */
function menuEntryByNumber(openId, chatId, text) {
    const state = menuActiveByOpenId.get(openId);
    if (!state) {
        return null;
    }
    if (Date.now() > state.expiresAt) {
        menuActiveByOpenId.delete(openId);
        return null;
    }
    if (state.chatId !== chatId) {
        return null;
    }
    const index = Number(text) - 1;
    const entries = interaction_1.MENU_ENTRIES;
    if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
        return null;
    }
    return entries[index];
}
/** 模型列表缓存：/m 菜单频繁打开时避免每次都执行 `opencode models` */
const MENU_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
let menuModelCache = { at: 0, models: [] };
async function getMenuModelsCached() {
    if (menuModelCache.models.length > 0 && Date.now() - menuModelCache.at < MENU_MODEL_CACHE_TTL_MS) {
        return menuModelCache.models;
    }
    const models = await (0, opencode_1.listOpenCodeModels)();
    menuModelCache = { at: Date.now(), models };
    return models;
}
/**
 * 发送 /m 菜单到指定会话。优先下发卡片 JSON 2.0（会话 / 工作目录 / 模型 三个下拉选择，
 * 参考 dsh-im 的菜单卡片）；若应用/客户端不接受 2.0 卡片则自动回退到 1.0 按钮卡片。
 */
async function sendMenuCard(chatId, senderOpenId) {
    try {
        const sessionId = sessionByUser.get(senderOpenId) ?? null;
        const workdir = getCurrentWorkdir(senderOpenId);
        const model = modelByUser.get(senderOpenId) ?? config_1.config.opencodeModel ?? null;
        let sessions = [];
        let sessionTitle = null;
        try {
            sessions = await (0, opencode_1.listOpenCodeSessionsFromDb)(20);
        }
        catch (error) {
            console.warn(`[menu]: list_sessions_failed open_id=${senderOpenId}`, error);
        }
        if (sessionId) {
            const current = sessions.find((session) => session.id === sessionId);
            if (current && current.title && current.title.trim()) {
                sessionTitle = current.title.trim();
            }
            else {
                try {
                    const meta = await (0, opencode_1.getOpenCodeSessionByIdFromDb)(sessionId);
                    if (meta && meta.title && meta.title.trim()) {
                        sessionTitle = meta.title.trim();
                    }
                }
                catch (error) {
                    // 标题缺失不影响菜单展示
                }
            }
        }
        const workdirs = collectWorkdirCandidates(senderOpenId, sessions, workdir);
        let models = [];
        try {
            models = await getMenuModelsCached();
        }
        catch (error) {
            console.warn(`[menu]: list_models_failed open_id=${senderOpenId}`, error);
        }
        const selectCard = (0, interaction_1.buildMenuSelectCard)({
            sessionId,
            sessionTitle,
            sessions,
            workdir,
            workdirs,
            model,
            models,
            entries: interaction_1.MENU_ENTRIES
        });
        let messageId = await sendInteractiveCard(chatId, selectCard, undefined, undefined, senderOpenId);
        if (!messageId) {
            console.warn(`[menu]: select_card_rejected_fallback open_id=${senderOpenId}`);
            const legacyCard = (0, interaction_1.buildMenuCard)({ sessionId, workdir, model, entries: interaction_1.MENU_ENTRIES });
            messageId = await sendInteractiveCard(chatId, legacyCard, undefined, undefined, senderOpenId);
        }
        if (messageId) {
            rememberMenuShown(senderOpenId, chatId);
        }
    }
    catch (error) {
        console.error(`[menu]: send_menu_failed open_id=${senderOpenId}`, error);
        void safeReplyText(chatId, "生成菜单卡片失败，请发送 /help 查看完整指引。", undefined, undefined, senderOpenId).catch(() => undefined);
    }
}
/** /esc 之后短时间内到达的 idle 事件：收尾文案由「任务完成」改为「任务已中断」 */
const abortedByUserSessions = new Map();
const ABORTED_NOTICE_TTL_MS = 3 * 60 * 1000;
/**
 * 中断后撤销该用户挂起的提问/授权等待：服务端已不再需要这个回答，
 * 若不撤销，桥会一直挂到 10 分钟超时；同时记入 externalAnsweredQuestionIds，
 * 避免任务内交互侧随后再补发一次迟到的 reject。
 * 返回被撤销的 entry（无则 null）。
 */
function releasePendingAskForAbort(openId, sessionId) {
    const entry = pendingAsks.get(openId);
    if (!entry || entry.settled === true) {
        return null;
    }
    if (sessionId && entry.sessionID && entry.sessionID !== sessionId) {
        return null;
    }
    if (entry.requestID) {
        externalAnsweredQuestionIds.add(entry.requestID);
    }
    entry.finish(null);
    console.log(`[esc]: pending_ask_released open_id=${openId} kind=${entry.kind} requestID=${entry.requestID}`);
    return entry;
}
/**
 * /esc：中断该用户在 opencode serve 上正在执行的任务（等价在终端 attach 的 TUI 里按 Esc）。
 * 与 /stop（只在本地停止转发）不同，这是真正让服务端停下当前生成与工具调用。
 * 顺序：读会话真实目录 → GET /session/status 确认在跑 → POST abort → 撤销本地挂起提问。
 */
async function handleEscapeCommand(params) {
    const { chatId, sourceMessageId, senderOpenId, eventId } = params;
    const sessionId = sessionByUser.get(senderOpenId);
    if (!sessionId) {
        await safeReplyText(chatId, "当前没有 attach 的会话，没有可中断的任务。发送 /session 查看会话，/help 查看全部命令。", sourceMessageId, eventId, senderOpenId);
        return;
    }
    // abort 与会话一样按目录隔离，优先用会话真实目录（与 /status 的解析口径一致）
    let directory = getCurrentWorkdir(senderOpenId);
    try {
        const meta = await (0, opencode_1.getOpenCodeSessionByIdFromDb)(sessionId);
        if (meta && typeof meta.directory === "string" && meta.directory) {
            directory = meta.directory;
        }
    }
    catch (error) {
        console.warn(`[esc]: read_session_dir_failed open_id=${senderOpenId} session=${sessionId}`, error);
    }
    let status = null;
    try {
        status = await (0, opencode_1.getOpenCodeSessionStatus)(sessionId, directory);
    }
    catch (error) {
        status = null;
    }
    if (status === "idle") {
        releasePendingAskForAbort(senderOpenId, sessionId);
        console.log(`[esc]: noop_idle open_id=${senderOpenId} session=${sessionId}`);
        await safeReplyText(chatId, `当前没有正在执行的任务（session ${sessionId}）。`, sourceMessageId, eventId, senderOpenId);
        return;
    }
    try {
        await (0, opencode_1.abortOpenCodeSession)(sessionId, directory);
    }
    catch (error) {
        const errorMessage = error instanceof Error && error.message ? error.message : "中断请求失败";
        console.error(`[esc]: abort_failed open_id=${senderOpenId} session=${sessionId}`, error);
        await safeReplyText(chatId, `中断失败：${errorMessage}\n可先 /stop 停止本地转发，或用 /restart 重启服务。`, sourceMessageId, eventId, senderOpenId);
        return;
    }
    releasePendingAskForAbort(senderOpenId, sessionId);
    abortedByUserSessions.set(sessionId, Date.now());
    console.log(`[esc]: aborted open_id=${senderOpenId} session=${sessionId} directory=${directory} probe=${status ?? "unknown"}`);
    const note = status === "busy" ? "" : "\n（未能确认当时是否在运行；若确实在跑，中断已送达）";
    await safeReplyText(chatId, `⏹ 已中断服务端正在执行的任务（session ${sessionId}）。\n已产生的输出会照常回传，可直接发送下一条消息继续。${note}`, sourceMessageId, eventId, senderOpenId);
}
/** 工作区实例卡死的自动恢复：同一时间只允许一次重启，且带冷却窗口，避免"每条消息都重启" */
let stuckRecoveryPromise = null;
let lastStuckRecoveryAt = 0;
const STUCK_RECOVERY_COOLDOWN_MS = 5 * 60 * 1000;
/**
 * opencode 的工作区实例在「初始化未完成时被中断」后会卡死：该目录下所有消息都在
 * 毫秒级被 abort（模型不会被调用）。唯一恢复方式是重启 serve（会话在 DB 里，不会丢）。
 * 这里做兜底自愈，否则用户只会看到"已提交"后永远没有下文。
 * 返回是否真的开始了重启（冷却窗口内会跳过，交由用户手动 /restart）。
 */
function recoverStuckWorkspaceInstance() {
    if (stuckRecoveryPromise) {
        console.log("[recover]: stuck_instance_already_recovering");
        return stuckRecoveryPromise;
    }
    if (Date.now() - lastStuckRecoveryAt < STUCK_RECOVERY_COOLDOWN_MS) {
        console.warn("[recover]: stuck_instance_cooldown，跳过本次自动重启");
        return Promise.resolve(false);
    }
    lastStuckRecoveryAt = Date.now();
    console.warn("[recover]: stuck_instance_detected，自动重启 opencode serve");
    stuckRecoveryPromise = (0, opencode_1.restartOpenCodeServe)("工作区实例卡住（自动恢复）")
        .then(() => {
            console.log("[recover]: stuck_instance_recovered");
            return true;
        })
        .catch((error) => {
            console.error("[recover]: stuck_instance_restart_failed", error);
            return false;
        })
        .finally(() => {
            stuckRecoveryPromise = null;
        });
    return stuckRecoveryPromise;
}
/**
 * 本地控制命令（/stop /esc /restart /status）的统一入口：文本消息与 /m 菜单按钮共用。
 * 返回 true 表示已消费该命令。
 */
async function handleControlCommand(params) {
    const { chatId, sourceMessageId, senderOpenId, text, eventId } = params;
    if (isStopCommand(text)) {
        suppressForwardByOpenId.set(senderOpenId, true);
        await safeReplyText(chatId, "已停止跟进该会话的后续进展（服务端任务仍在继续；要真正中断请发送 /esc；下一条消息将恢复转发）。", sourceMessageId, eventId, senderOpenId);
        return true;
    }
    if (isEscCommand(text)) {
        await handleEscapeCommand({ chatId, sourceMessageId, senderOpenId, eventId });
        return true;
    }
    if (isRestartCommand(text)) {
        const pendingAskForRestart = pendingAsks.get(senderOpenId);
        if (pendingAskForRestart) {
            pendingAskForRestart.finish(null);
        }
        persistSessionState();
        console.log(`[state]: persisted before restart open_id=${senderOpenId}`);
        await safeReplyText(chatId, "🔄 收到 /restart，正在重启飞书桥…（约 5-15 秒后恢复）", sourceMessageId, eventId, senderOpenId);
        console.log(`[restart]: triggered_by open_id=${senderOpenId} event_id=${eventId ?? "unknown"}`);
        // 不能同步 process.exit：否则事件处理器不返回、飞书收不到 ack，未确认事件会在重连后被反复重投（重启循环）。
        // 先让处理器正常返回（SDK 随即回 ack），1.5s 后再优雅退出。
        setTimeout(() => {
            try {
                wsClient.close();
            }
            catch (error) {
                console.error("[restart]: ws close failed", error);
            }
            (0, opencode_1.stopOpenCodeServe)()
                .catch((error) => console.error("[restart]: serve stop failed", error))
                .finally(() => {
                    console.log("[restart]: exiting, waiting launchd KeepAlive to respawn...");
                    process.exit(0);
                });
        }, 1500);
        return true;
    }
    if (isStatusCommand(text)) {
        const report = await buildStatusReport(senderOpenId);
        const sent = await safeReplyText(chatId, buildStatusMessage(report), sourceMessageId, eventId, senderOpenId);
        if (!sent) {
            // 富文本（code_block 段落）被拒时退回纯文本，命令依旧可复制
            await safeReplyText(chatId, buildStatusPlainText(report), sourceMessageId, eventId, senderOpenId);
        }
        return true;
    }
    return false;
}
/**
 * 执行一条 /m 菜单命令（等价于用户直接发送该命令文本）。
 * cmd 应来自 MENU_ENTRIES（调用侧校验）；本函数兜底拒绝未知命令，防止误提交给模型。
 */
async function runMenuCommand(params) {
    const { chatId, sourceMessageId, senderOpenId, cmd, eventId } = params;
    const text = String(cmd || "").trim();
    if (!text) {
        return;
    }
    if (await handleControlCommand({ chatId, sourceMessageId, senderOpenId, text, eventId })) {
        return;
    }
    if (!isKnownCommand(text)) {
        await safeReplyText(chatId, `❓ 未知菜单命令：${text}（请回复 /m 重新打开菜单，或 /help 查看全部命令）`, sourceMessageId, eventId, senderOpenId);
        return;
    }
    await processUserMessage({ chatId, sourceMessageId, senderOpenId, text, eventId });
}
/**
 * 解析飞书卡片回调中用户选择的值：下拉单选位于 event.action.option。
 * 兼容 string / 数组 / { value | option } 对象 / JSON 字符串等多种形态。
 */
function parseCallbackOption(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (Array.isArray(value)) {
        for (const entry of value) {
            const picked = parseCallbackOption(entry);
            if (picked) {
                return picked;
            }
        }
        return null;
    }
    if (typeof value === "object") {
        if ("value" in value) {
            return parseCallbackOption(value.value);
        }
        if ("option" in value) {
            return parseCallbackOption(value.option);
        }
        return null;
    }
    if (typeof value !== "string") {
        return null;
    }
    const text = value.trim();
    if (!text) {
        return null;
    }
    if (text.startsWith("{") || text.startsWith("[") || text.startsWith(String.fromCharCode(34))) {
        try {
            const parsed = JSON.parse(text);
            if (parsed !== value) {
                return parseCallbackOption(parsed);
            }
        }
        catch {
            // 普通字符串，按原值返回
        }
    }
    return text;
}

/**
 * 探测 opencode serve 端某会话是否正忙（带 6s 缓存）。
 * 先用 GET /session/status（毫秒级、权威）；不可用时退回旧的 SSE 订阅法（约 2.5s）。
 * true=正在运行 / false=空闲 / null=无法判定。
 */
async function probeServerBusy(sessionId, directory) {
    if (!sessionId) {
        return null;
    }
    const cached = busyProbeCache.get(sessionId);
    if (cached && Date.now() - cached.at < 6000) {
        return cached.state;
    }
    let state = null;
    try {
        const status = await (0, opencode_1.getOpenCodeSessionStatus)(sessionId, directory);
        if (status === "busy") {
            state = true;
        }
        else if (status === "idle") {
            state = false;
        }
    }
    catch (error) {
        state = null;
    }
    if (state === null) {
        try {
            state = await (0, opencode_1.isOpenCodeSessionBusy)(sessionId, directory);
        }
        catch (error) {
            state = null;
        }
    }
    if (state === true || state === false) {
        busyProbeCache.set(sessionId, { state, at: Date.now() });
    }
    else {
        busyProbeCache.delete(sessionId);
    }
    return state;
}
/** attach 命令里的主机名：serve 监听 0.0.0.0/:: 时本机应连 127.0.0.1 */
function attachHostOf(host) {
    const text = String(host ?? "").trim();
    if (!text || text === "0.0.0.0" || text === "::" || text === "[::]") {
        return "127.0.0.1";
    }
    return text;
}
/** shell 安全引用：POSIX 用单引号（内嵌单引号按 '"'"' 处理），Windows 用双引号（PowerShell/cmd 都认） */
function shellQuote(value) {
    return (0, opencode_exec_1.quoteShellArg)(value, process.platform);
}
/**
 * 生成"在本机终端 attach 到该会话"的 opencode CLI 命令。
 * 带上 --dir：opencode serve 的会话与事件流按目录隔离，缺了它可能定位不到同一会话。
 */
function buildAttachCommand(sessionId, directory) {
    const url = "http://" + attachHostOf(config_1.config.opencodeServeHost) + ":" + String(config_1.config.opencodeServePort);
    const parts = ["opencode", "attach", url];
    if (sessionId) {
        parts.push("-s", sessionId);
    }
    if (directory) {
        parts.push("--dir", shellQuote(directory));
    }
    return parts.join(" ");
}
/**
 * 生成 /status 报告：text 为正文，attach 为「本机终端 attach 到该会话」的命令。
 * 单独拆出来是为了让 /status 能把命令放进 code_block（原样、便于复制）。
 */
async function buildStatusReport(openId) {
    const lines = [];
    lines.push("📊 当前状态");
    lines.push("──────────────");
    const sessionId = sessionByUser.get(openId);
    const workdir = getCurrentWorkdir(openId);
    const selectedModel = modelByUser.get(openId) ?? config_1.config.opencodeModel;
    let sessionDir;
    if (sessionId) {
        lines.push(`会话 ID：${sessionId}`);
        try {
            const meta = await (0, opencode_1.getOpenCodeSessionByIdFromDb)(sessionId);
            if (meta) {
                const title = meta.title?.trim() ? meta.title.trim() : "(无标题)";
                sessionDir = meta.directory;
                lines.push(`标题：${title}`);
                const updatedAt = meta.updated ? new Date(meta.updated).toLocaleString("zh-CN", { hour12: false }) : "unknown";
                lines.push(`最近更新：${updatedAt}`);
            }
        }
        catch (error) {
            console.warn(`[status]: session_meta_failed open_id=${openId}`, error);
        }
        try {
            const latest = await (0, opencode_1.getOpenCodeSessionLatestModel)(sessionId);
            if (latest) {
                const hint = selectedModel && selectedModel !== latest.id ? `（实际使用：${latest.id}）` : "";
                lines.push(`模型：${selectedModel || latest.id}${hint}`);
            }
            else if (selectedModel) {
                lines.push(`模型：${selectedModel}（当前选择）`);
            }
        }
        catch (error) {
            console.warn(`[status]: session_model_failed open_id=${openId}`, error);
            if (selectedModel) {
                lines.push(`模型：${selectedModel}（当前选择）`);
            }
        }
    }
    else {
        lines.push("会话：未建立（下一条消息将新建）");
        if (selectedModel) {
            lines.push(`模型：${selectedModel}（当前选择）`);
        }
    }
    lines.push(`工作目录：${sessionDir || workdir || config_1.config.opencodeWorkdir}`);
    lines.push("──────────────");
    const queueState = userMessageQueues.get(openId);
    const pendingCount = queueState ? queueState.items.length : 0;
    const hasActive = Boolean(queueState?.activeItem);
    let runningDesc = hasActive ? "是（本地处理中）" : "否";
    if (!hasActive && sessionId) {
        try {
            const serverBusy = await probeServerBusy(sessionId, sessionDir || workdir || config_1.config.opencodeWorkdir);
            if (serverBusy === true) {
                runningDesc = "是（服务端仍在运行）";
            }
        }
        catch (error) {
            // 探测失败时按本地状态显示
        }
    }
    lines.push(`运行中任务：${runningDesc}｜队列待处理：${String(pendingCount)}`);
    const pending = pendingAsks.get(openId);
    if (pending) {
        lines.push(`挂起提问：${pending.kind}（${pending.requestID}）`);
    }
    lines.push(`OpenCode serve：${isOpenCodeReady ? "已就绪" : "未就绪"}（${config_1.config.opencodeServeHost}:${config_1.config.opencodeServePort}）`);
    lines.push(`默认工作目录：${config_1.config.opencodeWorkdir}`);
    const timeoutSec = Math.round((config_1.config.opencodeTimeout ?? 300000) / 1000);
    lines.push(`任务空闲超时：${String(timeoutSec)}s｜交互等待：10 分钟`);
    const attachDir = sessionDir || workdir || config_1.config.opencodeWorkdir;
    return {
        text: lines.join("\n"),
        attach: {
            command: buildAttachCommand(sessionId, attachDir),
            label: sessionId
                ? "🖥 本机 attach 本会话（复制下面这行到终端执行）"
                : "🖥 本机 attach opencode（当前未建立会话，attach 后可在 TUI 中选择或新建）"
        }
    };
}
/** /status 正文（纯文本；/session 恢复提示复用，不附 attach 脚本） */
async function buildStatusText(openId) {
    const report = await buildStatusReport(openId);
    return report.text;
}
/** 纯文本兜底：富文本被拒时把命令直接拼在正文后面 */
function buildStatusPlainText(report) {
    if (!report.attach || !report.attach.command) {
        return report.text;
    }
    return report.text + "\n" + report.attach.label + "\n" + report.attach.command;
}
/** 富文本 /status：正文 + attach 命令代码块 */
function buildStatusMessage(report) {
    if (!report.attach || !report.attach.command) {
        return report.text;
    }
    return {
        paragraphs: [
            [{ tag: "md", text: report.text }],
            [{ tag: "md", text: report.attach.label }],
            [{ tag: "code_block", language: "bash", text: report.attach.command }]
        ]
    };
}
function splitLinesByLength(lines, maxChars) {
    const chunks = [];
    let current = "";
    for (const line of lines) {
        const next = current ? `${current}\n${line}` : line;
        if (next.length <= maxChars) {
            current = next;
            continue;
        }
        if (current) {
            chunks.push(current);
            current = line;
            continue;
        }
        chunks.push(line);
    }
    if (current) {
        chunks.push(current);
    }
    return chunks;
}
function buildMarkdownContent(text) {
    return JSON.stringify({
        zh_cn: {
            title: "",
            content: [[{ tag: "md", text }]]
        }
    });
}
/**
 * 飞书 post 富文本内容：paragraphs 为段落数组（每段是标签数组）。
 * 除 md 外还支持 code_block 标签（原样展示、便于复制命令）。
 */
function buildRichContent(paragraphs) {
    return JSON.stringify({
        zh_cn: {
            title: "",
            content: paragraphs
        }
    });
}
async function replyText(chatId, text, replyToMessageId) {
    // text 传字符串走普通 md 消息；传 { paragraphs } 走富文本（可含 code_block）
    const content = typeof text === "string" ? buildMarkdownContent(text) : buildRichContent(text.paragraphs);
    if (replyToMessageId) {
        const result = await client.im.v1.message.reply({
            path: {
                message_id: replyToMessageId
            },
            data: {
                msg_type: "post",
                content
            }
        });
        return result.data?.message_id;
    }
    const result = await client.im.v1.message.create({
        params: {
            receive_id_type: "chat_id"
        },
        data: {
            receive_id: chatId,
            msg_type: "post",
            content
        }
    });
    return result.data?.message_id;
}
/** 表格渲染模式：table=卡片原生表格组件（默认）；markdown=整段塞进卡片 markdown；off=沿用 post 富文本 */
const TABLE_CARD_MODE = (() => {
    const raw = String(process.env.FEISHU_TABLE_CARD || "table").trim().toLowerCase();
    return raw === "off" || raw === "markdown" ? raw : "table";
})();
/**
 * 助手输出的消息体。
 * 飞书富文本 post 的 md 标签在移动端等客户端上不渲染 GFM 表格（表现为一整段带竖线的
 * 原文），实测卡片 markdown / 卡片原生 table 组件都能正常渲染表格，故含表格时改发卡片。
 * 没有表格时保持原来的 post，行为完全不变。
 */
function buildAssistantPayload(text) {
    const source = typeof text === "string" ? text : "";
    if (TABLE_CARD_MODE !== "off" && (0, table_card_1.hasMarkdownTable)(source)) {
        const preferred = TABLE_CARD_MODE === "markdown" ? "markdown" : "table";
        let card = (0, table_card_1.buildTableCard)(source, { mode: preferred });
        if (preferred === "table" && !(0, table_card_1.isCardWithinLimit)(card)) {
            // 表格太宽或内容太大：退回整段卡片 markdown，表格仍能渲染
            card = (0, table_card_1.buildTableCard)(source, { mode: "markdown" });
        }
        if ((0, table_card_1.isCardWithinLimit)(card)) {
            return { kind: "card", content: JSON.stringify(card) };
        }
        console.warn(`[feishu]: table_card_oversize chars=${String(source.length)}`);
    }
    return { kind: "post", content: buildMarkdownContent(source) };
}
async function createAssistantMessage(chatId, payload) {
    const result = await client.im.v1.message.create({
        params: {
            receive_id_type: "chat_id"
        },
        data: {
            receive_id: chatId,
            msg_type: payload.kind === "card" ? "interactive" : "post",
            content: payload.content
        }
    });
    return result?.data?.message_id;
}
async function patchCardMessage(messageId, content) {
    await client.im.v1.message.patch({
        path: {
            message_id: messageId
        },
        data: {
            content
        }
    });
}
/** 助手消息（飞书直发）：含表格走卡片、否则富文本；返回 { messageId, kind } */
async function safeReplyAssistant(chatId, text, eventId, openId, signal) {
    if (signal?.aborted) {
        return { messageId: undefined, kind: undefined };
    }
    const payload = buildAssistantPayload(text);
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (signal?.aborted) {
            return { messageId: undefined, kind: undefined };
        }
        try {
            const messageId = await withTimeout(createAssistantMessage(chatId, payload), `reply_${payload.kind} open_id=${openId ?? "unknown"}`);
            if (messageId) {
                return { messageId, kind: payload.kind };
            }
        }
        catch (error) {
            lastError = error;
        }
        if (attempt < 2) {
            console.log(`[feishu]: reply_retry open_id=${openId ?? "unknown"} event_id=${eventId ?? "unknown"} attempt=${attempt}`);
            await sleepMs(FEISHU_SEND_RETRY_DELAY_MS);
        }
    }
    if (signal?.aborted) {
        return { messageId: undefined, kind: undefined };
    }
    const errorCode = lastError && typeof lastError === "object" && "code" in lastError
        ? String(lastError.code ?? "unknown")
        : "unknown";
    console.error(`[feishu]: reply_failed open_id=${openId ?? "unknown"} event_id=${eventId ?? "unknown"} code=${errorCode}`, lastError ?? new Error("empty result"));
    return { messageId: undefined, kind: payload.kind };
}
/** 原地更新助手消息：卡片用 patch（编辑消息接口只支持 text/post），富文本用 update */
async function safeUpdateAssistant(messageId, kind, text, eventId, openId) {
    if (!messageId || !kind) {
        return false;
    }
    const payload = buildAssistantPayload(text);
    if (payload.kind !== kind) {
        // 阶段消息与最终内容的形态不一致（如阶段消息被截断）：交给调用方补发
        return false;
    }
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            if (kind === "card") {
                await withTimeout(patchCardMessage(messageId, payload.content), `patch ${messageId}`);
            }
            else {
                await withTimeout(updateTextMessage(messageId, text), `update ${messageId}`);
            }
            return true;
        }
        catch (error) {
            lastError = error;
        }
        if (attempt < 2) {
            console.log(`[feishu]: update_retry message_id=${messageId} attempt=${attempt}`);
            await sleepMs(FEISHU_SEND_RETRY_DELAY_MS);
        }
    }
    const errorCode = lastError && typeof lastError === "object" && "code" in lastError
        ? String(lastError.code ?? "unknown")
        : "unknown";
    console.error(`[feishu]: update_failed open_id=${openId ?? "unknown"} event_id=${eventId ?? "unknown"} message_id=${messageId} code=${errorCode}`, lastError ?? new Error("empty result"));
    return false;
}
/** 飞书 API 调用硬超时（毫秒）：防止个别请求永久挂起导致 per-user 队列卡死 */
const FEISHU_API_TIMEOUT_MS = 30000;
function withTimeout(promise, label) {
    return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => {
            console.error(`[feishu]: api_timeout ${label}`);
            resolve(undefined);
        }, FEISHU_API_TIMEOUT_MS))
    ]);
}
async function safeReplyText(chatId, text, replyToMessageId, eventId, openId, signal) {
    if (signal?.aborted) {
        return undefined;
    }
    let lastMessageId;
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (signal?.aborted) {
            return undefined;
        }
        try {
            const messageId = await withTimeout(replyText(chatId, text, replyToMessageId), `reply open_id=${openId ?? "unknown"}`);
            if (messageId) {
                return messageId;
            }
        }
        catch (error) {
            lastError = error;
        }
        if (attempt < 2) {
            console.log(`[feishu]: reply_retry open_id=${openId ?? "unknown"} event_id=${eventId ?? "unknown"} attempt=${attempt}`);
            await sleepMs(FEISHU_SEND_RETRY_DELAY_MS);
        }
    }
    if (signal?.aborted) {
        return undefined;
    }
    const errorCode = lastError && typeof lastError === "object" && "code" in lastError
        ? String(lastError.code ?? "unknown")
        : "unknown";
    console.error(`[feishu]: reply_failed open_id=${openId ?? "unknown"} event_id=${eventId ?? "unknown"} code=${errorCode}`, lastError ?? new Error("empty result"));
    return undefined;
}
async function updateTextMessage(messageId, text) {
    const content = buildMarkdownContent(text);
    await client.im.v1.message.update({
        path: {
            message_id: messageId
        },
        data: {
            msg_type: "post",
            content
        }
    });
}
async function safeUpdateTextMessage(messageId, text, eventId, openId, signal) {
    if (signal?.aborted) {
        return false;
    }
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (signal?.aborted) {
            return false;
        }
        try {
            await withTimeout(updateTextMessage(messageId, text), `update ${messageId}`);
            return true;
        }
        catch (error) {
            lastError = error;
        }
        if (attempt < 2) {
            console.log(`[feishu]: update_retry message_id=${messageId} attempt=${attempt}`);
            await sleepMs(FEISHU_SEND_RETRY_DELAY_MS);
        }
    }
    if (signal?.aborted) {
        return false;
    }
    const errorCode = lastError && typeof lastError === "object" && "code" in lastError
        ? String(lastError.code ?? "unknown")
        : "unknown";
    console.error(`[feishu]: update_failed open_id=${openId ?? "unknown"} event_id=${eventId ?? "unknown"} message_id=${messageId} code=${errorCode}`, lastError ?? new Error("empty result"));
    return false;
}
// 仅在“明确文件名词 + 发送动词”同时出现时才注入 feishu_send_file 提示；
async function processUserMessage(params) {
    const { chatId, sourceMessageId, senderOpenId, text, eventId, signal, touch } = params;
    if (signal?.aborted) {
        return;
    }
    const heartbeat = () => {
        if (typeof touch === "function") {
            touch();
        }
    };
    if (isMenuCommand(text)) {
        await sendMenuCard(chatId, senderOpenId);
        return;
    }
    // /m 数字兜底：菜单打开后 10 分钟内，回复编号等价于点击对应按钮（参考 dsh-im 数字兜底）。
    // 挂起提问的回答路由优先级更高；这里仅在无挂起提问且同一会话时生效。
    const menuNumberText = text.trim();
    const isMenuNumber = menuNumberText.length >= 1 && menuNumberText.length <= 2
        && Array.from(menuNumberText).every((ch) => ch >= "0" && ch <= "9");
    if (isMenuNumber) {
        const menuEntry = menuEntryByNumber(senderOpenId, chatId, menuNumberText);
        if (menuEntry) {
            console.log(`[menu]: number_fallback open_id=${senderOpenId} number=${menuNumberText} cmd=${menuEntry.cmd}`);
            await runMenuCommand({ chatId, sourceMessageId, senderOpenId, cmd: menuEntry.cmd, eventId });
            return;
        }
    }

    if (isHelpCommand(text)) {
        await safeReplyText(chatId, buildHelpGuide(), sourceMessageId, eventId, senderOpenId, signal);
        return;
    }
    const newCommand = parseNewCommand(text);
    if (text === RESET_COMMAND || newCommand.isNew) {
        if (text === RESET_COMMAND) {
            sessionByUser.delete(senderOpenId);
            modelByUser.delete(senderOpenId);
            workdirByUser.delete(senderOpenId);
            persistSessionState();
            syncWatchDirectories();
            await safeReplyText(chatId, "上下文已重置。接下来会开启新会话（默认工作目录）。", sourceMessageId, eventId, senderOpenId, signal);
            return;
        }
        if (!newCommand.workdir) {
            // /new（不带目录）：保留当前工作区，只开全新会话（/reset 才回默认目录）。
            // 从当前会话的真实目录回读并写回 workdirByUser，避免 workdirByUser 与真实目录失步导致 /new 落回默认目录。
            const attachedId = sessionByUser.get(senderOpenId);
            let keepWorkdir = getCurrentWorkdir(senderOpenId);
            if (attachedId) {
                try {
                    const meta = await (0, opencode_1.getOpenCodeSessionByIdFromDb)(attachedId);
                    if (meta && typeof meta.directory === "string" && meta.directory) {
                        const check = validateExistingWorkdir(meta.directory);
                        if (check.ok) {
                            keepWorkdir = check.workdir;
                            workdirByUser.set(senderOpenId, keepWorkdir);
                            rememberWorkdir(senderOpenId, keepWorkdir);
                        }
                    }
                }
                catch (error) {
                    console.warn(`[new]: read_session_dir_failed open_id=${senderOpenId} session=${attachedId}`, error);
                }
            }
            sessionByUser.delete(senderOpenId);
            persistSessionState();
            syncWatchDirectories();
            await safeReplyText(chatId, `上下文已重置。接下来会开启新会话（保留当前工作目录）。\n工作目录：${keepWorkdir}`, sourceMessageId, eventId, senderOpenId, signal);
            return;
        }
        const baseDirectory = getCurrentWorkdir(senderOpenId);
        const resolvedWorkdir = resolveWorkdirInput(newCommand.workdir, baseDirectory);
        if (!resolvedWorkdir.ok) {
            await safeReplyText(chatId, `处理失败：${resolvedWorkdir.reason}\n使用方式：/new <工作目录>`, sourceMessageId, eventId, senderOpenId, signal);
            return;
        }
        sessionByUser.delete(senderOpenId);
        workdirByUser.set(senderOpenId, resolvedWorkdir.workdir);
        rememberWorkdir(senderOpenId, resolvedWorkdir.workdir);
        persistSessionState();
        syncWatchDirectories();
        await safeReplyText(chatId, `上下文已重置。接下来会开启新会话。\n工作目录：${resolvedWorkdir.workdir}`, sourceMessageId, eventId, senderOpenId, signal);
        return;
    }
    const modelCommand = parseModelCommand(text);
    if (modelCommand.isModel) {
        if (!modelCommand.model) {
            const selectedModel = modelByUser.get(senderOpenId) ?? config_1.config.opencodeModel;
            const currentSessionId = sessionByUser.get(senderOpenId);
            if (currentSessionId) {
                try {
                    const latestModel = await (0, opencode_1.getOpenCodeSessionLatestModel)(currentSessionId);
                    if (latestModel) {
                        const selectedHint = selectedModel && selectedModel !== latestModel.id
                            ? `\n当前已选择模型：${selectedModel}`
                            : "";
                        await safeReplyText(chatId, `当前会话最近使用模型：${latestModel.id}${selectedHint}`, sourceMessageId, eventId, senderOpenId, signal);
                        return;
                    }
                }
                catch (error) {
                    console.warn(`[opencode]: fetch_session_model_failed open_id=${senderOpenId} session=${currentSessionId}`, error);
                }
            }
            if (selectedModel) {
                await safeReplyText(chatId, `当前已选择模型：${selectedModel}`, sourceMessageId, eventId, senderOpenId, signal);
                return;
            }
            await safeReplyText(chatId, "当前未指定模型（使用 OpenCode 默认模型）。", sourceMessageId, eventId, senderOpenId, signal);
            return;
        }
        let targetModel = String(modelCommand.model || "").trim();
        // 支持 /models 列表编号选择（与 /session 一致）
        if (/^\d+$/.test(targetModel)) {
            try {
                const modelListForPick = await (0, opencode_1.listOpenCodeModels)();
                const pickIndex = Number(targetModel) - 1;
                const picked = Number.isInteger(pickIndex) && pickIndex >= 0 && pickIndex < modelListForPick.length
                    ? modelListForPick[pickIndex]
                    : undefined;
                if (!picked) {
                    await safeReplyText(chatId, `编号无效（范围 1-${String(modelListForPick.length)}）。请先发 /models 查看列表。`, sourceMessageId, eventId, senderOpenId, signal);
                    return;
                }
                targetModel = picked.id;
            }
            catch (error) {
                console.warn(`[model]: pick_by_index_failed open_id=${senderOpenId}`, error);
                await safeReplyText(chatId, "查询模型列表失败，无法按编号切换；请改用 provider/model 格式（如 deepseek/deepseek-chat）。", sourceMessageId, eventId, senderOpenId, signal);
                return;
            }
        }
        if (targetModel.indexOf("/") < 0) {
            await safeReplyText(chatId, "模型格式应为 provider/model（如 deepseek/deepseek-chat）；或用编号：/model <编号>（先 /models 查看）。", sourceMessageId, eventId, senderOpenId, signal);
            return;
        }
        modelByUser.set(senderOpenId, targetModel);
        persistSessionState();
        await safeReplyText(chatId, `✅ 已切换模型：${targetModel}（自下一条消息起生效）`, sourceMessageId, eventId, senderOpenId, signal);
        return;
    }
    if (isSessionsCommand(text)) {
        try {
            const argText = text.trim().slice(SESSIONS_COMMAND.length).trim();
            const listBody = await listRecentSessionsText(false);
            const extra = argText
                ? "\n\n（/sessions 仅用于查看列表；切换会话请使用 /session <编号|session_id>）"
                : "";
            await safeReplyText(chatId, `${listBody}${extra}`, sourceMessageId, eventId, senderOpenId, signal);
        }
        catch (error) {
            const errorMessage = error instanceof Error && error.message ? error.message : "查询 session 失败，请稍后再试。";
            await safeReplyText(chatId, `处理失败：${errorMessage}`, sourceMessageId, eventId, senderOpenId, signal);
        }
        return;
    }
    const resume = parseResumeCommand(text);
    if (resume.isResume) {
        try {
            const sessions = await (0, opencode_1.listOpenCodeSessionsFromDb)(30);
            if (!resume.sessionId) {
                const attachedId = sessionByUser.get(senderOpenId);
                if (!attachedId) {
                    await safeReplyText(chatId, "当前未 attach 会话。用 /session <编号|session_id> 切换；/sessions 查看列表。", sourceMessageId, eventId, senderOpenId, signal);
                    return;
                }
                let titleText = "(无标题)";
                try {
                    const meta = await (0, opencode_1.getOpenCodeSessionByIdFromDb)(attachedId);
                    if (meta && meta.title?.trim()) {
                        titleText = meta.title.trim();
                    }
                }
                catch (error) {
                    // 标题查询失败不阻塞
                }
                await safeReplyText(chatId, `当前会话：${attachedId}\n标题：${titleText}`, sourceMessageId, eventId, senderOpenId, signal);
                return;
            }
            const resumeKey = resume.sessionId.trim();
            const indexMatch = /^\d+$/.test(resumeKey) ? Number(resumeKey) : NaN;
            const targetByIndex = Number.isInteger(indexMatch) && indexMatch >= 1 ? sessions[indexMatch - 1] : undefined;
            const target = targetByIndex ?? sessions.find((session) => session.id === resumeKey) ?? (await (0, opencode_1.getOpenCodeSessionByIdFromDb)(resumeKey));
            if (!target) {
                await safeReplyText(chatId, `未找到 session: ${resume.sessionId}\n请先发送 /session 查看可用会话。`, sourceMessageId, eventId, senderOpenId, signal);
                return;
            }
            const workdirCheck = validateExistingWorkdir(target.directory ?? "");
            if (!workdirCheck.ok) {
                await safeReplyText(chatId, `恢复失败：${workdirCheck.reason}\n未执行会话切换，请先处理目录问题后再重试。`, sourceMessageId, eventId, senderOpenId, signal);
                return;
            }
            sessionByUser.set(senderOpenId, target.id);
            workdirByUser.set(senderOpenId, workdirCheck.workdir);
            rememberWorkdir(senderOpenId, workdirCheck.workdir);
            syncWatchDirectories();
            persistSessionState();
            const title = target.title?.trim() ? target.title.trim() : "(无标题)";
            let busyNotice = "";
            try {
                const busy = await (0, opencode_1.isOpenCodeSessionBusy)(target.id, workdirCheck.workdir);
                if (busy === true) {
                    busyNotice = "\n⚠️ 该会话当前有任务正在运行，发送消息会排队，待其完成后再开始。";
                }
            }
            catch (error) {
                console.warn(`[session]: busy_probe_failed open_id=${senderOpenId} session=${target.id}`, error);
            }
            let resumedStatus;
            try {
                resumedStatus = await buildStatusText(senderOpenId);
            }
            catch (error) {
                console.warn(`[session]: resume_status_failed open_id=${senderOpenId}`, error);
                resumedStatus = `会话 ID：${target.id}\n标题：${title}`;
            }
            await safeReplyText(chatId, `🔀 已恢复会话\n\n${resumedStatus}${busyNotice}`, sourceMessageId, eventId, senderOpenId, signal);
            return;
        }
        catch (error) {
            const errorMessage = error instanceof Error && error.message ? error.message : "查询 session 失败，请稍后再试。";
            await safeReplyText(chatId, `处理失败：${errorMessage}`, sourceMessageId, eventId, senderOpenId, signal);
            return;
        }
    }
    if (isModelsCommand(text)) {
        try {
            const models = await (0, opencode_1.listOpenCodeModels)();
            if (models.length === 0) {
                await safeReplyText(chatId, "当前没有可用模型（可能尚未配置任何 provider 凭证）。", sourceMessageId, eventId, senderOpenId, signal);
                return;
            }
            // 识别"当前正在使用/已选定"的模型：
            // 优先级 = 用户已选择(modelByUser/默认) > 会话最近实际使用(DB)。
            // 切换的模型要到下一条消息才在服务端生效，故在界面上明确标注"待生效"。
            let sessionLatestModelId = null;
            const modelsSessionId = sessionByUser.get(senderOpenId);
            if (modelsSessionId) {
                try {
                    const latest = await (0, opencode_1.getOpenCodeSessionLatestModel)(modelsSessionId);
                    if (latest && latest.id) {
                        sessionLatestModelId = latest.id;
                    }
                }
                catch (error) {
                    console.warn(`[models]: fetch_active_failed open_id=${senderOpenId}`, error);
                }
            }
            const userSelectedModel = (modelByUser.get(senderOpenId) || config_1.config.opencodeModel || "").trim() || null;
            const activeModelId = userSelectedModel || sessionLatestModelId;
            const pendingSwitch = Boolean(userSelectedModel) && userSelectedModel !== sessionLatestModelId;
            const activeInList = activeModelId ? models.some((model) => model.id === activeModelId) : false;
            const lines = models.map((model, index) => {
                const marker = activeModelId && model.id === activeModelId
                    ? (pendingSwitch ? "  👈 已选择（下一条消息生效）" : "  👈 当前使用")
                    : "";
                return `${String(index + 1)}. ${model.id}${marker}`;
            });
            const chunks = splitLinesByLength(lines, 2800);
            for (let i = 0; i < chunks.length; i += 1) {
                if (signal?.aborted) {
                    return;
                }
                let extraNote = "";
                if (activeModelId && !activeInList) {
                    extraNote = `，当前模型 ${activeModelId}（不在列表中）`;
                }
                else if (pendingSwitch && sessionLatestModelId) {
                    extraNote = `，已选择 ${userSelectedModel}（下一条消息生效，最近实际使用 ${sessionLatestModelId}）`;
                }
                const baseTitle = `可用模型（共 ${String(models.length)} 个）`;
                const title = chunks.length === 1
                    ? `${baseTitle}${extraNote}：`
                    : `${baseTitle}，第 ${String(i + 1)}/${String(chunks.length)} 条：`;
                await safeReplyText(chatId, `${title}\n${chunks[i]}`, sourceMessageId, eventId, senderOpenId, signal);
            }
            return;
        }
        catch (error) {
            const errorMessage = error instanceof Error && error.message ? error.message : "查询模型失败，请稍后再试。";
            await safeReplyText(chatId, `处理失败：${errorMessage}`, sourceMessageId, eventId, senderOpenId, signal);
            return;
        }
    }
    const previousSessionId = sessionByUser.get(senderOpenId);
    const currentWorkdir = getCurrentWorkdir(senderOpenId);
    rememberWorkdir(senderOpenId, currentWorkdir);
    const currentModel = modelByUser.get(senderOpenId) ?? config_1.config.opencodeModel;
    currentBridgeContext = { chatId, senderOpenId, workdir: currentWorkdir, sessionId: previousSessionId };
    // ===== 统一单事件流模式（等价 opencode attach）：只做提交，执行/排队由 serve 管理 =====
    if (suppressForwardByOpenId.get(senderOpenId)) {
        suppressForwardByOpenId.delete(senderOpenId);
    }
    if (!signal?.aborted) {
        await safeReplyText(chatId, "📨 已提交 OpenCode，开始处理…", sourceMessageId, eventId, senderOpenId, signal);
    }
    try {
        const submitted = await (0, opencode_1.submitSessionMessage)({
            sessionId: previousSessionId,
            model: currentModel,
            workdir: currentWorkdir,
            message: text,
            onSessionCreated: (newSessionId) => {
                sessionByUser.set(senderOpenId, newSessionId);
                persistSessionState();
                syncWatchDirectories();
                console.log(`[opencode]: attach_early open_id=${senderOpenId} session=${newSessionId}`);
            }
        });
        const newSessionId = submitted.sessionId;
        if (previousSessionId !== newSessionId) {
            sessionByUser.set(senderOpenId, newSessionId);
            persistSessionState();
            syncWatchDirectories();
            console.log(`[opencode]: attach_new open_id=${senderOpenId} session=${newSessionId}`);
        }
        console.log(`[opencode]: submitted open_id=${senderOpenId} event_id=${eventId ?? "unknown"} session=${newSessionId}`);
    }
    catch (error) {
        if (signal?.aborted) {
            return;
        }
        // 工作区实例卡死（初始化阶段被中断后的典型症状）：自动重启 serve，并明确告知用户
        if (error && typeof error === "object" && error.code === "OPENCODE_INSTANCE_STUCK") {
            console.error(`[opencode]: instance_stuck open_id=${senderOpenId} session=${previousSessionId ?? "unknown"}`, error);
            const recovering = await recoverStuckWorkspaceInstance();
            await safeReplyText(chatId, recovering
                ? "⚠️ OpenCode 的工作区实例卡住了（通常是任务在初始化阶段被中断）。\n已自动重启 opencode serve，约 5-15 秒后请重新发送刚才的消息。"
                : "⚠️ OpenCode 的工作区实例卡住了（刚刚已自动恢复过一次）。\n请稍等片刻重发；若仍然没有响应，发送 /restart 手动恢复。", sourceMessageId, eventId, senderOpenId, signal);
            return;
        }
        // 新建会话却发送失败：把服务端已建立的会话 attach 回来，避免"有会话但桥不知道"
        if (error && typeof error === "object" && error.newSessionId && !previousSessionId) {
            sessionByUser.set(senderOpenId, error.newSessionId);
            persistSessionState();
            syncWatchDirectories();
            console.log(`[opencode]: attach_new_on_failure open_id=${senderOpenId} session=${error.newSessionId}`);
        }
        const errorMessage = error instanceof Error && error.message
            ? error.message
            : "调用 OpenCode 失败，请稍后重试。";
        const hint = error && typeof error === "object" && error.newSessionId && !previousSessionId
            ? `\n（会话已建立 ${error.newSessionId}，请重新发送该消息）`
            : "";
        console.error(`[opencode]: submit_failed open_id=${senderOpenId}`, error);
        await safeReplyText(chatId, `处理失败：${errorMessage}${hint}`, sourceMessageId, eventId, senderOpenId, signal);
    }
}
const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.recalled_v1": async (data) => {
        const eventId = data.event_id;
        const now = Date.now();
        cleanupHandledEvents(now);
        if (eventId && handledEvents.has(eventId)) {
            console.log(`[feishu]: skip duplicated event_id=${eventId}`);
            return;
        }
        if (eventId) {
            handledEvents.set(eventId, now);
        }
        const messageId = data.message_id;
        if (!messageId) {
            return;
        }
        // 消息撤回：任务统一由 opencode 管理，撤回不再中止运行（与 attach 一致）
        console.log(`[feishu]: recalled ignored event_id=${eventId ?? "unknown"} message_id=${messageId}`);
    },
    "im.message.receive_v1": async (data) => {
        const eventId = data.event_id;
        const now = Date.now();
        cleanupHandledEvents(now);
        if (eventId && handledEvents.has(eventId)) {
            console.log(`[feishu]: skip duplicated event_id=${eventId}`);
            return;
        }
        if (eventId) {
            handledEvents.set(eventId, now);
        }
        const senderType = data.sender?.sender_type;
        if (senderType !== "user") {
            return;
        }
        const senderOpenId = data.sender?.sender_id?.open_id;
        if (!senderOpenId) {
            return;
        }
        const chatId = data.message?.chat_id;
        if (!chatId) {
            return;
        }
        lastChatByOpenId.set(senderOpenId, chatId);
        persistSessionState();
        const sourceMessageId = data.message?.message_id;
        const messageType = data.message?.message_type;
        if (messageType !== "text") {
            await safeReplyText(chatId, "当前仅支持文本消息。", sourceMessageId, eventId, senderOpenId);
            return;
        }
        const text = parseTextContent(data.message.content);
        console.log(`[feishu]: receive open_id=${senderOpenId} event_id=${eventId ?? "unknown"} message_type=${messageType} text=${JSON.stringify(text)}`);
        if (!text) {
            await safeReplyText(chatId, "消息内容为空或格式不支持。", sourceMessageId, eventId, senderOpenId);
            return;
        }
        if (!allowAllOpenIds && !allowedOpenIds.has(senderOpenId)) {
            await safeReplyText(chatId, `当前用户未授权。你的 open_id：${senderOpenId}。请联系管理员将该 open_id 加入 allowedOpenId。`, sourceMessageId, eventId, senderOpenId);
            return;
        }
        // 本地控制命令（/stop /restart /status）统一由 handleControlCommand 处理
        if (await handleControlCommand({ chatId, sourceMessageId, senderOpenId, text, eventId })) {
            return;
        }

        // 任务内交互：若有挂起的 question/permission，先把本条消息当作回答路由过去
        // （内置命令优先，不被误路由为回答）
        let pending = pendingAsks.get(senderOpenId);
        // 防残留劫持：ask 已完结(settled)或所属任务已中止(runSignal aborted)却仍留在表中时，
        // 先清理，再把本条消息当作普通新任务处理（避免"无论发什么都回没看懂"）。
        if (pending && (pending.settled === true || pending.signal?.aborted === true)) {
            console.log(`[ask]: stale_cleared open_id=${senderOpenId} kind=${pending.kind} requestID=${pending.requestID} settled=${String(pending.settled === true)} aborted=${String(pending.signal?.aborted === true)}`);
            pendingAsks.delete(senderOpenId);
            pending = undefined;
        }
        if (pending && !isKnownCommand(text)) {
            console.log(`[feishu]: dispatch pending_ask open_id=${senderOpenId} event_id=${eventId ?? "unknown"} kind=${pending.kind} requestID=${pending.requestID}`);
            const handled = await routeTextToPendingAsk({ chatId, sourceMessageId, senderOpenId, eventId, text, pending });
            if (handled) {
                return;
            }
        }
        console.log(`[feishu]: dispatch submit open_id=${senderOpenId} event_id=${eventId ?? "unknown"}`);
        void processUserMessage({ chatId, sourceMessageId, senderOpenId, text, eventId });
    },
    "card.action.trigger": async (data) => {
        // 交互卡片按钮回调（需飞书后台订阅 card.action.trigger；未订阅时文本回复仍可用）
        try {
            const event = data?.event ?? data;
            const operatorOpenId = event?.operator?.open_id;
            let actionValue = event?.action?.value;
            // 卡片 JSON 2.0 的回传数据通常已是对象；兼容被序列化成 JSON 字符串的情况。
            if (typeof actionValue === "string" && actionValue.trim().startsWith("{")) {
                try {
                    actionValue = JSON.parse(actionValue);
                }
                catch {
                    // 解析失败则保持原值，后续按无效回传处理
                }
            }
            console.log(`[feishu]: card_action open_id=${operatorOpenId ?? "unknown"} value=${JSON.stringify(actionValue ?? null)}`);
            if (!operatorOpenId || !actionValue || typeof actionValue !== "object") {
                return;
            }
            // /m 菜单卡片按钮回调：value = { kind: "menu", cmd: "<命令>" }
            if (actionValue.kind === "menu" && typeof actionValue.cmd === "string") {
                const menuChatId = event?.context?.open_chat_id ?? lastChatByOpenId.get(operatorOpenId);
                if (!menuChatId) {
                    return;
                }
                lastChatByOpenId.set(operatorOpenId, menuChatId);
                if (!allowAllOpenIds && !allowedOpenIds.has(operatorOpenId)) {
                    await safeReplyText(menuChatId, `当前用户未授权。你的 open_id：${operatorOpenId}。请联系管理员将该 open_id 加入 allowedOpenId。`, undefined, data?.header?.event_id, operatorOpenId).catch(() => undefined);
                    return;
                }
                const menuCmd = actionValue.cmd.trim();
                const isKnownMenuCmd = interaction_1.MENU_ENTRIES.some((entry) => entry.cmd === menuCmd);
                if (!isKnownMenuCmd) {
                    await safeReplyText(menuChatId, "菜单操作无效或已过期，请回复 /m 重新打开菜单。", undefined, data?.header?.event_id, operatorOpenId).catch(() => undefined);
                    return;
                }
                console.log(`[feishu]: card_action menu open_id=${operatorOpenId} cmd=${menuCmd}`);
                void runMenuCommand({
                    chatId: menuChatId,
                    sourceMessageId: event?.context?.open_message_id,
                    senderOpenId: operatorOpenId,
                    cmd: menuCmd,
                    eventId: data?.header?.event_id
                }).catch((error) => {
                    console.error("[menu]: card_action_failed", error);
                });
                return;
            }
            // /m 菜单下拉选择回调：value = { kind: "pick", pick: "session"|"workdir"|"model" }，
            // 用户选中的值在 event.action.option（卡片 JSON 2.0 下拉单选）。
            if (actionValue.kind === "pick" && typeof actionValue.pick === "string") {
                const pickChatId = event?.context?.open_chat_id ?? lastChatByOpenId.get(operatorOpenId);
                if (!pickChatId) {
                    return;
                }
                lastChatByOpenId.set(operatorOpenId, pickChatId);
                if (!allowAllOpenIds && !allowedOpenIds.has(operatorOpenId)) {
                    await safeReplyText(pickChatId, `当前用户未授权。你的 open_id：${operatorOpenId}。请联系管理员将该 open_id 加入 allowedOpenId。`, undefined, data?.header?.event_id, operatorOpenId).catch(() => undefined);
                    return;
                }
                const selected = parseCallbackOption(event?.action?.option);
                if (!selected) {
                    await safeReplyText(pickChatId, "未获取到你的选择，请重新打开 /m 菜单再试。", undefined, data?.header?.event_id, operatorOpenId).catch(() => undefined);
                    return;
                }
                let pickCmd = null;
                if (actionValue.pick === "session") {
                    pickCmd = `${SESSION_COMMAND} ${selected}`;
                }
                else if (actionValue.pick === "workdir") {
                    pickCmd = `${NEW_COMMAND} ${selected}`;
                }
                else if (actionValue.pick === "model") {
                    pickCmd = `${MODEL_COMMAND} ${selected}`;
                }
                else {
                    return;
                }
                console.log(`[feishu]: card_action pick open_id=${operatorOpenId} pick=${actionValue.pick} selected=${selected}`);
                void runMenuCommand({
                    chatId: pickChatId,
                    sourceMessageId: event?.context?.open_message_id,
                    senderOpenId: operatorOpenId,
                    cmd: pickCmd,
                    eventId: data?.header?.event_id
                }).catch((error) => {
                    console.error("[menu]: card_action_pick_failed", error);
                });
                return;
            }

            const pending = pendingAsks.get(operatorOpenId);
            if (!pending) {
                await safeReplyText(event?.context?.open_chat_id ?? "", "该询问已处理或已超时，无需再操作。", undefined, data?.header?.event_id, operatorOpenId).catch(() => undefined);
                return;
            }
            if (pending.kind === "question" && actionValue.kind === "question") {
                const questions = pending.questions ?? [];
                const qIndex = Number(actionValue.q);
                const oIndex = Number(actionValue.o);
                if (Number.isInteger(qIndex) && qIndex >= 0 && qIndex < questions.length
                    && Number.isInteger(oIndex) && oIndex >= 0
                    && Array.isArray(questions[qIndex]?.options) && oIndex < questions[qIndex].options.length) {
                    const answers = questions.map((_, index) => (index === qIndex ? [questions[qIndex].options[oIndex].label] : [""]));
                    pending.finish({ answers });
                    const label = questions[qIndex].options[oIndex].label ?? "";
                    await safeReplyText(event?.context?.open_chat_id ?? "", `✅ 已收到你的选择：${label}`, undefined, data?.header?.event_id, operatorOpenId).catch(() => undefined);
                    return;
                }
            }
            if (pending.kind === "permission" && actionValue.kind === "permission") {
                const reply = actionValue.reply === "always" || actionValue.reply === "reject" ? actionValue.reply : "once";
                pending.finish({ reply });
                const label = reply === "always" ? "始终允许" : reply === "reject" ? "拒绝" : "允许一次";
                await safeReplyText(event?.context?.open_chat_id ?? "", `✅ 已收到你的授权决定：${label}`, undefined, data?.header?.event_id, operatorOpenId).catch(() => undefined);
                return;
            }
        }
        catch (error) {
            console.error("[feishu]: card_action_failed", error);
        }
    }
});
// ─── 桥本地 HTTP API（供 feishu-bridge MCP 转发调用） ─────────────
const BRIDGE_API_PORT = 4100;
let httpServer = null;
let currentBridgeContext = null;
const MAX_SEND_FILE_BYTES = 20 * 1024 * 1024;
function isPathWithin(root, candidate) {
    const r = (0, node_path_1.resolve)(root);
    const c = (0, node_path_1.resolve)(candidate);
    return c === r || c.startsWith(r.endsWith(node_path_1.sep) ? r : r + node_path_1.sep);
}
async function uploadAndSendFeishuFile(chatId, filePath) {
    const stats = (0, node_fs_1.statSync)(filePath);
    if (!stats.isFile()) {
        throw new Error("目标不是文件");
    }
    if (stats.size > MAX_SEND_FILE_BYTES) {
        throw new Error(`文件过大（>${Math.round(MAX_SEND_FILE_BYTES / 1024 / 1024)}MB）`);
    }
    const buffer = (0, node_fs_1.readFileSync)(filePath);
    const fileName = (0, node_path_1.basename)(filePath);
    const upload = await client.im.v1.file.create({
        data: { file_type: "stream", file_name: fileName, file: buffer }
    });
    // 该 SDK 版本 file.create 直接返回 {file_key}（部分版本为 {data:{file_key}}），两者都兼容
    const fileKey = upload?.file_key ?? upload?.data?.file_key;
    if (!fileKey) {
        throw new Error(`上传飞书失败：未取到 file_key（响应：${JSON.stringify(upload ?? null).slice(0, 200)}）`);
    }
    await client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "file", content: JSON.stringify({ file_key: fileKey }) }
    });
    return { fileName, bytes: stats.size };
}
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
            if (!raw) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            }
            catch (error) {
                reject(error);
            }
        });
        req.on("error", reject);
    });
}
async function handleBridgeHttp(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const sendJson = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
    };
    try {
        if (req.method === "GET" && url.pathname === "/bridge/context") {
            return sendJson(200, { ok: true, context: currentBridgeContext });
        }
        if (req.method === "POST" && url.pathname === "/bridge/send-file") {
            const body = await readJsonBody(req);
            const filePath = typeof body.path === "string" ? body.path.trim() : "";
            if (!filePath) {
                return sendJson(400, { ok: false, error: "缺少 path 参数" });
            }
            const ctx = currentBridgeContext;
            if (!ctx || !ctx.chatId) {
                return sendJson(409, { ok: false, error: "当前没有活动的飞书会话上下文（需在任务运行中调用）" });
            }
            const allowedRoot = ctx.workdir || config_1.config.opencodeWorkdir;
            if (!isPathWithin(allowedRoot, filePath)) {
                return sendJson(403, { ok: false, error: `仅允许发送工作目录内文件：${allowedRoot}` });
            }
            if (!(0, node_fs_1.existsSync)(filePath)) {
                return sendJson(404, { ok: false, error: `文件不存在：${filePath}` });
            }
            const info = await uploadAndSendFeishuFile(ctx.chatId, filePath);
            console.log(`[bridge-mcp]: file_sent chat=${ctx.chatId} file=${filePath} bytes=${String(info.bytes)}`);
            return sendJson(200, { ok: true, fileName: info.fileName, bytes: info.bytes });
        }
        return sendJson(404, { ok: false, error: "not found" });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "internal error";
        console.error("[bridge-mcp]: http_error", error);
        return sendJson(500, { ok: false, error: message });
    }
}
// ─── 被动监听：外部客户端(SSH attach)在当前会话上的任务进展转发到飞书 ──
/** 已在其它端回填(外部已答)的提问 id；bridge 端不再迟到 reply/reject */
const externalAnsweredQuestionIds = new Set();
/**
 * 若某会话的提问/授权在桥端挂起，先用 GET /question、/permission 与服务端"对账"：
 * 服务端已无该提问（= 已在其它端被回答/处理）才撤销卡片；服务端仍挂起则保留
 * （避免"还没作答就被误撤"——opencode 同一步骤的进度事件也会到达，不代表问题已在他端回答）。
 * 网络/服务错误时无法确认，一律不撤销（宁可等待超时，也不误杀真实提问）。
 */
const pendingProbeCache = { sessionId: null, at: 0, items: null };
const PENDING_PROBE_TTL_MS = 1500;
async function cancelDanglingAsks(sessionId) {
    const attachedOpenIds = [];
    for (const [oid, sid] of sessionByUser.entries()) {
        if (sid === sessionId) {
            attachedOpenIds.push(oid);
        }
    }
    if (attachedOpenIds.length === 0) {
        return;
    }
    let hasPending = false;
    for (const oid of attachedOpenIds) {
        const entry = pendingAsks.get(oid);
        if (entry && entry.settled !== true && entry.sessionID === sessionId) {
            hasPending = true;
        }
    }
    if (!hasPending) {
        return;
    }
    let items = pendingProbeCache.items;
    if (pendingProbeCache.sessionId !== sessionId || Date.now() - pendingProbeCache.at > PENDING_PROBE_TTL_MS) {
        try {
            const firstOid = attachedOpenIds[0];
            const directory = workdirByUser.get(firstOid) || config_1.config.opencodeWorkdir;
            items = await (0, opencode_1.listOpenCodePendingQuestions)(directory);
        }
        catch (error) {
            console.error(`[watch]: pending_probe_failed session=${sessionId}`, error);
            return;
        }
        pendingProbeCache = { sessionId, at: Date.now(), items };
    }
    const pendingSet = new Set((items || []).map((item) => item.id));
    for (const oid of attachedOpenIds) {
        const entry = pendingAsks.get(oid);
        if (!entry || entry.settled === true || entry.sessionID !== sessionId) {
            continue;
        }
        if (pendingSet.has(entry.requestID)) {
            console.log(`[watch]: dangling_ask_still_pending open_id=${oid} kind=${entry.kind} requestID=${entry.requestID}`);
            continue;
        }
        externalAnsweredQuestionIds.add(entry.requestID);
        entry.finish(null);
        const chatId = lastChatByOpenId.get(oid);
        if (chatId) {
            void safeReplyText(chatId, "ℹ️ 该提问已在其它端回答，本卡片已撤销。", undefined, undefined, oid).catch(() => undefined);
        }
        console.log(`[watch]: dangling_ask_cancelled open_id=${oid} kind=${entry.kind} requestID=${entry.requestID}`);
    }
}
/** 阶段消息缓冲窗口：任务在该窗口内到达 idle（典型单轮快答）则不发送中间态，只发最终消息 */
const PHASE_DEBOUNCE_MS = 3000;

async function handlePassiveOpenCodeEvent(event) {
    if (!event || typeof event !== "object") {
        return;
    }
    const props = event.properties ?? {};
    const sessionId = props.sessionID;
    if (!sessionId) {
        return;
    }
    // 找到所有 attach 到该会话的用户（多用户各自分发）
    const attachedOpenIds = [];
    for (const [oid, sid] of sessionByUser.entries()) {
        if (sid === sessionId) {
            attachedOpenIds.push(oid);
        }
    }
    if (attachedOpenIds.length === 0) {
        return;
    }
    const getChatOf = (oid) => lastChatByOpenId.get(oid);
    const isSuppressed = (oid) => suppressForwardByOpenId.get(oid) === true;
    // 若该会话还有"桥端挂起且未回填"的提问，而此刻又来了新的业务进展事件，
    // 说明问题已在其它客户端(如 SSH attach)回答、模型已继续 → 提前撤卡，避免 10 分钟悬挂。
    await cancelDanglingAsks(sessionId);
    // 任务内交互：question / permission（无论飞书发起还是外部 attach 发起）
    if (event.type === "question.asked" && props.id) {
        for (const oid of attachedOpenIds) {
            const chatId = getChatOf(oid);
            if (!chatId) {
                continue;
            }
            const askHandler = createAskHandler({ chatId, sourceMessageId: undefined, senderOpenId: oid, eventId: undefined, signal: undefined });
            const answer = await askHandler({
                kind: "question",
                requestID: props.id,
                sessionID: sessionId,
                questions: props.questions ?? []
            }, undefined);
            try {
                if (answer && Array.isArray(answer.answers)) {
                    await (0, opencode_1.replySessionQuestion)(props.id, answer.answers, getCurrentWorkdir(oid));
                }
                else if (externalAnsweredQuestionIds.has(props.id)) {
                    // 已在其它端回填：不再迟到 reject
                    externalAnsweredQuestionIds.delete(props.id);
                }
                else {
                    await (0, opencode_1.rejectSessionQuestion)(props.id, getCurrentWorkdir(oid));
                }
            }
            catch (error) {
                console.error(`[watch]: question_reply_failed open_id=${oid}`, error);
            }
        }
        return;
    }
    if (event.type === "permission.asked" && props.id) {
        for (const oid of attachedOpenIds) {
            const chatId = getChatOf(oid);
            if (!chatId) {
                continue;
            }
            const askHandler = createAskHandler({ chatId, sourceMessageId: undefined, senderOpenId: oid, eventId: undefined, signal: undefined });
            const decision = await askHandler({
                kind: "permission",
                requestID: props.id,
                sessionID: sessionId,
                permission: props.permission,
                patterns: props.patterns ?? []
            }, undefined);
            try {
                if (!decision && externalAnsweredQuestionIds.has(props.id)) {
                    // 已在其它端处理：不再迟到回填
                    externalAnsweredQuestionIds.delete(props.id);
                    return;
                }
                const replyBody = decision && decision.reply
                    ? { reply: decision.reply, ...(decision.message ? { message: decision.message } : {}) }
                    : { reply: "reject" };
                await (0, opencode_1.replySessionPermission)(props.id, replyBody, getCurrentWorkdir(oid));
            }
            catch (error) {
                console.error(`[watch]: permission_reply_failed open_id=${oid}`, error);
            }
        }
        return;
    }
    let st = passiveSessionState.get(sessionId);
    if (!st) {
        st = { texts: new Map(), tools: new Set(), users: new Map(), lastActivityAt: Date.now(), silenceTimer: null, armTimer: null };
        passiveSessionState.set(sessionId, st);
    }
    const armSilence = () => {
        if (st.armTimer) {
            clearTimeout(st.armTimer);
        }
        st.lastActivityAt = Date.now();
        st.armTimer = setTimeout(() => {
            if (!passiveSessionState.has(sessionId)) {
                return;
            }
            const minutes = Math.max(1, Math.round((config_1.config.opencodeTimeoutMs ?? 600000) / 60000));
            for (const oid of attachedOpenIds) {
                const chatId = getChatOf(oid);
                if (!chatId || isSuppressed(oid)) {
                    continue;
                }
                void safeReplyText(chatId, `⏳ 该会话已约 ${String(minutes)} 分钟无新输出，仍在等待（不中断）；若确认卡死可发 /esc 中断、/stop 停止转发或 /restart 重启。`, undefined, undefined, oid).catch(() => undefined);
            }
            armSilence();
        }, config_1.config.opencodeTimeoutMs ?? 600000);
    };
    if (event.type === "session.status" && props.status?.type === "idle") {
        if (st.armTimer) {
            clearTimeout(st.armTimer);
            st.armTimer = null;
        }
        // 刚被 /esc 中断：本轮收尾文案用「已中断」，不要误导成正常完成
        const abortedAt = abortedByUserSessions.get(sessionId);
        const wasAbortedByUser = typeof abortedAt === "number" && Date.now() - abortedAt < ABORTED_NOTICE_TTL_MS;
        if (abortedAt !== undefined) {
            abortedByUserSessions.delete(sessionId);
        }
        const finalHead = wasAbortedByUser ? "⏹ 任务已中断" : "✅ 任务完成";
        // 会话空闲：所有工具调用都已结束，清空追踪避免残留
        runningToolCalls.clear();
        for (const [oid, u] of st.users.entries()) {
            const chatId = getChatOf(oid);
            if (!chatId) {
                continue;
            }
            if (u.published > 0) {
                if (u.flushTimer) {
                    clearTimeout(u.flushTimer);
                    u.flushTimer = null;
                }
                u.pending = null;
                const finalContent = u.lastContent || "";
                const finalBody = finalContent ? `${finalHead}\n\n${finalContent}` : finalHead;
                try {
                    if (u.lastPhaseMessageId) {
                        const updated = await safeUpdateAssistant(u.lastPhaseMessageId, u.lastPhaseKind, finalBody, undefined, oid);
                        if (!updated) {
                            // 原地更新失败（如消息更新接口超时/受限）：补发最终消息，避免界面只停留在"任务持续中"
                            await safeReplyAssistant(chatId, finalBody, undefined, oid);
                        }
                    }
                    else {
                        await safeReplyAssistant(chatId, finalBody, undefined, oid);
                    }
                }
                catch (error) {
                    console.error(`[watch]: final_update_failed open_id=${oid}`, error);
                }
            }
        }
        passiveSessionState.delete(sessionId);
        return;
    }
    if (event.type !== "message.part.updated") {
        return;
    }
    armSilence();
    const part = props.part ?? {};
    const partType = part?.type;
    if (partType === "text") {
        if (part?.text) {
            st.texts.set(part.messageID, part.text);
        }
        return;
    }
    if (partType === "tool") {
        const toolName = part?.tool;
        if (toolName) {
            st.tools.add(toolName);
        }
        trackRunningToolPart(part);
        return;
    }
    if (partType === "step-finish") {
        const content = st.texts.get(part.messageID) ? st.texts.get(part.messageID).trim() : "";
        for (const oid of attachedOpenIds) {
            const chatId = getChatOf(oid);
            if (!chatId) {
                continue;
            }
            if (isSuppressed(oid)) {
                continue;
            }
            let u = st.users.get(oid);
            if (!u) {
                u = { phaseCounter: 0, published: 0, lastContent: "", lastPhaseMessageId: undefined, lastPhaseKind: undefined, pending: null, flushTimer: null };
                st.users.set(oid, u);
            }
            if (!content || content === u.lastContent) {
                continue;
            }
            u.lastContent = content;
            u.published += 1;
            u.phaseCounter += 1;
            const toolsSnapshot = Array.from(st.tools || []);
            st.tools.clear();
            const toolsNote = toolsSnapshot.length > 0
                ? `（已调用工具：${toolsSnapshot.join("、")}${toolsSnapshot.length > 4 ? " 等" : ""}）`
                : "";
            const maxLen = 3000;
            const trimmed = content.length > maxLen ? `${content.slice(0, maxLen)}…` : content;
            // 阶段消息缓冲：窗口内到达 idle（典型单轮快答）则不发送中间态，只发一条最终消息
            u.pending = { trimmed, toolsNote };
            if (u.flushTimer) {
                clearTimeout(u.flushTimer);
            }
            u.flushTimer = setTimeout(() => {
                u.flushTimer = null;
                if (u.pending && passiveSessionState.get(sessionId) === st) {
                    const pending = u.pending;
                    u.pending = null;
                    void (async () => {
                        try {
                            const sent = await safeReplyAssistant(chatId, `⏳ 任务持续中${pending.toolsNote}\n\n${pending.trimmed}`, undefined, oid);
                            if (sent.messageId) {
                                u.lastPhaseMessageId = sent.messageId;
                                u.lastPhaseKind = sent.kind;
                            }
                            console.log(`[watch]: phase open_id=${oid} session=${sessionId} stage=${String(u.phaseCounter)}`);
                        }
                        catch (error) {
                            console.error(`[watch]: phase_failed open_id=${oid}`, error);
                        }
                    })();
                }
            }, PHASE_DEBOUNCE_MS);
        }
        st.texts.delete(part.messageID);
        return;
    }
}
function startPassiveWatcher() {
    if (passiveWatcherAbort) {
        return;
    }
    passiveWatcherAbort = new AbortController();
    void (0, opencode_1.watchOpenCodeEvents)((event) => {
        void handlePassiveOpenCodeEvent(event).catch((error) => {
            console.error("[watch]: passive_event_failed", error);
        });
    }, passiveWatcherAbort.signal);
    console.log("[watch]: passive watcher started");
}
function stopPassiveWatcher() {
    if (passiveWatcherAbort) {
        passiveWatcherAbort.abort();
        passiveWatcherAbort = null;
    }
}
function startBridgeHttpServer() {
    httpServer = (0, node_http_1.createServer)(handleBridgeHttp);
    httpServer.listen(BRIDGE_API_PORT, "127.0.0.1", () => {
        console.log(`[bridge-mcp]: http api listening on 127.0.0.1:${String(BRIDGE_API_PORT)}`);
    });
    httpServer.on("error", (error) => {
        console.error("[bridge-mcp]: http server error", error);
    });
}
/** 读取可选的看门狗阈值环境变量（未设置或非法时返回 undefined，由 opencode.js 用默认值） */
function watchdogEnvNumber(name) {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}
/** serve 看门狗开关：默认开启；设置 OPENCODE_SERVE_WATCHDOG=off/0/false/no 可关闭 */
function startServeWatchdogIfEnabled() {
    const flag = String(process.env.OPENCODE_SERVE_WATCHDOG ?? "").trim().toLowerCase();
    if (flag === "off" || flag === "0" || flag === "false" || flag === "no") {
        console.log("[watchdog]: 已通过 OPENCODE_SERVE_WATCHDOG 关闭");
        return;
    }
    (0, opencode_1.startServeWatchdog)({
        intervalMs: watchdogEnvNumber("OPENCODE_WATCHDOG_INTERVAL_MS"),
        failThreshold: watchdogEnvNumber("OPENCODE_WATCHDOG_FAIL_THRESHOLD"),
        toolGraceMs: watchdogEnvNumber("OPENCODE_WATCHDOG_TOOL_GRACE_MS"),
        dailyRestartTime: process.env.OPENCODE_DAILY_RESTART,
        dailyRestartWindowMs: watchdogEnvNumber("OPENCODE_DAILY_RESTART_WINDOW_MS"),
        getRunningTool: getRunningToolInfo,
        isBusy: isAnyTaskRunning,
        onEvent: handleServeWatchdogEvent
    });
}
/** 每日定时重启是否推送飞书通知（默认关闭：凌晨的例行重启不该打扰用户） */
function isDailyRestartNotifyEnabled() {
    const flag = String(process.env.OPENCODE_DAILY_RESTART_NOTIFY ?? "").trim().toLowerCase();
    return flag === "on" || flag === "1" || flag === "true" || flag === "yes";
}
/** 看门狗事件：日志 + 飞书预告（重启期间服务不可用，先告知受影响用户） */
function handleServeWatchdogEvent(info) {
    if (info.type === "restart") {
        const scheduled = info.reason === "scheduled";
        if (scheduled) {
            console.log(`[watchdog]: 每日定时重启 opencode serve（${String(info.at ?? "")}，当前无任务在跑）`);
        }
        else {
            const runningNote = info.runningTool ? `（卡死前运行中的工具：${info.runningTool}）` : "";
            console.error(`[watchdog]: 判定 opencode serve 卡死，开始重启 restarts=${String(info.restarts)}${runningNote}`);
        }
        // 卡死重启会打断任务，必须通知；定时重启默认静默
        if (!scheduled || isDailyRestartNotifyEnabled()) {
            const text = scheduled
                ? `🔄 已按计划（每日 ${String(info.at ?? "")}）重启 opencode serve：当时没有任务在运行，会话与历史不受影响。`
                : "🔄 检测到 opencode 无响应（心跳连续超时），已自动重启 serve。\n会话与历史不受影响；刚才进行中的那一轮任务可能已丢失，重新发消息即可继续。";
            const seenChats = new Set();
            const openIds = new Set([...sessionByUser.keys(), ...lastChatByOpenId.keys()]);
            for (const openId of openIds) {
                const chatId = lastChatByOpenId.get(openId);
                if (!chatId || seenChats.has(chatId)) {
                    continue;
                }
                seenChats.add(chatId);
                void safeReplyText(chatId, text, undefined, undefined, openId).catch(() => undefined);
            }
        }
    }
    else if (info.type === "restarted") {
        const suffix = info.reason === "scheduled" ? "（每日定时）" : "";
        console.log(`[watchdog]: serve 重启完成 restarts=${String(info.restarts)}${suffix}`);
    }
    else if (info.type === "daily_skipped") {
        console.log(`[watchdog]: 今日定时重启跳过（${String(info.reason)}，计划 ${String(info.at ?? "")}）`);
    }
}
async function bootstrap() {
    await wsClient.start({ eventDispatcher });
    console.log("[bootstrap]: 飞书长连接已启动，等待消息...");
    opencodeReadyPromise = (0, opencode_1.initOpenCodeServe)({
        hostname: config_1.config.opencodeServeHost,
        port: config_1.config.opencodeServePort
    });
    await opencodeReadyPromise;
    isOpenCodeReady = true;
    console.log("[bootstrap]: OpenCode 已就绪，开始处理队列与新消息...");
    startBridgeHttpServer();
    startPassiveWatcher();
    startServeWatchdogIfEnabled();
}
bootstrap().catch((error) => {
    console.error("启动失败:", error);
    process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
        wsClient.close();
        if (httpServer) {
            try {
                httpServer.close();
            }
            catch (error) {
                // 忽略关闭错误
            }
        }
        stopPassiveWatcher();
        (0, opencode_1.stopServeWatchdog)();
        await (0, opencode_1.stopOpenCodeServe)();
        process.exit(0);
    });
}
