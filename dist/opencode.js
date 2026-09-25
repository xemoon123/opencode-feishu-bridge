"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAbortError = isAbortError;
exports.initOpenCodeServe = initOpenCodeServe;
exports.stopOpenCodeServe = stopOpenCodeServe;
exports.listOpenCodeSessionsFromDb = listOpenCodeSessionsFromDb;
exports.getOpenCodeSessionByIdFromDb = getOpenCodeSessionByIdFromDb;
exports.listOpenCodeModels = listOpenCodeModels;
exports.getOpenCodeSessionLatestModel = getOpenCodeSessionLatestModel;
exports.isOpenCodeSessionBusy = isOpenCodeSessionBusy;
exports.watchOpenCodeEvents = watchOpenCodeEvents;
exports.setWatchWorkDirectories = setWatchWorkDirectories;
exports.submitSessionMessage = submitSessionMessage;
exports.replySessionQuestion = replySessionQuestion;
exports.rejectSessionQuestion = rejectSessionQuestion;
exports.replySessionPermission = replySessionPermission;
exports.listOpenCodePendingQuestions = listOpenCodePendingQuestions;
exports.startServeWatchdog = startServeWatchdog;
exports.stopServeWatchdog = stopServeWatchdog;
exports.isServeWatchdogRunning = isServeWatchdogRunning;
exports.abortOpenCodeSession = abortOpenCodeSession;
exports.getOpenCodeSessionStatus = getOpenCodeSessionStatus;
exports.restartOpenCodeServe = restartOpenCodeServe;
const node_child_process_1 = require("node:child_process");
const opencode_exec_1 = require("./opencode-exec");
const config_1 = require("./config");
const undici_1 = require("undici");
// 关闭 undici 默认的 headers/body 超时（默认各 300s）：
// 长任务下 opencode serve 可能到任务收尾才回响应头，默认超时会误杀健康会话（HeadersTimeoutError→fetch failed）。
// 超时统一交给 runCtrl 的空闲检测：持续有事件输出就重置，仅长时间无任何输出才中止。
undici_1.setGlobalDispatcher(new undici_1.Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 10000 }));
const OPENCODE_ABORT_ERROR = "OPENCODE_ABORT_ERROR";
/**
 * opencode 工作区实例卡死：实例初始化尚未完成时被中断，之后该目录的所有 prompt 都会被
 * 瞬间 abort（十几毫秒返回 MessageAbortedError，模型根本没被调用）。只能重启 serve 恢复。
 */
const OPENCODE_INSTANCE_STUCK = "OPENCODE_INSTANCE_STUCK";
/** 判定「瞬间被中止」的阈值：真实任务不可能在 1.5s 内结束，人工 /esc 也来不及这么快 */
const INSTANCE_STUCK_ABORT_MS = 1500;
const OPENCODE_DEFAULT_WORKDIR = config_1.config.opencodeWorkdir;
/**
 * 会话级 permission 规则：显式放行 question 工具（模型才能向用户提问，由飞书桥中转），
 * 并保留 opencode run 非交互模式的 plan 限制。
 * 注意：PATCH /session 的 permission 是追加语义，evaluate 用 findLast，
 * 所以 question:allow 追加在历史 question:deny 之后即可覆盖（用于恢复老会话）。
 */
const SESSION_PERMISSION_RULES = [
    { permission: "question", action: "allow", pattern: "*" },
    { permission: "plan_enter", action: "deny", pattern: "*" },
    { permission: "plan_exit", action: "deny", pattern: "*" }
];
/** 恢复会话时，仅当缺少 question 放行规则才追加（避免 permission 数组无限增长）。 */
const QUESTION_ALLOW_RULE = { permission: "question", action: "allow", pattern: "*" };
function createAbortError() {
    const error = new Error("OpenCode 请求已取消。");
    error.code = OPENCODE_ABORT_ERROR;
    return error;
}
function isAbortError(error) {
    if (!error || typeof error !== "object") {
        return false;
    }
    return error.code === OPENCODE_ABORT_ERROR;
}
let serveProcess = null;
let serveStartPromise = null;
let currentServeConfig = null;
function buildServeUrl(config) {
    return `http://${config.hostname}:${config.port}`;
}
/**
 * 启动 opencode serve 进程（HTTP API 底座）。
 * 后续所有会话、事件、question/permission 交互都直连该服务，
 * 不再依赖 `opencode run` 子进程（其非交互模式会 deny question 工具）。
 */
async function initOpenCodeServe(config) {
    currentServeConfig = config;
    if (serveProcess && !serveProcess.killed) {
        return;
    }
    if (serveStartPromise) {
        await serveStartPromise;
        return;
    }
    serveStartPromise = startServeProcess(config);
    await serveStartPromise;
}
async function stopOpenCodeServe() {
    if (!serveProcess || serveProcess.killed) {
        return;
    }
    const processToStop = serveProcess;
    // Windows 无信号语义且可能是 cmd.exe 垫片：由 terminateChild 走 taskkill /T /F 结束进程树
    await (0, opencode_exec_1.terminateChild)(processToStop);
}
async function startServeProcess(config) {
    const args = [
        "serve",
        "--hostname",
        config.hostname,
        "--port",
        String(config.port)
    ];
    const { child, plan } = (0, opencode_exec_1.spawnOpenCode)(args, {
        cwd: OPENCODE_DEFAULT_WORKDIR,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
    });
    serveProcess = child;
    const prefix = `[opencode-serve ${config.hostname}:${config.port}]`;
    console.log(`${prefix}: launch kind=${plan.kind} source=${plan.source}`);
    child.stdout.on("data", (chunk) => {
        const message = chunk.toString("utf8").trim();
        if (message) {
            console.log(`${prefix}: ${message}`);
        }
    });
    child.stderr.on("data", (chunk) => {
        const message = chunk.toString("utf8").trim();
        if (message) {
            console.error(`${prefix}: ${message}`);
        }
    });
    child.once("exit", (code, signal) => {
        console.error(`${prefix}: exited code=${String(code)} signal=${signal ?? "none"}`);
        if (serveProcess === child) {
            serveProcess = null;
            serveStartPromise = null;
        }
    });
    child.once("error", (error) => {
        console.error(`${prefix}: failed`, error);
    });
    try {
        await waitForServeReady(config);
        console.log(`${prefix}: ready`);
    }
    catch (error) {
        await (0, opencode_exec_1.terminateChild)(child, { graceMs: 3000 });
        serveProcess = null;
        serveStartPromise = null;
        throw error;
    }
}
async function waitForServeReady(config) {
    const base = buildServeUrl(config);
    const maxAttempts = 40;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const probe = await ocFetch(base, "/session", {
                method: "GET",
                directory: OPENCODE_DEFAULT_WORKDIR
            });
            if (probe.status === 200) {
                return;
            }
        }
        catch {
            // 服务未就绪，继续等待
        }
        await sleep(300);
    }
    throw new Error("OpenCode serve 启动超时，请检查本地端口或模型配置。");
}
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
// ─── serve 看门狗：心跳连续失败时自动重启卡死的 opencode serve ──────────────
/**
 * 判定策略（避免误杀合法长任务）：
 *   - 每 intervalMs 探测一次 GET /session，超时 probeTimeoutMs 记为一次失败；
 *   - 连续失败达到 failThreshold 次（约 3 分钟无任何响应）才考虑重启；
 *   - 若 SSE 事件流显示有工具调用（如 deveco 构建）仍在运行且未超过 toolGraceMs，
 *     则视为合法长任务，跳过本轮并清零计数；
 *   - 其余情况判定为卡死：SIGTERM（5s 后 SIGKILL）重启，并重建 SSE 订阅。
 * 另有每日定时重启（默认 03:00）：到点且当前没有任务在跑时主动重启一次，
 * 用于定期回收 serve 长跑累积的内存/文件句柄；忙碌时只在等待窗口内空转，绝不打断任务。
 */
const WATCHDOG_INTERVAL_MS = 30000;
const WATCHDOG_PROBE_TIMEOUT_MS = 8000;
const WATCHDOG_FAIL_THRESHOLD = 6;
const WATCHDOG_TOOL_GRACE_MS = 30 * 60 * 1000;
/** 每日定时重启的目标时间（本地时间 "HH:MM"，默认凌晨 3 点；off/0/false/no 表示关闭） */
const WATCHDOG_DAILY_RESTART_TIME = "03:00";
/** 到点时仍在忙的等待窗口：窗口内等到空闲就重启，超出窗口则放弃当天（不打断任务） */
const WATCHDOG_DAILY_RESTART_WINDOW_MS = 60 * 60 * 1000;
/** 若最近（含心跳看门狗）刚重启过 serve，则跳过当天的定时重启，避免同日重复重启 */
const WATCHDOG_DAILY_RESTART_MIN_GAP_MS = 30 * 60 * 1000;
let serveWatchdogState = null;
function isServeWatchdogRunning() {
    return Boolean(serveWatchdogState && serveWatchdogState.timer);
}
async function probeServeHealth(config) {
    try {
        const res = await ocFetch(buildServeUrl(config), "/session", {
            method: "GET",
            directory: OPENCODE_DEFAULT_WORKDIR,
            timeoutMs: WATCHDOG_PROBE_TIMEOUT_MS
        });
        return res.status === 200;
    }
    catch {
        return false;
    }
}
/** 解析 "HH:MM"（本地时间）；非法或关闭标记返回 null */
function parseDailyRestartTime(value) {
    if (typeof value !== "string") {
        return null;
    }
    const text = value.trim().toLowerCase();
    if (!text || text === "off" || text === "0" || text === "false" || text === "no") {
        return null;
    }
    const matched = /^(\d{1,2}):(\d{2})$/.exec(text);
    if (!matched) {
        return null;
    }
    const hour = Number(matched[1]);
    const minute = Number(matched[2]);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return null;
    }
    return { hour, minute };
}
function formatClock(hour, minute) {
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
/** 本地日期键（YYYY-MM-DD），用于保证定时重启每天只触发一次 */
function localDayKey(date) {
    return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
/**
 * 每日定时重启：到点（默认 03:00）且当前没有任务在跑时主动重启一次 serve。
 *   - 到点仍在忙：在 dailyRestartWindowMs 内每个 tick 继续等待，绝不打断任务；
 *   - 超出窗口仍忙 / 近期刚重启过：当天跳过，次日再试；
 *   - 按本地日期记账，每天最多触发一次。
 * 返回 true 表示本轮已经执行过重启（调用方应跳过后续心跳判定）。
 */
async function maybeRunDailyRestart(state) {
    const at = state.dailyRestartAt;
    if (!at) {
        return false;
    }
    const now = new Date();
    const dayKey = localDayKey(now);
    if (state.dailyRestartDayKey === dayKey) {
        return false;
    }
    const targetMinutes = at.hour * 60 + at.minute;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (nowMinutes < targetMinutes) {
        return false;
    }
    const elapsedMs = (nowMinutes - targetMinutes) * 60000 + now.getSeconds() * 1000;
    const label = formatClock(at.hour, at.minute);
    const windowMinutes = Math.round(state.dailyRestartWindowMs / 60000);
    if (elapsedMs > state.dailyRestartWindowMs) {
        state.dailyRestartDayKey = dayKey;
        console.log(`[watchdog]: 每日重启（${label}）已超出等待窗口 ${String(windowMinutes)}min 仍未能执行，今天跳过`);
        state.onEvent({ type: "daily_skipped", reason: "missed_window", at: label });
        return false;
    }
    if (state.lastRestartAt && Date.now() - state.lastRestartAt < state.dailyRestartMinGapMs) {
        state.dailyRestartDayKey = dayKey;
        console.log(`[watchdog]: ${String(Math.round(state.dailyRestartMinGapMs / 60000))}min 内刚重启过 serve，跳过今天 ${label} 的定时重启`);
        state.onEvent({ type: "daily_skipped", reason: "recent_restart", at: label });
        return false;
    }
    let busy = true;
    try {
        busy = Boolean(await state.isBusy());
    }
    catch (error) {
        console.error("[watchdog]: daily_busy_check_failed", error);
        return false;
    }
    if (busy) {
        if (state.dailyWaitLoggedFor !== dayKey) {
            state.dailyWaitLoggedFor = dayKey;
            const running = state.getRunningTool();
            const runningNote = running ? `（${String(running.tool ?? "unknown")}）` : "";
            console.log(`[watchdog]: 每日重启（${label}）已到点，但仍有任务在跑${runningNote}，在窗口 ${String(windowMinutes)}min 内等待空闲`);
        }
        return false;
    }
    state.dailyRestartDayKey = dayKey;
    state.failures = 0;
    state.restarts += 1;
    state.lastRestartAt = Date.now();
    const info = {
        type: "restart",
        reason: "scheduled",
        at: label,
        restarts: state.restarts,
        pid: serveProcess ? serveProcess.pid : null,
        runningTool: null,
        runningMs: null
    };
    state.onEvent(info);
    await restartHungServe(`每日定时重启（${label}）`);
    state.onEvent(Object.assign({}, info, { type: "restarted" }));
    return true;
}
/**
 * 启动 serve 看门狗。
 * options：intervalMs / failThreshold / toolGraceMs / dailyRestartTime("HH:MM"|off) /
 * dailyRestartWindowMs 覆盖默认阈值；
 * getRunningTool() => { since, tool } | null 用于识别合法长任务；
 * isBusy() => Promise<boolean> 用于判断"当前是否有任务在跑"（缺省回退到 getRunningTool）；
 * onEvent(info) 用于日志与通知（info.type: restart | restarted | daily_skipped）。
 */
function startServeWatchdog(options = {}) {
    stopServeWatchdog();
    const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : WATCHDOG_INTERVAL_MS;
    const failThreshold = Number.isFinite(options.failThreshold) ? options.failThreshold : WATCHDOG_FAIL_THRESHOLD;
    const toolGraceMs = Number.isFinite(options.toolGraceMs) ? options.toolGraceMs : WATCHDOG_TOOL_GRACE_MS;
    const getRunningTool = typeof options.getRunningTool === "function" ? options.getRunningTool : () => null;
    const onEvent = typeof options.onEvent === "function" ? options.onEvent : () => undefined;
    const isBusy = typeof options.isBusy === "function" ? options.isBusy : async () => Boolean(getRunningTool());
    const dailyRestartAt = parseDailyRestartTime(options.dailyRestartTime === undefined ? WATCHDOG_DAILY_RESTART_TIME : options.dailyRestartTime);
    const dailyRestartWindowMs = Number.isFinite(options.dailyRestartWindowMs) && options.dailyRestartWindowMs > 0
        ? options.dailyRestartWindowMs
        : WATCHDOG_DAILY_RESTART_WINDOW_MS;
    const dailyRestartMinGapMs = Number.isFinite(options.dailyRestartMinGapMs) && options.dailyRestartMinGapMs >= 0
        ? options.dailyRestartMinGapMs
        : WATCHDOG_DAILY_RESTART_MIN_GAP_MS;
    const state = {
        timer: null,
        failures: 0,
        restarts: 0,
        probing: false,
        threshold: failThreshold,
        toolGraceMs,
        getRunningTool,
        onEvent,
        isBusy,
        dailyRestartAt,
        dailyRestartWindowMs,
        dailyRestartMinGapMs,
        dailyRestartDayKey: null,
        dailyWaitLoggedFor: null,
        // 以启动时刻为基线：桥刚起来时即便正好落在窗口内，也不会立刻再重启一次
        lastRestartAt: Date.now()
    };
    serveWatchdogState = state;
    state.timer = setInterval(() => {
        void runServeWatchdogTick(state);
    }, intervalMs);
    if (typeof state.timer.unref === "function") {
        state.timer.unref();
    }
    const dailyNote = dailyRestartAt
        ? `，每日 ${formatClock(dailyRestartAt.hour, dailyRestartAt.minute)} 空闲时主动重启（等待窗口 ${String(Math.round(dailyRestartWindowMs / 60000))}min）`
        : "，每日定时重启已关闭";
    console.log(`[watchdog]: 已启动（间隔 ${String(Math.round(intervalMs / 1000))}s，连续失败 ${String(failThreshold)} 次判定卡死，工具宽限 ${String(Math.round(toolGraceMs / 60000))}min${dailyNote}）`);
    return state;
}
function stopServeWatchdog() {
    if (serveWatchdogState && serveWatchdogState.timer) {
        clearInterval(serveWatchdogState.timer);
    }
    serveWatchdogState = null;
}
async function runServeWatchdogTick(state) {
    if (state.probing || !currentServeConfig) {
        return;
    }
    if (!serveProcess || serveProcess.killed) {
        state.failures = 0;
        return;
    }
    state.probing = true;
    try {
        // 每日定时重启优先：到点且空闲时重启后本轮不再探测心跳
        if (await maybeRunDailyRestart(state)) {
            return;
        }
        const healthy = await probeServeHealth(currentServeConfig);
        if (healthy) {
            if (state.failures > 0) {
                console.log(`[watchdog]: serve 已恢复响应（此前连续失败 ${String(state.failures)} 次）`);
            }
            state.failures = 0;
            return;
        }
        state.failures += 1;
        const running = state.getRunningTool();
        const runningMs = running && typeof running.since === "number" ? Date.now() - running.since : null;
        const runningNote = runningMs === null
            ? ""
            : `（工具 ${String(running.tool ?? "unknown")} 已运行 ${String(Math.round(runningMs / 1000))}s）`;
        console.warn(`[watchdog]: serve 心跳失败 ${String(state.failures)}/${String(state.threshold)}${runningNote}`);
        if (state.failures < state.threshold) {
            return;
        }
        if (runningMs !== null && runningMs < state.toolGraceMs) {
            console.warn(`[watchdog]: 运行中的工具未超过宽限 ${String(Math.round(state.toolGraceMs / 60000))}min，判定为合法长任务，暂不重启`);
            state.failures = 0;
            return;
        }
        state.failures = 0;
        state.restarts += 1;
        state.lastRestartAt = Date.now();
        const info = {
            type: "restart",
            reason: "heartbeat",
            restarts: state.restarts,
            pid: serveProcess ? serveProcess.pid : null,
            runningTool: running ? running.tool : null,
            runningMs
        };
        state.onEvent(info);
        await restartHungServe();
        state.onEvent(Object.assign({}, info, { type: "restarted" }));
    }
    catch (error) {
        console.error("[watchdog]: tick_failed", error);
    }
    finally {
        state.probing = false;
    }
}
/** 手动/自动恢复入口：重启 opencode serve（无 serve 进程时为空操作） */
async function restartOpenCodeServe(reason) {
    await restartHungServe(reason);
}
async function restartHungServe(reason) {
    const child = serveProcess;
    if (!child || child.killed || !currentServeConfig) {
        return;
    }
    const label = reason ? String(reason) : "无响应";
    console.error(`[watchdog]: opencode serve ${label}，强制重启 pid=${String(child.pid)}`);
    await (0, opencode_exec_1.terminateChild)(child);
    serveProcess = null;
    serveStartPromise = null;
    await initOpenCodeServe(currentServeConfig);
    // serve 换了进程：立即重建 SSE 事件订阅（reconcile 定时器也会兜底）
    reconcileEventWatchDirs();
    console.log("[watchdog]: opencode serve 已重启并就绪");
}
/**
 * 直连 opencode serve 的 JSON API。
 * 目录通过 x-opencode-directory 头传递（与服务端 LocationMiddleware 一致）。
 */
async function ocFetch(base, path, options = {}) {
    const { method = "GET", body, directory, signal, timeoutMs } = options;
    const headers = {};
    if (body !== undefined) {
        headers["Content-Type"] = "application/json";
    }
    if (directory) {
        headers["x-opencode-directory"] = encodeURIComponent(directory);
    }
    const controller = new AbortController();
    let selfTimedOut = false;
    const timer = timeoutMs ? setTimeout(() => {
        selfTimedOut = true;
        controller.abort();
    }, timeoutMs) : null;
    const onOuterAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) {
            controller.abort();
        }
        else {
            signal.addEventListener("abort", onOuterAbort, { once: true });
        }
    }
    try {
        const res = await fetch(base + path, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal
        });
        const text = await res.text();
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        }
        catch {
            // 非 JSON 响应
        }
        return { status: res.status, json, text };
    }
    catch (error) {
        // 归一化：自身超时 → 可读错误；外部中止 → 桥统一 abort 错误（避免裸 DOMException AbortError 泄漏）
        if (selfTimedOut) {
            throw new Error(`请求 OpenCode 超时（${Math.round(timeoutMs ?? 0)}ms）`);
        }
        if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
            throw createAbortError();
        }
        throw error;
    }
    finally {
        if (timer) {
            clearTimeout(timer);
        }
        if (signal) {
            signal.removeEventListener("abort", onOuterAbort);
        }
    }
}
/**
 * 订阅 opencode serve 的 SSE 事件流（/event），逐条产出事件对象 {type, properties}。
 */
async function* sseEventStream(base, directory, signal) {
    const headers = {};
    if (directory) {
        headers["x-opencode-directory"] = encodeURIComponent(directory);
    }
    const res = await fetch(base + "/event", { headers, signal });
    if (!res.ok || !res.body) {
        throw new Error(`事件流订阅失败: HTTP ${String(res.status)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            let frameEnd;
            while ((frameEnd = buffer.indexOf("\n\n")) >= 0) {
                const frame = buffer.slice(0, frameEnd);
                buffer = buffer.slice(frameEnd + 2);
                const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
                if (dataLine) {
                    try {
                        yield JSON.parse(dataLine.slice(5).trim());
                    }
                    catch {
                        // 忽略无法解析的帧
                    }
                }
            }
        }
    }
    finally {
        reader.cancel().catch(() => undefined);
    }
}
function parseModelParam(model) {
    if (!model || typeof model !== "string") {
        return undefined;
    }
    const trimmed = model.trim();
    if (!trimmed) {
        return undefined;
    }
    const slash = trimmed.indexOf("/");
    if (slash > 0) {
        return {
            providerID: trimmed.slice(0, slash),
            modelID: trimmed.slice(slash + 1)
        };
    }
    return { modelID: trimmed };
}
function getErrorMessage(payload) {
    const error = payload?.error;
    if (!error) {
        return "OpenCode 会话发生错误。";
    }
    if (typeof error === "string") {
        return error;
    }
    if (error?.data?.message) {
        return String(error.data.message);
    }
    if (error?.name) {
        return String(error.name);
    }
    return "OpenCode 会话发生错误。";
}
/**
 * 向 opencode serve 发送消息并流式等待完成。
 *
 * params:
 * - message: 用户消息
 * - sessionId: 可选，续接会话
 * - model: "provider/model" 或 "model"，可选
 * - workdir: 工作目录
 * - timeoutMs: 整体超时（毫秒）
 * - onEvent: (event) => void，服务端事件回调（message.part.updated 等）
 * - onAsk: (ask) => Promise<AskResult|null>，任务内交互回调：
 *     ask = { kind: "question", requestID, sessionID, questions } | { kind: "permission", requestID, sessionID, permission, patterns }
 *     question 返回 { answers: string[][] }，permission 返回 { reply, message? }
 *     返回 null 表示用户未回答/放弃（桥会 reject 该请求并让模型继续）。
 * - signal: 中止信号
 */
/**
 * 提交消息给当前(或新建)会话；执行/排队由 serve 管理，桥只经统一事件流跟进。
 */
async function submitSessionMessage(params) {
    if (!currentServeConfig) {
        throw new Error("OpenCode serve 未初始化");
    }
    const base = buildServeUrl(currentServeConfig);
    const workdir = params.workdir?.trim() || OPENCODE_DEFAULT_WORKDIR;
    let sessionId = params.sessionId;
    if (!sessionId) {
        const createBody = { permission: SESSION_PERMISSION_RULES };
        // opencode serve 的 POST /session 不接受 model 字段（会 400 BadRequest）；
        // 模型改在下方 POST /session/{id}/message 的 messageBody.model 中生效（已验证）。
        const created = await ocFetch(base, "/session", {
            method: "POST",
            body: createBody,
            directory: workdir
        });
        if (created.status !== 200 || !created.json?.id) {
            throw new Error(`创建 OpenCode 会话失败: HTTP ${String(created.status)} ${created.text.slice(0, 200)}`);
        }
        sessionId = created.json.id;
        if (typeof params.onSessionCreated === "function") {
            try {
                await params.onSessionCreated(sessionId);
            }
            catch (error) {
                console.error("[opencode]: onSessionCreated_failed", error);
            }
        }
    }
    else {
        try {
            const existing = await ocFetch(base, `/session/${encodeURIComponent(sessionId)}`, {
                method: "GET",
                directory: workdir
            });
            const permissions = Array.isArray(existing.json?.permission) ? existing.json.permission : [];
            const hasQuestionAllow = permissions.some((rule) => rule?.permission === "question" && rule?.action === "allow");
            if (!hasQuestionAllow) {
                await ocFetch(base, `/session/${encodeURIComponent(sessionId)}`, {
                    method: "PATCH",
                    body: { permission: [QUESTION_ALLOW_RULE] },
                    directory: workdir
                });
            }
        }
        catch (error) {
            // 会话可能已不存在；提交时会得到明确错误
        }
    }
    const messageBody = { parts: [{ type: "text", text: params.message }] };
    const promptModel = parseModelParam(params.model);
    if (promptModel) {
        messageBody.model = promptModel;
    }
    const promptStartedAt = Date.now();
    try {
        const promptResult = await ocFetch(base, `/session/${encodeURIComponent(sessionId)}/message`, {
            method: "POST",
            body: messageBody,
            directory: workdir
        });
        if (promptResult.status !== 200) {
            throw new Error(`发送消息到 OpenCode 失败: HTTP ${String(promptResult.status)} ${promptResult.text.slice(0, 200)}`);
        }
        // 识别「工作区实例卡死」：HTTP 200 但助手消息在毫秒级被 abort，说明模型根本没被调用。
        // 交给上层自动重启 serve 恢复（否则该目录下所有消息都会静默失败）。
        const promptAbortName = promptResult.json?.info?.error?.name;
        const promptElapsedMs = Date.now() - promptStartedAt;
        if (promptAbortName === "MessageAbortedError" && promptElapsedMs < INSTANCE_STUCK_ABORT_MS) {
            const stuckError = new Error(`OpenCode 工作区实例卡住（prompt 在 ${String(promptElapsedMs)}ms 内被中止）`);
            stuckError.code = OPENCODE_INSTANCE_STUCK;
            throw stuckError;
        }
    }
    catch (error) {
        // 若本次是新建会话、且消息发送失败，把新会话 id 随错误带回，
        // 桥据此仍 attach 该会话（避免"会话已建但桥不知道"的孤儿状态）。
        if (!params.sessionId && error && typeof error === "object") {
            error.newSessionId = sessionId;
        }
        throw error;
    }
    return { sessionId };
}
async function replySessionQuestion(questionId, answers, directory) {
    if (!currentServeConfig) { throw new Error("OpenCode serve 未初始化"); }
    const base = buildServeUrl(currentServeConfig);
    const result = await ocFetch(base, `/question/${encodeURIComponent(questionId)}/reply`, {
        method: "POST",
        body: { answers },
        directory: directory || OPENCODE_DEFAULT_WORKDIR
    });
    if (result.status !== 200) { throw new Error(`回答失败: HTTP ${String(result.status)} ${result.text.slice(0, 200)}`); }
}
async function rejectSessionQuestion(questionId, directory) {
    if (!currentServeConfig) { throw new Error("OpenCode serve 未初始化"); }
    const base = buildServeUrl(currentServeConfig);
    const result = await ocFetch(base, `/question/${encodeURIComponent(questionId)}/reject`, {
        method: "POST",
        directory: directory || OPENCODE_DEFAULT_WORKDIR
    });
    if (result.status !== 200) { throw new Error(`跳过问题失败: HTTP ${String(result.status)} ${result.text.slice(0, 200)}`); }
}
async function replySessionPermission(permissionId, replyBody, directory) {
    if (!currentServeConfig) { throw new Error("OpenCode serve 未初始化"); }
    const base = buildServeUrl(currentServeConfig);
    const result = await ocFetch(base, `/permission/${encodeURIComponent(permissionId)}/reply`, {
        method: "POST",
        body: replyBody,
        directory: directory || OPENCODE_DEFAULT_WORKDIR
    });
    if (result.status !== 200) { throw new Error(`授权回复失败: HTTP ${String(result.status)} ${result.text.slice(0, 200)}`); }
}
/**
 * 查询 opencode 服务端"当前仍挂起未回答"的提问/授权（跨会话）。
 * 返回 [{ id, kind }]；网络/服务错误时抛出，调用方按"无法确认 → 不撤销"处理。
 */
async function listOpenCodePendingQuestions(directory) {
    if (!currentServeConfig) { throw new Error("OpenCode serve 未初始化"); }
    const base = buildServeUrl(currentServeConfig);
    const dir = directory || OPENCODE_DEFAULT_WORKDIR;
    const pending = [];
    const qResult = await ocFetch(base, "/question", { method: "GET", directory: dir, timeoutMs: 6000 });
    if (qResult.status !== 200) { throw new Error(`查询挂起提问失败: HTTP ${String(qResult.status)}`); }
    if (Array.isArray(qResult.json)) {
        for (const item of qResult.json) {
            if (item && typeof item.id === "string") { pending.push({ id: item.id, kind: "question" }); }
        }
    }
    const pResult = await ocFetch(base, "/permission", { method: "GET", directory: dir, timeoutMs: 6000 });
    if (pResult.status !== 200) { throw new Error(`查询挂起授权失败: HTTP ${String(pResult.status)}`); }
    if (Array.isArray(pResult.json)) {
        for (const item of pResult.json) {
            if (item && typeof item.id === "string") { pending.push({ id: item.id, kind: "permission" }); }
        }
    }
    return pending;
}

/**
 * 查询某会话在服务端的实时状态（GET /session/status，按目录隔离）。
 * 返回 "busy" | "idle" | null：null 表示无法判定（接口不可用/网络错误），调用方不得据此当作空闲。
 * 注意：opencode 的 status map 只列出「有状态」的会话，会话不在 map 中即视为 idle。
 */
async function getOpenCodeSessionStatus(sessionId, directory) {
    if (!currentServeConfig || !sessionId) {
        return null;
    }
    const base = buildServeUrl(currentServeConfig);
    const dir = typeof directory === "string" && directory.trim() ? directory.trim() : OPENCODE_DEFAULT_WORKDIR;
    try {
        const result = await ocFetch(base, "/session/status", {
            method: "GET",
            directory: dir,
            timeoutMs: 6000
        });
        if (result.status !== 200) {
            return null;
        }
        const entry = result.json && typeof result.json === "object" ? result.json[sessionId] : undefined;
        if (!entry || typeof entry !== "object") {
            return "idle";
        }
        return entry.type === "busy" || entry.type === "retry" ? "busy" : "idle";
    }
    catch {
        return null;
    }
}
/**
 * 中断某会话正在执行的任务（等价在 opencode TUI 里按 Esc）。
 * POST /session/{id}/abort：服务端停止当前生成与命令执行；正在等待的
 * POST /session/{id}/message 会立即返回（其 info.error = MessageAbortedError）。
 * 注意：服务端对「本来就没有任务」的会话同样返回 200 true，所以是否需要中断
 * 应先用 getOpenCodeSessionStatus 判断，不能依赖返回值。
 */
async function abortOpenCodeSession(sessionId, directory) {
    if (!currentServeConfig) {
        throw new Error("OpenCode serve 未初始化");
    }
    if (!sessionId) {
        throw new Error("缺少 session id，无法中断");
    }
    const base = buildServeUrl(currentServeConfig);
    const dir = typeof directory === "string" && directory.trim() ? directory.trim() : OPENCODE_DEFAULT_WORKDIR;
    const result = await ocFetch(base, `/session/${encodeURIComponent(sessionId)}/abort`, {
        method: "POST",
        directory: dir,
        timeoutMs: 20000
    });
    if (result.status !== 200) {
        throw new Error(`中断会话失败: HTTP ${String(result.status)} ${result.text.slice(0, 200)}`);
    }
    return { aborted: result.json === true, sessionId };
}

async function isOpenCodeSessionBusy(sessionId, directory) {
    if (!currentServeConfig || !sessionId) {
        return null;
    }
    const base = buildServeUrl(currentServeConfig);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
        for await (const event of sseEventStream(base, directory, controller.signal)) {
            const props = event.properties ?? {};
            if (!props.sessionID || props.sessionID !== sessionId) {
                continue;
            }
            if (event.type === "session.status") {
                const statusType = props.status?.type;
                if (statusType === "idle") {
                    return false;
                }
                if (statusType === "running" || statusType === "working") {
                    return true;
                }
            }
            else {
                // 出现该会话的业务事件（message.part.* 等），视为正在运行
                return true;
            }
        }
        return null;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * 常驻订阅 serve 的 SSE 事件流（含断线自动重连），把每个事件交给 onEvent。
 * 供桥"被动监听外部客户端(如 SSH attach)发起的会话任务"使用。
 *
 * 注意：opencode serve 的 /event 流按工作目录（x-opencode-directory）隔离——
 * 会话存于哪个目录，事件就只出现在该目录的流上。因此这里对"每个用户活动目录"各维护
 * 一条 SSE 订阅，目录集合由桥按「当前 attach 会话所在目录 + 默认目录」收敛（setWatchWorkDirectories，
 * 替换语义、会中止多余目录的流）——只有需要向飞书转发事件的目录才订阅。
 */
const eventWatchState = {
    onEvent: null,
    signal: null,
    dirs: new Set(),
    streams: new Map(),
    reconcileTimer: null
};
function abortEventWatchStreams() {
    for (const controller of eventWatchState.streams.values()) {
        controller.abort();
    }
    eventWatchState.streams.clear();
}
function startEventWatchDirStream(directory) {
    if (eventWatchState.streams.has(directory)) {
        return;
    }
    const controller = new AbortController();
    const onRootAbort = () => controller.abort();
    eventWatchState.streams.set(directory, controller);
    const rootSignal = eventWatchState.signal;
    if (rootSignal) {
        if (rootSignal.aborted) {
            controller.abort();
        }
        else {
            rootSignal.addEventListener("abort", onRootAbort, { once: true });
        }
    }
    (async () => {
        while (!controller.signal.aborted) {
            try {
                if (!currentServeConfig) {
                    await sleep(2000);
                    continue;
                }
                const base = buildServeUrl(currentServeConfig);
                for await (const event of sseEventStream(base, directory, controller.signal)) {
                    const onEvent = eventWatchState.onEvent;
                    if (!onEvent) {
                        continue;
                    }
                    try {
                        onEvent(event);
                    }
                    catch (error) {
                        console.error("[opencode]: watch_on_event_error", error);
                    }
                }
                // 流被服务端正常关闭：短暂等待后重连
                await sleep(1500);
            }
            catch (error) {
                if (controller.signal.aborted) {
                    break;
                }
                await sleep(2000);
            }
        }
        eventWatchState.streams.delete(directory);
    })();
}
function reconcileEventWatchDirs() {
    for (const directory of eventWatchState.dirs) {
        startEventWatchDirStream(directory);
    }
    for (const [directory, controller] of eventWatchState.streams.entries()) {
        if (!eventWatchState.dirs.has(directory)) {
            controller.abort();
        }
    }
}
/**
 * 收敛事件订阅的目标目录集合（替换语义；可在 serve 就绪前调用，就绪后自动建流）。
 * 调用方只需传入「当前需要转发事件的目录」（默认目录 + 当前 attach 会话目录），
 * 不再需要的目录对应的 SSE 流会被中止，避免订阅目录越积越多。
 */
function setWatchWorkDirectories(directories) {
    const next = new Set();
    const raw = Array.isArray(directories) ? directories : [];
    for (const dir of raw) {
        const normalized = String(dir || "").trim();
        if (normalized) {
            next.add(normalized);
        }
    }
    eventWatchState.dirs = next;
    reconcileEventWatchDirs();
}
async function watchOpenCodeEvents(onEvent, signal) {
    eventWatchState.onEvent = onEvent;
    eventWatchState.signal = signal;
    eventWatchState.dirs.add(OPENCODE_DEFAULT_WORKDIR);
    if (signal) {
        if (signal.aborted) {
            abortEventWatchStreams();
            return;
        }
        signal.addEventListener("abort", () => {
            abortEventWatchStreams();
            if (eventWatchState.reconcileTimer) {
                clearInterval(eventWatchState.reconcileTimer);
                eventWatchState.reconcileTimer = null;
            }
            eventWatchState.onEvent = null;
            eventWatchState.signal = null;
        }, { once: true });
    }
    reconcileEventWatchDirs();
    if (!eventWatchState.reconcileTimer) {
        // 兜底轮询：serve 重启/新目录入队后确保建流（不阻止进程退出）
        eventWatchState.reconcileTimer = setInterval(reconcileEventWatchDirs, 8000);
        if (typeof eventWatchState.reconcileTimer.unref === "function") {
            eventWatchState.reconcileTimer.unref();
        }
    }
}

function escapeSqlString(value) {
    return value.replace(/'/g, "''");
}
async function listOpenCodeSessionsFromDb(maxCount = 20) {
    const safeCount = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 20;
    const query = [
        "select",
        "id,",
        "title,",
        "project_id as projectId,",
        "directory,",
        "time_created as created,",
        "time_updated as updated",
        "from session",
        "where time_archived is null and parent_id is null",
        "order by time_updated desc",
        `limit ${String(safeCount)}`
    ].join(" ");
    const { stdout, stderr, code, signal, timedOut } = await runCommand(["db", query, "--format", "json"], 15000);
    if (code !== 0) {
        const stderrText = stderr.trim();
        const stdoutText = stdout.trim();
        const reason = [
            `code=${String(code)}`,
            signal ? `signal=${signal}` : "",
            stderrText ? `stderr=${stderrText}` : "",
            !stderrText && stdoutText ? `stdout=${stdoutText}` : ""
        ]
            .filter(Boolean)
            .join(" | ");
        const timeoutHint = timedOut ? " | 可能超时" : "";
        throw new Error(`查询 OpenCode 会话失败: ${reason || "未知原因"}${timeoutHint}`);
    }
    return parseOpenCodeSessionsFromJson(stdout);
}
async function getOpenCodeSessionByIdFromDb(sessionId) {
    const id = sessionId.trim();
    if (!id) {
        return undefined;
    }
    const query = [
        "select",
        "id,",
        "title,",
        "project_id as projectId,",
        "directory,",
        "time_created as created,",
        "time_updated as updated",
        "from session",
        `where id='${escapeSqlString(id)}'`,
        "limit 1"
    ].join(" ");
    const { stdout, stderr, code, signal, timedOut } = await runCommand(["db", query, "--format", "json"], 15000);
    if (code !== 0) {
        const stderrText = stderr.trim();
        const stdoutText = stdout.trim();
        const reason = [
            `code=${String(code)}`,
            signal ? `signal=${signal}` : "",
            stderrText ? `stderr=${stderrText}` : "",
            !stderrText && stdoutText ? `stdout=${stdoutText}` : ""
        ]
            .filter(Boolean)
            .join(" | ");
        const timeoutHint = timedOut ? " | 可能超时" : "";
        throw new Error(`查询 OpenCode 会话失败: ${reason || "未知原因"}${timeoutHint}`);
    }
    const sessions = parseOpenCodeSessionsFromJson(stdout);
    return sessions[0];
}
async function listOpenCodeModels() {
    // 直接枚举 `opencode models`（含 opencode.json 配置的 provider 与全局凭据）。
    // 不再依赖 providers list：它只显示 auth.json 里的凭据，会漏掉配置文件里的 provider（如 deepseek）。
    const { stdout, stderr, code, signal, timedOut } = await runCommand(["models"], 20000);
    if (code !== 0) {
        const stderrText = stderr.trim();
        const stdoutText = stdout.trim();
        const reason = [
            `code=${String(code)}`,
            signal ? `signal=${signal}` : "",
            stderrText ? `stderr=${stderrText}` : "",
            !stderrText && stdoutText ? `stdout=${stdoutText}` : ""
        ]
            .filter(Boolean)
            .join(" | ");
        const timeoutHint = timedOut ? " | 可能超时" : "";
        throw new Error(`查询 OpenCode 模型失败: ${reason || "未知原因"}${timeoutHint}`);
    }
    const models = [];
    for (const lineId of stdout.split("\n")) {
        const id = lineId.trim();
        const separatorIndex = id.indexOf("/");
        if (separatorIndex <= 0) {
            continue;
        }
        const provider = id.slice(0, separatorIndex);
        const model = id.slice(separatorIndex + 1);
        if (!provider || !model) {
            continue;
        }
        models.push({ id, provider });
    }
    return models;
}
async function getOpenCodeSessionLatestModel(sessionId) {
    const id = sessionId.trim();
    if (!id) {
        return undefined;
    }
    // 优先读 DB 的 session.model（列存 JSON，快且稳），失败再回退 export
    try {
        const dbRes = await runCommand(["db", `select model from session where id='${escapeSqlString(id)}' limit 1`, "--format", "json"], 10000);
        if (dbRes.code === 0) {
            const rows = JSON.parse(dbRes.stdout || "[]");
            const raw = rows && rows.length > 0 ? rows[0]?.model : null;
            if (raw) {
                const parsedModel = typeof raw === "string" ? JSON.parse(raw) : raw;
                const providerId = String(parsedModel?.providerID || "").trim();
                const modelId = String(parsedModel?.id || "").trim();
                if (providerId && modelId) {
                    return { providerId, modelId, id: `${providerId}/${modelId}` };
                }
            }
        }
    }
    catch (error) {
        // 回退到 export
    }
    const { stdout, stderr, code, signal, timedOut } = await runCommand(["export", id], 60000);
    if (code !== 0) {
        const stderrText = stderr.trim();
        const stdoutText = stdout.trim();
        const reason = [
            `code=${String(code)}`,
            signal ? `signal=${signal}` : "",
            stderrText ? `stderr=${stderrText}` : "",
            !stderrText && stdoutText ? `stdout=${stdoutText}` : ""
        ]
            .filter(Boolean)
            .join(" | ");
        const timeoutHint = timedOut ? " | 可能超时" : "";
        throw new Error(`查询 OpenCode 会话模型失败: ${reason || "未知原因"}${timeoutHint}`);
    }
    const jsonStart = stdout.indexOf("{");
    if (jsonStart < 0) {
        return undefined;
    }
    const parsed = JSON.parse(stdout.slice(jsonStart));
    if (!Array.isArray(parsed.messages)) {
        return undefined;
    }
    const messages = parsed.messages;
    const pickLatestModel = (role) => {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const info = messages[index]?.info;
            if (role && info?.role !== role) {
                continue;
            }
            const model = info?.model;
            const providerId = model?.providerID?.trim();
            const modelId = model?.modelID?.trim();
            if (providerId && modelId) {
                return {
                    providerId,
                    modelId,
                    id: `${providerId}/${modelId}`
                };
            }
        }
        return undefined;
    };
    return pickLatestModel("assistant") ?? pickLatestModel();
}
async function listConfiguredProviderIds() {
    const { stdout, stderr, code, signal, timedOut } = await runCommand(["providers", "list"], 15000);
    if (code !== 0) {
        const stderrText = stderr.trim();
        const stdoutText = stdout.trim();
        const reason = [
            `code=${String(code)}`,
            signal ? `signal=${signal}` : "",
            stderrText ? `stderr=${stderrText}` : "",
            !stderrText && stdoutText ? `stdout=${stdoutText}` : ""
        ]
            .filter(Boolean)
            .join(" | ");
        const timeoutHint = timedOut ? " | 可能超时" : "";
        throw new Error(`查询 OpenCode provider 失败: ${reason || "未知原因"}${timeoutHint}`);
    }
    const cleanText = stripAnsi(stdout);
    const providerIds = [];
    const seen = new Set();
    for (const rawLine of cleanText.split("\n")) {
        const line = rawLine.trim();
        if (!line.startsWith("●")) {
            continue;
        }
        const rawProvider = line.replace(/^●\s+/, "").trim();
        if (!rawProvider) {
            continue;
        }
        const parts = rawProvider.split(/\s+/);
        const last = parts[parts.length - 1]?.trim();
        if (last && (last.toLowerCase() === "api" || /^[A-Z0-9_]+$/.test(last))) {
            parts.pop();
        }
        const providerName = parts.join(" ").trim();
        if (!providerName) {
            continue;
        }
        const providerId = providerDisplayNameToId(providerName);
        if (!providerId || seen.has(providerId)) {
            continue;
        }
        seen.add(providerId);
        providerIds.push(providerId);
    }
    return providerIds;
}
function providerDisplayNameToId(name) {
    const normalized = name.trim().toLowerCase();
    const mapped = {
        anthropic: "anthropic",
        google: "google",
        openai: "openai",
        xai: "xai",
        opencode: "opencode",
        "google vertex": "google-vertex",
        "google vertex anthropic": "google-vertex-anthropic",
        "azure openai": "azure-openai"
    };
    if (mapped[normalized]) {
        return mapped[normalized];
    }
    return normalized
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
}
function parseOpenCodeSessionsFromJson(text) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
        return [];
    }
    const sessions = [];
    for (const item of parsed) {
        if (!item || typeof item !== "object") {
            continue;
        }
        const record = item;
        const id = typeof record.id === "string" ? record.id : "";
        if (!id) {
            continue;
        }
        sessions.push({
            id,
            title: typeof record.title === "string" ? record.title : undefined,
            updated: typeof record.updated === "number" ? record.updated : undefined,
            created: typeof record.created === "number" ? record.created : undefined,
            projectId: typeof record.projectId === "string" ? record.projectId : undefined,
            directory: typeof record.directory === "string" ? record.directory : undefined
        });
    }
    return sessions;
}
function stripAnsi(input) {
    return input.replace(/\u001b\[[0-9;]*m/g, "");
}
async function runCommand(args, timeoutMs, workingDirectory) {
    return await new Promise((resolve, reject) => {
        const { child } = (0, opencode_exec_1.spawnOpenCode)(args, {
            cwd: workingDirectory ?? OPENCODE_DEFAULT_WORKDIR,
            env: process.env,
            stdio: ["pipe", "pipe", "pipe"]
        });
        const stdoutParts = [];
        const stderrParts = [];
        let timedOut = false;
        child.stdout.on("data", (chunk) => {
            stdoutParts.push(chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderrParts.push(chunk);
        });
        child.on("error", (error) => {
            reject(error);
        });
        const timeout = setTimeout(() => {
            timedOut = true;
            void (0, opencode_exec_1.terminateChild)(child, { graceMs: 2000 });
        }, timeoutMs);
        child.on("close", (code, signal) => {
            clearTimeout(timeout);
            resolve({
                stdout: Buffer.concat(stdoutParts).toString("utf8"),
                stderr: Buffer.concat(stderrParts).toString("utf8"),
                code,
                signal,
                timedOut
            });
        });
        child.stdin.end();
    });
}
