# opencode-feishu-bridge

把飞书机器人接到本机 [OpenCode](https://opencode.ai) 的轻量桥接服务：飞书消息 → `opencode serve` → 回答/进度/结果回传飞书。

> 本项目基于 `Lanfei/opencode-feishu-bridge` 长期迭代而来，重构为「统一事件流 + 任务内交互」的增强版：
> 不再依赖 `opencode run` 子进程（其非交互模式会禁用 question 工具），而是由桥自己拉起 `opencode serve` 并直连其 HTTP API，
> 因此支持任务内提问/授权、跨目录会话事件转发、进度合并为单条消息等能力。

## 功能特性

- 飞书长连接（WS）收消息，无需公网回调地址；支持私聊与群聊（按 `allowedOpenId` 白名单控制）
- 本地命令不消耗模型额度：`/help` `/m`（菜单卡片）`/new` `/reset` `/stop` `/esc` `/restart` `/status` `/session` `/sessions` `/model` `/models`
- `/m` 打开**菜单卡片**（卡片 JSON 2.0）：历史会话、历史工作目录、可用模型三个**下拉选择**列表，选中即执行；另有按钮直执行 + 编号兜底（10 分钟内回复 1-9 等效点击；需订阅卡片回传交互事件）
- 任务内交互：OpenCode 的 `question`/`permission` 渲染成蓝/橙交互卡片，可点按钮或直接回复文本
- 统一事件流：任务在 `opencode serve` 中排队/执行，桥通过 SSE 订阅事件转发进度与结果
- 进度收敛：单轮快答只发一条最终消息；长任务先发「⏳ 任务持续中…」并在结束时原地更新为「✅ 任务完成…」
- 表格渲染：含 Markdown 表格的回复自动改发**卡片**（原生表格组件），不再出现"一整段带竖线的原文"
- 被动监听：外部 `opencode attach` 客户端在同一会话发起的任务，也会把进展转发到飞书
- 跨工作目录事件订阅：事件流按目录（x-opencode-directory）隔离，桥只订阅「当前 attach 会话所在目录 + 默认目录」
- 文件直发：`feishu_send_file` MCP 工具 + 桥本地 HTTP API，把工作区内文件作为真实文件消息发出
- 状态持久化：会话/工作目录/聊天 id 存于 `~/.config/opencode/feishu-bridge/session-state.json`，重启自动恢复
- 自重启：`/restart` 或 launchd KeepAlive 崩溃自愈

## 架构与数据流

```
飞书 App（长连接 WS）
   │  收到文本/卡片回调（im.message.receive_v1 / card.action.trigger）
   ▼
dist/main.js  ── 本地命令 / 菜单卡片 / 提问·授权卡片 ──┐
   │  POST /session /session/{id}/message            │
   ▼                                              │
opencode serve 127.0.0.1:4096（桥拉起）             │
   │  SSE /event（按目录隔离）                          │
   ▼                                              │
dist/main.js 被动转发（进度/完成/提问/授权）──────────┘
   │
   ▼
飞书：阶段进度消息（缓冲合并）+ 最终「任务完成」消息

模型可用时也通过 MCP 暴露文件发送：
opencode(MCP client) ── stdio ── dist/feishu-mcp-server.js ── HTTP 4100 ── 桥 /bridge/send-file ── 飞书文件消息
```

## 环境要求

- Node.js >= 20（内置 fetch/AbortSignal）
- OpenCode CLI：`npm i -g opencode-ai`（或官方二进制），并已配置可用的 provider/model
- 一个飞书自建应用（机器人能力 + 事件订阅长连接）
- 操作系统：macOS / Linux / **Windows 10 1809+ 或 Windows 11（原生，无需 WSL）**
  - 服务常驻：macOS 用 launchd（见 `examples/`）；Linux 用 systemd；Windows 用任务计划程序或 `pm2`/`nssm`（见下文）

## 安装

```bash
# 方式一：npm 全局安装
npm i -g opencode-feishu-bridge
# 启动
ofbs

# 方式二：源码运行
git clone https://github.com/xemoon123/opencode-feishu-bridge.git && cd opencode-feishu-bridge
npm install
npm start        # 等价 node dist/main.js
```

首次启动若 `~/.config/opencode/feishu-bridge/config.json` 不存在，会在交互终端引导创建；也可手动按 `config.example.json` 创建。
Windows 上同样是 `%USERPROFILE%\.config\opencode\feishu-bridge\config.json`（opencode 自身也用这套 XDG 约定）。

### Windows（原生）

无需 WSL，步骤与上面一致（PowerShell）：

```powershell
npm i -g opencode-ai              # opencode CLI
npm i -g opencode-feishu-bridge   # 桥本体
ofbs                              # 启动（npm 生成的 ofbs.cmd）
```

**关于 `opencode` 的启动**：Windows 上 npm 只会生成 `opencode.cmd` 垫片，而 Node 的 `spawn`
在 Windows 下走 CreateProcess，不带扩展名时只补 `.exe`（找不到 `.cmd`），显式传 `.cmd`
在现代 Node 又会直接 `EINVAL`。桥因此内置了平台解析（`dist/opencode-exec.js`），按
**真实 `.exe` → 解析 `.cmd` 垫片里的目标 → `cmd.exe /d /s /c` 兜底** 的顺序启动，
并用 `taskkill /PID <pid> /T /F` 结束整棵进程树（避免 cmd 垫片留下孤儿 serve 占住端口）。
启动日志会打印实际方式：

```
[opencode-serve 127.0.0.1:4096]: launch kind=exe-shim source=C:\Users\me\AppData\Roaming\npm\opencode.cmd -> ...\opencode.exe
```

> **实测环境**：Windows 11 专业版（build 26200）+ Node v24.18.0 + nvm4w。
> `where opencode` 返回 `C:\nvm4w\nodejs\opencode`（sh 垫片）与 `opencode.cmd`，解析结果为
> `kind=exe-shim` → `C:\nvm4w\nodejs\node_modules\opencode-ai\bin\opencode.exe`；
> `opencode serve` 3 秒内就绪，`terminateChild` 303ms 内结束进程、端口立即释放、无残留 `opencode.exe`。

若你的 opencode 装在非标准位置，用 `OPENCODE_BIN` 指定绝对路径（最高优先级）：

```powershell
$env:OPENCODE_BIN = "C:\tools\opencode\opencode.exe"
```

**常驻（开机自启）**：任务计划程序即可（管理员 PowerShell）：

```powershell
# 登录时启动，失败自动重启
schtasks /Create /TN opencode-feishu-bridge /SC ONLOGON /RL LIMITED /F ^
  /TR "\"%ProgramFiles%\nodejs\node.exe\" \"%APPDATA%\npm\node_modules\opencode-feishu-bridge\dist\main.js\""
# 查看 / 删除
schtasks /Query /TN opencode-feishu-bridge
schtasks /Delete /TN opencode-feishu-bridge /F
```

也可以直接用 `pm2`（`pm2 start ofbs --name ofbs` + `pm2 save`）或 `nssm` 注册成服务。
日志默认打到控制台，用任务计划程序时可在 `/TR` 包一层重定向，或直接用 pm2 的日志。

**已知差异**：Windows 上没有 POSIX 信号，`/restart`、看门狗重启、每日定时重启改为
`taskkill /T /F` 强杀后重新拉起（SQLite 事务安全，会话不丢）；`/status` 里给出的
`opencode attach …` 命令会自动改用双引号引用，可直接粘进 PowerShell。

## 飞书开放平台后台最小配置

1. 创建自建应用，启用「机器人」能力
2. 事件订阅选择**长连接**方式
3. 订阅事件：`接收消息 v2.0`（im.message.receive_v1）、`消息撤回事件`（im.message.recalled_v1）
4. **（强烈推荐）订阅 `卡片回传交互`（card.action.trigger）**：不订阅则 `/m` 菜单按钮、提问/授权卡片的按钮点击不生效
   （此时仍可直接回复文本：命令、菜单编号、选项编号均可用）
5. 发布版本并添加权限：读取与发送消息（im:message 等）

## 配置文件

路径：`~/.config/opencode/feishu-bridge/config.json`（zod 校验，非法字段启动即报错退出）。

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| feishuAppId | 飞书应用 App ID | 必填 |
| feishuAppSecret | 飞书应用 App Secret | 必填 |
| allowedOpenId | 允许使用的用户 open_id（数组或逗号分隔字符串）；空数组 = 允许所有（启动有安全告警） | [] |
| opencodeWorkdir | 默认工作目录，`/new`、首个会话使用；为空回退到 `~/OpenCode` | `~/OpenCode` |
| opencodeModel | 默认模型（provider/model 或 opencode 模型别名） | 空（跟随 opencode） |
| opencodeTimeout | 长静默提醒阈值（毫秒），期间无输出会推送提醒（不中断） | 600000 |
| opencodeServeHost / opencodeServePort | 本机 `opencode serve` 监听地址，需保持空闲 | 127.0.0.1 / 4096 |

修改后需重启桥（`/restart` 或重启进程）。

## 一键安装 / 卸载（技能 + MCP）

```bash
node scripts/install.js     # 或 npm run setup
node scripts/uninstall.js   # 或 npm run uninstall
```

- `install.js`：把 `skills/feishu-bridge/SKILL.md` 装到 `~/.config/opencode/skills/feishu-bridge/`，并在 `~/.config/opencode/opencode.jsonc` 的 `mcp` 段注册 `feishu-bridge`（command 指向本包 `dist/feishu-mcp-server.js`，env `BRIDGE_API_URL=http://127.0.0.1:4100`）；已存在则跳过，可重复执行。
- `uninstall.js`：移除技能目录与 `opencode.jsonc` 中的 `feishu-bridge` MCP 条目（保留其它配置与桥的 config.json）。


## 使用

直接发文本即提问。以下均为**本地命令**（不消耗模型额度），其他以 `/` 开头的未知文本会当作普通消息发给模型：

| 命令 | 说明 |
| --- | --- |
| /m 或 /menu | 打开菜单卡片：会话/工作目录/模型**下拉选择** + 按钮/编号/文字触发常用命令 |
| /help | 完整指引 |
| /new | 清空上下文开新会话（**保留当前工作目录**）；`/new <目录>` 切到指定目录 |
| /reset | 清空上下文，回到默认工作目录开新会话 |
| /session | 查看当前 attach 会话 |
| /session <编号|session_id> | 恢复/切换会话（跨目录会话恢复时会自动订阅其事件目录） |
| /sessions | 会话列表（不切换） |
| /model | 查看当前会话最近使用/已选择模型 |
| /model <编号|provider/model> | 切换模型（下一条消息生效） |
| /models | 全部可用模型（标注当前） |
| /status | 会话、目录、队列、任务与配置状态，并附**本机终端 attach 该会话的命令** |
| /esc | **中断服务端正在执行的任务**（等价在终端 attach 的界面里按 Esc）：停止当前生成与工具调用，已产生的输出照常回传 |
| /stop | 本地停止转发该会话进展（服务端任务仍在继续；要真正中断用 /esc；下一条消息恢复转发） |
| /restart | 优雅重启桥（launchd KeepAlive 自动拉起） |

### 菜单卡片（/m）

发送 `/m` 会收到一张蓝色卡片（卡片 JSON 2.0），分三块：

- **当前上下文**：当前 attach 会话（含标题）、工作目录、模型
- **下拉选择**（点开即选，选中后立即执行）：
  - 💬 **历史会话**：最近 20 条会话（标题/ID，当前会话带 ✓）→ 等价 `/session <id>`
  - 📂 **历史工作目录**：当前目录 + 最近使用过的目录 + 最近会话所在目录（去重、仅保留存在的目录）→ 等价 `/new <目录>`（会开新会话）
  - 🧠 **可用模型**：`opencode models` 的全部模型（当前项带 ✓，列表缓存 5 分钟）→ 等价 `/model <id>`
- **操作按钮**：`/new` `/sessions` `/session` `/models` `/model` `/help` `/status` `/esc` `/stop` `/restart`（按钮文字带编号，保留数字兜底）

下拉选择的选中值由飞书放在回调的 `action.option` 里（需订阅卡片回传交互事件）。
若应用/客户端不接受 2.0 卡片，桥会自动回退为 1.0 按钮卡片，菜单仍可用（日志 `select_card_rejected_fallback`）。
未订阅卡片回调时，可在打开后 10 分钟内回复编号 1-9（仅同一会话有效），或直接输入命令。

### 任务内交互

- `question`：蓝色卡片「🤖 OpenCode 需要你的选择/输入」，可点选项按钮、回复编号/选项文字或自定义内容
- `permission`：橙色卡片「🔐 OpenCode 请求授权」，允许一次 / 始终允许 / 拒绝
- 等待默认 10 分钟，超时自动跳过并通知；`/esc` 中断任务并撤销挂起提问

### 消息渲染（Markdown / 表格）

助手输出默认走飞书**富文本 post + md 标签**（标题、列表、代码块、引用等）。
**只要内容里含 GFM 表格，就自动改发卡片（卡片 JSON 2.0）**：

- 表格用卡片**原生表格组件**渲染：有表头、列宽、行高自适应；单元格放不下时客户端可点开查看；超过 10 行自动分页
- 表格前后（含同一段里）的普通 Markdown 仍由卡片 markdown 组件渲染，观感与原来一致
- 没有表格的消息照旧走 post 富文本，行为完全不变

原因：飞书富文本 `post` 的 `md` 标签**在移动端等客户端上不渲染 GFM 表格**，整张表会被当成
一段带 `|` 的普通原文；实测卡片 markdown 与卡片原生表格组件都能正常显示表格，所以含表格时改走卡片。

可用 `FEISHU_TABLE_CARD` 调整：`table`（默认，原生表格组件）/ `markdown`（整段塞进卡片 markdown）/
`off`（始终用 post 富文本）。若表格超过 20 列、或卡片内容超过飞书 30KB 上限，自动退回 post（日志 `table_card_oversize`）。

### 模型技能（Skill）

`skills/feishu-bridge/SKILL.md` 会把桥的能力（feishu_send_file 用法、question/permission 交互卡片、本地命令等）按需注入给模型。
安装：复制到系统技能库

```bash
mkdir -p ~/.config/opencode/skills/feishu-bridge
cp skills/feishu-bridge/SKILL.md ~/.config/opencode/skills/feishu-bridge/SKILL.md
```

安装后模型在需要时会自动加载该技能，无需再依赖正文里的文件发送提示词（正文里的文件发送提示词注入已完全移除，文件发送说明由本 Skill 承担）。

### 文件发送（可选 MCP）

桥自带本地 HTTP API（127.0.0.1:4100）：`GET /bridge/context`、`POST /bridge/send-file`（path 必须在当前工作目录内，≤ 20MB）。
把 `dist/feishu-mcp-server.js` 配置为 opencode 的 MCP server 后，模型即可调用 `feishu_send_file` 把文件作为真实文件消息发给用户：

```json
{ "mcpServers": { "feishu-bridge": { "command": "node", "args": ["/path/to/opencode-feishu-bridge/dist/feishu-mcp-server.js"], "env": { "BRIDGE_API_URL": "http://127.0.0.1:4100" } } } }
```

### 常驻（launchd）

**用户级（登录后自启）**：参考 `examples/com.opencode-feishu-bridge.plist`，放入 `~/Library/LaunchAgents/` 并 load。

**系统级（开机免登录自启）**：用 `examples/com.example.opencode-feishu-bridge.daemon.plist`（含 `UserName`/`GroupName`，以指定用户运行），
替换文件里的 `/ABS/PATH/TO` 与 `YOUR_USER` 后，以 root 安装到 `/Library/LaunchDaemons/` 并 bootstrap 到 system 域：

```bash
sudo cp com.example.opencode-feishu-bridge.daemon.plist /Library/LaunchDaemons/com.example.opencode-feishu-bridge.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.example.opencode-feishu-bridge.plist
sudo launchctl kickstart -k system/com.example.opencode-feishu-bridge
```

从用户级迁移到系统级时，先停掉并删除旧的用户级 LaunchAgent，避免双实例抢 4096 端口：

```bash
launchctl bootout gui/$(id -u)/com.opencode-feishu-bridge 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.opencode-feishu-bridge.plist
```

KeepAlive 保证崩溃/自重启后自动拉起。

## 目录结构

```
opencode-feishu-bridge/
├── bin/
│   ├── opencode-feishu-start.js   # ofbs：启动桥（node dist/main.js）
│   └── opencode-attach.js         # ofbc：opencode attach 到本桥 serve 的快捷命令
├── dist/                          # 纯 CommonJS，无编译步骤
│   ├── config.js                  # 配置加载/校验（zod）
│   ├── interaction.js             # 提问/授权/菜单卡片的纯函数构建与文本解析
│   ├── opencode.js                # opencode serve 生命周期 + HTTP/SSE 客户端 + 多目录事件订阅
│   ├── opencode-exec.js           # opencode CLI 跨平台启动/终止（Windows .cmd 垫片、taskkill）
│   ├── table-card.js              # Markdown 表格 → 飞书卡片原生表格组件
│   ├── main.js                    # 桥主程序：飞书事件、本地命令、转发、HTTP API
│   └── feishu-mcp-server.js       # 可选 stdio MCP server（feishu_send_file）
├── scripts/                       # 安装/卸载脚本、单元测试（test-table-card.js / test-opencode-exec.js）
├── skills/feishu-bridge/          # 提供给模型的 Skill（桥能力说明）
├── examples/                      # launchd 常驻示例
├── config.example.json
├── package.json
├── README.md
├── CHANGELOG.md
└── LICENSE
```

## 开发与质量

- 纯 JS（CommonJS），无需构建；改完直接 `node dist/main.js` 运行
- 语法检查：`npm run typecheck`
- 提交前建议：`node --check` 全部 dist 文件、`npm pack --dry-run` 核对发布内容

### serve 看门狗（自动恢复卡死）

桥会按 `GET /session` 心跳监控 `opencode serve`：连续失败达阈值（默认 6 次，约 3 分钟）即判定卡死，
自动 `SIGTERM`（5 秒后升级 `SIGKILL`）重启 serve、重建 SSE 事件订阅，并给受影响用户发飞书提示。
若心跳失败期间仍有工具调用在运行（如 DevEco / hvigorw 构建）且未超过宽限（默认 30 分钟），
则视为合法长任务、不重启，避免误杀长时间构建。

看门狗还带一个**每日定时重启**：默认每天 `03:00`（本地时间）检查一次，若此刻**没有任务在运行**
就主动重启一次 serve，用于定期回收 long-run 累积的内存与文件句柄。**有任务在跑时绝不打断**——
只在等待窗口内空转，窗口内一旦空闲就重启，超过窗口则当天跳过、次日再试；当天最多触发一次。
若恰好刚被心跳看门狗重启过（默认 30 分钟内），也会跳过当天，避免同日重复重启。
定时重启默认静默（凌晨 3 点不打扰用户），需要通知时开启 `OPENCODE_DAILY_RESTART_NOTIFY=on`；
"是否空闲"综合判断：本地消息队列、SSE 跟踪到的运行中工具、以及 serve 侧的会话状态。

可用环境变量调整（launchd 的 `EnvironmentVariables` 或直接 export）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OPENCODE_SERVE_WATCHDOG` | 开启 | 设为 `off` / `0` / `false` / `no` 关闭看门狗 |
| `OPENCODE_WATCHDOG_INTERVAL_MS` | `30000` | 心跳探测间隔 |
| `OPENCODE_WATCHDOG_FAIL_THRESHOLD` | `6` | 连续失败多少次判定卡死 |
| `OPENCODE_WATCHDOG_TOOL_GRACE_MS` | `1800000` | 运行中工具的宽限（毫秒） |
| `OPENCODE_DAILY_RESTART` | `03:00` | 每日定时重启时间（本地 `HH:MM`）；`off` / `0` / `false` / `no` 关闭 |
| `OPENCODE_DAILY_RESTART_WINDOW_MS` | `3600000` | 到点仍在忙时的等待窗口（毫秒），窗口内等到空闲才重启 |
| `OPENCODE_DAILY_RESTART_NOTIFY` | 关闭 | 设为 `on` / `1` / `true` / `yes` 时推送定时重启通知 |

## 常见问题

**收不到任务进度/结果？**
确认会话所在工作目录：事件流按目录隔离，桥只订阅「当前 attach 会话目录 + 默认目录」。
跨目录会话请用 `/session <id>` 恢复（会自动订阅其目录），或 `config.json` 里把 `opencodeWorkdir` 指到该目录。
另外转发目标 chat 会随 `session-state.json` 持久化，重启后无需重新发消息即可继续接收外部 attach 进展。

**卡片按钮/下拉点了没反应？**
需要在飞书后台订阅 `卡片回传交互`（card.action.trigger）。未订阅时使用文本兜底：回复命令/编号。（下拉选择同样走该回调，选中值在 `action.option`。）

**`/m` 菜单没有下拉、只有按钮？**
说明当前应用/客户端未接受卡片 JSON 2.0，桥已自动回退到 1.0 按钮卡片，菜单功能不受影响（日志可见 `select_card_rejected_fallback`）。

**回复里的表格显示成一堆带 `|` 的原文？**
飞书富文本 `post` 的 `md` 标签在移动端等客户端不渲染 GFM 表格。桥已改为**含表格的回复自动发卡片**
（表格用卡片原生表格组件），无需额外配置；若客户端连卡片也不支持，可退回 `FEISHU_TABLE_CARD=off` 并改用
`/status` 里的 attach 命令在终端查看。

**为什么单轮对话只收到一条「任务完成」？**
阶段消息有 3 秒缓冲（`PHASE_DEBOUNCE_MS`），单轮快答不会产生「任务持续中」中间态；长任务在结束时把中间消息原地更新为最终消息。

**/m 菜单里看不到别的目录的旧会话？**
`/sessions` 列的是默认目录（serve 启动目录）下的会话；跨目录会话请直接用 `/session <session_id>`。

**想在电脑终端里接手飞书里的这个会话？**
发 `/status`，最后一段就是可直接复制的命令（飞书里以代码块展示）：

```bash
opencode attach http://127.0.0.1:4096 -s <session_id> --dir <会话工作目录>
```

在同一台机器（桥所在的 Mac）的终端里执行，即可用 opencode TUI 接着聊同一个会话。
`--dir` 必须带上：opencode serve 的会话与事件流按目录隔离，缺了它可能定位不到同一会话。
若桥配置里 `opencodeServeHost` 是 `0.0.0.0`，命令会自动改写成 `127.0.0.1`。

**任务跑偏了 / 想让它停下来？**
发 `/esc`：桥会调用 `POST /session/{id}/abort` 真正中断服务端正在执行的生成与工具调用（等价在终端 attach 的界面里按 Esc），
已产生的输出仍会照常回传，随后可直接发下一条消息继续。
`/stop` 只是本地停止转发进展，服务端任务仍在跑；`/restart` 是重启桥。

**发消息后只回了「已提交 OpenCode，开始处理…」就再没下文？**
说明当前工作目录对应的 opencode 实例卡住了（典型成因：任务还在**初始化阶段就被中断**——
opencode 的已知行为，被中断后该目录的所有 prompt 都会在毫秒级被 abort，模型根本不会被调用）。
桥会自动识别（HTTP 200 + `MessageAbortedError` + 耗时 < 1.5 秒）并**自动重启 `opencode serve`** 恢复，
飞书里会收到「工作区实例卡住…已自动重启」的提示，稍后重发即可（日志 `[recover]`）。
5 分钟内只自动重启一次，避免"每条消息都重启"；会话都存在 DB 里，重启不会丢。
若仍无响应，发 `/restart`。

**飞书 API 偶发 api_timeout？**
桥对飞书 API 加了 30 秒硬超时；网络抖动会跳过该次推送（任务不受影响，可等下一阶段或发送任意消息触发重试）。

**opencode 卡死 / 一直没响应？**
桥内置 serve 看门狗：心跳连续超时会自动重启 `opencode serve` 并通知你（日志 `[watchdog]`）。
若你的超长任务（>30 分钟构建）被误判，可调大 `OPENCODE_WATCHDOG_TOOL_GRACE_MS`。

**每天凌晨会自动重启一次 opencode 吗？**
会，默认 `03:00`：只有在**当时没有任务在跑**时才重启；若正在跑任务，会在窗口（默认 60 分钟）内
等它跑完再重启，等不到就顺延到次日，**不会打断任务**。想换时间改 `OPENCODE_DAILY_RESTART=04:30`，
不想用就设 `off`。日志里能看到 `每日定时重启` 或 `定时重启跳过`。

**Windows 上启动报 `spawn opencode ENOENT` / `EINVAL`？**
桥没能定位到 opencode 可执行文件。本仓库已内置 Windows 解析（真 `.exe` → `.cmd` 垫片 → `cmd.exe` 兜底，
见「Windows（原生）」）。若安装方式比较特殊，指定绝对路径后重启即可：

```powershell
$env:OPENCODE_BIN = "C:\tools\opencode\opencode.exe"
```

启动日志里的 `[opencode-serve ...]: launch kind=... source=...` 会告诉你实际用了哪一种。

## 发布

仓库：<https://github.com/xemoon123/opencode-feishu-bridge>

1. 提交并推送：`git add -A && git commit -m "..." && git push`
2. 打 tag：`git tag v1.1.0 && git push origin v1.1.0`
3. 发布 npm（如需）：`npm pack --dry-run` 检查内容 → `npm publish --access public`

`.gitignore` 已排除 `node_modules/`、日志、`*.bak`、`.env*` 与 `.config/`；提交前请确认
`~/.config/opencode/feishu-bridge/config.json`（含 appSecret）与 `session-state.json` 从未进入仓库。

## License

[ISC](./LICENSE)
