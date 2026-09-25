# Changelog

## 未发布

- 新增 `scripts/deploy.sh`（`npm run deploy` / `deploy:check`）：把仓库同步到本机部署目录（比对 → 复制 → 校验 dist/bin → 重启桥），把原先手工 `cp` + 重启的部署步骤固化，避免仓库与部署目录漂移
- README 精简至约 230 行：移除维护过程性内容（发布步骤、实测记录、实现原理叙述），合并重复章节

## v1.1.0（2026-09-25）

相对 npm 1.0.3 的重构与增强：

- 统一事件流：由桥直接拉起并驱动 `opencode serve`，替代 `opencode run` 子进程
- 任务内交互：question/permission 渲染为飞书交互卡片，支持按钮与文本回复、超时跳过、跨端去重
- 新增 `/m` 菜单卡片与 `/menu` 别名：按钮回调 + 10 分钟编号兜底 + 操作者白名单校验
- `/m` 菜单升级为卡片 JSON 2.0：**历史会话 / 历史工作目录 / 可用模型** 三个下拉选择列表（选中即执行，回调取值 `action.option`）；新增工作目录使用历史（随会话状态持久化）；2.0 卡片不被接受时自动回退 1.0 按钮卡片
- 新增 **serve 看门狗**：`GET /session` 心跳连续失败（默认 6 次 ≈ 3 分钟）自动重启卡死的 `opencode serve`（`SIGTERM` → 5s 后 `SIGKILL`），重建 SSE 事件订阅并飞书通知；检测到运行中的工具调用且未超宽限时不重启，避免误杀长时间构建。可用 `OPENCODE_SERVE_WATCHDOG` 等环境变量调整
- 看门狗新增**每日定时重启**：默认 `03:00`（本地时间）在没有任务运行时主动重启一次 `opencode serve`，定期回收长跑累积的内存/句柄；忙碌时在等待窗口（默认 60min）内等空闲，绝不打断任务，超窗顺延次日；30 分钟内刚重启过则跳过当天；默认静默，可用 `OPENCODE_DAILY_RESTART` / `OPENCODE_DAILY_RESTART_WINDOW_MS` / `OPENCODE_DAILY_RESTART_NOTIFY` 调整
- 被动监听：外部 `opencode attach` 客户端在同会话发起任务时转发进展到飞书
- `/status` 末尾附上**本机终端 attach 当前会话的命令**（`opencode attach <url> -s <session_id> --dir <目录>`，路径按需做 shell 引用，`0.0.0.0` 自动改写为 `127.0.0.1`）；以飞书 `code_block` 富文本段落展示便于复制，富文本被拒时自动退回纯文本
- 新增 `/esc`：**中断服务端正在执行的任务**（`POST /session/{id}/abort`，等价终端 attach 里按 Esc）。会话忙闲判定优先走 `GET /session/status`（毫秒级、权威），不可用时回退原 SSE 订阅法；中断后撤销桥端挂起的提问/授权等待，并把该会话的收尾文案从「✅ 任务完成」改为「⏹ 任务已中断」
- 工作区实例卡死自愈：opencode 的目录实例若在**初始化未完成时被中断**，之后该目录的所有 prompt 都会在毫秒级被 abort（模型根本不会被调用，用户只会看到"已提交"后没有下文）。桥现在识别该特征（HTTP 200 + `MessageAbortedError` + 耗时 < 1.5s）并自动重启 `opencode serve` 恢复，同时明确告知用户重发；5 分钟冷却窗口避免"每条消息都重启"（会话存 DB，不丢）
- 助手消息**表格渲染**：含 GFM 表格的回复自动改发**卡片 JSON 2.0**（表格用原生 `table` 组件，其余段落仍由卡片 markdown 渲染）。原因是飞书富文本 `post` 的 `md` 标签在移动端等客户端上不渲染 GFM 表格（会显示成一整段带 `|` 的原文），实测卡片 markdown 与卡片原生表格组件都能正常渲染；无表格的消息行为不变，可用 `FEISHU_TABLE_CARD=table|markdown|off` 调整，超 20 列或超 30KB 自动退回 `post`
- 表格消息的收尾改用 `PATCH /im/v1/messages/{id}`（更新消息卡片）原地更新，因为"编辑消息"接口只支持 text/post；阶段消息与最终内容形态不一致时自动补发新消息
- **Windows 原生支持**（不再需要 WSL）：新增 `dist/opencode-exec.js` 统一 opencode CLI 的启动与终止。Windows 上 npm 只生成 `opencode.cmd` 垫片，Node 的 `spawn` 走 CreateProcess 只补 `.exe`、显式 `.cmd` 在现代 Node 又直接 `EINVAL`；现按「真 `.exe` → 解析 `.cmd` 垫片里的目标 → `cmd.exe /d /s /c` 兜底」的顺序解析，并支持 `OPENCODE_BIN` 覆盖。终止进程改用 `taskkill /PID <pid> /T /F` 结束整棵进程树，避免经 cmd 垫片启动时留下孤儿 serve 占住端口；`/status` 给出的 attach 命令按平台切换引用风格（POSIX 单引号 / Windows 双引号）。启动日志新增 `launch kind=... source=...` 便于排查。已在 Windows 11（build 26200）+ Node v24.18.0 + nvm4w 实机验证：`opencode.cmd` 垫片被正确解析为真实 `opencode.exe`（`kind=exe-shim`），serve 3s 就绪，终止 303ms 完成且端口立即释放、无残留进程
- README 补「Windows（原生）」章节：npm 安装、`OPENCODE_BIN`、任务计划程序 / pm2 / nssm 常驻方式与已知差异；新增 `scripts/test-opencode-exec.js` 单测（模拟 win32 的解析路径）
- 事件订阅收敛到「attach 会话所在目录 + 默认目录」（opencode /event 按 x-opencode-directory 隔离）
- 进度消息合并：3 秒缓冲，单轮快答只发一条最终消息；长任务结束时把中间消息原地更新为完成
- 默认工作目录改为 `~/OpenCode`（config.js 缺省值）
- 新增系统级 LaunchDaemon 示例（开机免登录自启）
- 一键安装/卸载脚本：`node scripts/install.js` / `node scripts/uninstall.js`（安装 SKILL + MCP、卸载一并移除）
- 会话状态持久化：session/workdir/chat 跨重启恢复，转发目标不因重启丢失
- `/new`（不带路径）保留当前工作目录开新会话，`/reset` 回到默认目录（两者语义分离）
- 文件直发链路：桥 HTTP API + feishu-bridge MCP（feishu_send_file）
- 提供 feishu-bridge Skill（skills/feishu-bridge/SKILL.md）向模型说明桥能力，替代并移除了正文文件发送提示词注入
- 若干稳定性修复：飞书 API 30s 硬超时、restart ack 顺序、事件去重、undici 超时配置等

## v1.0.3（上游 npm 基线）

- 飞书长连接收发消息、白名单、基础本地命令（/help /new /reset /session /models 等）
