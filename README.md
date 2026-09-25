# opencode-feishu-bridge

把飞书机器人接到本机 [OpenCode](https://opencode.ai) 的桥接服务：飞书消息 → `opencode serve` → 回答/进度/结果回传飞书。
支持 macOS / Linux / Windows，走飞书长连接，无需公网回调地址。

> 基于 `Lanfei/opencode-feishu-bridge` 迭代的增强版：桥自己拉起并驱动 `opencode serve`（不再使用 `opencode run` 子进程），
> 因此支持任务内提问/授权、跨目录会话事件转发、进度合并为单条消息。

## 功能特性

- 飞书长连接（WS）收发消息，私聊/群聊按 `allowedOpenId` 白名单控制
- **任务内交互**：OpenCode 的 `question` / `permission` 渲染为交互卡片，可点按钮或直接回复文本
- **`/m` 菜单卡片**：会话、工作目录、模型三个下拉选择，选中即执行，另有按钮与编号兜底
- **`/esc` 中断**：停止服务端正在执行的生成与工具调用（等价在终端 attach 里按 Esc）
- **表格渲染**：含 Markdown 表格的回复自动改发卡片原生表格组件
- 进度收敛：单轮快答只发一条最终消息；长任务先发「⏳ 任务持续中…」，结束时原地更新为「✅ 任务完成…」
- 文件直发：`feishu_send_file` MCP 工具，把工作区内文件作为真实文件消息发出
- 被动监听：外部 `opencode attach` 客户端在同一会话发起的任务，进展同样转发到飞书
- 稳定性：serve 看门狗（心跳重启 + 每日空闲重启）、工作区实例卡死自愈、会话状态跨重启持久化

## 环境要求

- Node.js >= 20
- OpenCode CLI（`npm i -g opencode-ai` 或官方二进制），并已配置可用的 provider/model
- 一个飞书自建应用（机器人能力 + 长连接事件订阅）
- macOS / Linux / Windows 10 1809+ 或 Windows 11（原生，无需 WSL）

## 安装

```bash
# npm
npm i -g @xemoon/opencode-feishu-bridge
ofbs                 # 首次运行会引导创建配置

# 或源码运行
git clone https://github.com/xemoon123/opencode-feishu-bridge.git && cd opencode-feishu-bridge
npm install
npm start            # 等价 node dist/main.js
npm i -g .           # 可选：安装 ofbs / ofbc / ofbs-mcp 命令
```

> npm 上不带作用域的 `opencode-feishu-bridge` 是**上游作者的包**，安装请带上 `@xemoon/` 前缀。
> 包页面：<https://www.npmjs.com/package/@xemoon/opencode-feishu-bridge>

首次启动若 `~/.config/opencode/feishu-bridge/config.json` 不存在，会引导创建；也可按 `config.example.json` 手动创建。
Windows 下同一路径为 `%USERPROFILE%\.config\opencode\feishu-bridge\config.json`。

### Windows

```powershell
npm i -g opencode-ai
npm i -g @xemoon/opencode-feishu-bridge
ofbs
```

Windows 上 opencode 通常以 `opencode.cmd` 垫片安装，桥会自动解析到真实 `opencode.exe`，启动日志会打印
`launch kind=... source=...`。若装在非标准位置，用绝对路径覆盖：

```powershell
$env:OPENCODE_BIN = "C:\tools\opencode\opencode.exe"
```

常驻（开机自启）可用任务计划程序，或 `pm2` / `nssm`：

```powershell
schtasks /Create /TN opencode-feishu-bridge /SC ONLOGON /RL LIMITED /F ^
  /TR "\"%ProgramFiles%\nodejs\node.exe\" \"%APPDATA%\npm\node_modules\@xemoon\opencode-feishu-bridge\dist\main.js\""
```

## 飞书开放平台后台最小配置

1. 创建自建应用，启用「机器人」能力
2. 事件订阅选择**长连接**方式
3. 订阅事件：`接收消息 v2.0`（im.message.receive_v1）、`消息撤回事件`（im.message.recalled_v1）
4. 订阅 `卡片回传交互`（card.action.trigger）——不订阅则卡片按钮与下拉不可用，仍可回复文本兜底
5. 发布版本并添加权限：读取与发送消息（`im:message` 等）

## 配置文件

路径 `~/.config/opencode/feishu-bridge/config.json`（zod 校验，非法字段启动即退出）。修改后重启桥生效。

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `feishuAppId` / `feishuAppSecret` | 飞书应用凭证 | 必填 |
| `allowedOpenId` | 允许使用的 open_id（数组或逗号分隔）；空 = 允许所有（启动有安全告警） | `[]` |
| `opencodeWorkdir` | 默认工作目录 | `~/OpenCode` |
| `opencodeModel` | 默认模型 | 空（跟随 opencode） |
| `opencodeTimeout` | 长静默提醒阈值（毫秒，不中断任务） | `600000` |
| `opencodeServeHost` / `opencodeServePort` | 本机 `opencode serve` 监听地址，需保持空闲 | `127.0.0.1` / `4096` |

## 使用

直接发文本即提问。以下均为本地命令（不消耗模型额度）；其他以 `/` 开头的未知文本会当作普通消息发给模型。

| 命令 | 说明 |
| --- | --- |
| `/m`、`/menu` | 菜单卡片：会话/目录/模型下拉选择 + 按钮与编号兜底 |
| `/help` | 完整指引 |
| `/new` | 清空上下文开新会话（保留当前工作目录）；`/new <目录>` 切到指定目录 |
| `/reset` | 清空上下文，回到默认工作目录开新会话 |
| `/session` | 查看当前 attach 会话 |
| `/session <编号\|session_id>` | 恢复/切换会话（跨目录会自动订阅其事件目录） |
| `/sessions` | 会话列表（不切换） |
| `/model`、`/models` | 查看 / 切换模型（下一条消息生效） |
| `/status` | 会话、目录、队列、任务与配置状态，并附本机终端 attach 该会话的命令 |
| `/esc` | 中断服务端正在执行的任务（等价终端里按 Esc） |
| `/stop` | 本地停止转发该会话进展（服务端任务继续；下一条消息恢复） |
| `/restart` | 重启桥（launchd / 任务计划程序会自动拉起） |

### 菜单卡片（/m）

蓝底卡片（卡片 JSON 2.0）分三块：**当前上下文**（会话 / 目录 / 模型）、**下拉选择**（历史会话、历史工作目录、可用模型，
选中即执行）、**操作按钮**（等价于上表命令，带编号兜底）。应用或客户端不接受 2.0 卡片时自动回退 1.0 按钮卡片。

### 任务内交互

- `question`：蓝色卡片，可点选项、回复编号/选项文字或自定义内容
- `permission`：橙色卡片，允许一次 / 始终允许 / 拒绝
- 等待默认 10 分钟，超时自动跳过并通知；`/esc` 会中断任务并撤销挂起提问

### 消息渲染（Markdown / 表格）

助手输出默认按飞书富文本 `post` + `md` 标签发送（标题、列表、代码块、引用等）。
**含 GFM 表格时自动改发卡片**：表格用卡片原生表格组件渲染（表头、列宽、行高自适应，超 10 行自动分页），
其余段落仍由卡片 markdown 渲染；没有表格的消息行为不变。

可用 `FEISHU_TABLE_CARD` 调整：`table`（默认）/ `markdown`（整段进卡片 markdown）/ `off`（始终用 post）。
表格超过 20 列或卡片超过飞书 30KB 上限时自动退回 post。

### 技能与 MCP（可选）

```bash
node scripts/install.js      # 或 npm run setup
node scripts/uninstall.js    # 或 npm run uninstall
```

- 把 `skills/feishu-bridge/SKILL.md` 安装到 `~/.config/opencode/skills/feishu-bridge/`，让模型按需了解桥的能力
- 在 `~/.config/opencode/opencode.jsonc` 的 `mcp` 段注册 `feishu-bridge`（指向 `dist/feishu-mcp-server.js`），
  模型即可调用 `feishu_send_file`，把工作区内文件（≤ 20MB）作为真实文件消息发出

## 常驻运行

**macOS（launchd）**：用户级用 `examples/com.opencode-feishu-bridge.plist` 放入 `~/Library/LaunchAgents/`；
系统级（开机免登录）用 `examples/com.example.opencode-feishu-bridge.daemon.plist`，替换 `/ABS/PATH/TO` 与 `YOUR_USER` 后
以 root 安装到 `/Library/LaunchDaemons/` 并 `launchctl bootstrap system`。KeepAlive 保证崩溃自动拉起。

**Windows**：见上文任务计划程序示例，或使用 `pm2` / `nssm`。

**Linux**：写一个 systemd unit，`ExecStart=/usr/bin/node <路径>/dist/main.js` 即可。

## serve 看门狗

桥按 `GET /session` 心跳监控 `opencode serve`：连续失败达阈值（默认 6 次 ≈ 3 分钟）即重启 serve、重建 SSE 订阅并通知用户；
若期间仍有工具调用在运行且未超过宽限（默认 30 分钟），视为合法长任务不重启，避免误杀长时间构建。

另带**每日定时重启**：默认 `03:00` 在无任务运行时重启一次 serve（回收内存/句柄）；有任务在跑时在等待窗口内等空闲，绝不打断。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OPENCODE_SERVE_WATCHDOG` | 开启 | 设为 `off` 关闭看门狗 |
| `OPENCODE_WATCHDOG_INTERVAL_MS` | `30000` | 心跳探测间隔 |
| `OPENCODE_WATCHDOG_FAIL_THRESHOLD` | `6` | 连续失败多少次判定卡死 |
| `OPENCODE_WATCHDOG_TOOL_GRACE_MS` | `1800000` | 运行中工具的宽限（毫秒） |
| `OPENCODE_DAILY_RESTART` | `03:00` | 每日定时重启时间（`HH:MM`，设 `off` 关闭） |
| `OPENCODE_DAILY_RESTART_WINDOW_MS` | `3600000` | 到点仍在忙时的等待窗口 |
| `OPENCODE_DAILY_RESTART_NOTIFY` | 关闭 | 设为 `on` 时推送定时重启通知 |

## 常见问题

**收不到任务进度/结果？**
事件流按目录隔离，桥只订阅「当前 attach 会话目录 + 默认目录」。跨目录会话请用 `/session <id>` 恢复，
或把 `config.json` 的 `opencodeWorkdir` 指到该目录。

**卡片按钮/下拉点了没反应？**
需要在飞书后台订阅 `卡片回传交互`（card.action.trigger）。未订阅时可用文本兜底：回复命令或编号。

**回复里的表格显示成一堆带 `|` 的原文？**
飞书部分客户端不渲染富文本 `md` 里的表格。桥已默认把含表格的回复改发卡片；若客户端连卡片表格也不支持，
可设 `FEISHU_TABLE_CARD=off` 退回富文本，并用 `/status` 给出的命令在终端查看。

**任务跑偏了 / 想让它停下来？**
`/esc` 真正中断服务端任务（等价按 Esc）；`/stop` 只是本地停止转发；`/restart` 是重启桥。

**发消息后只回了「已提交 OpenCode，开始处理…」就再没下文？**
多为工作区实例卡住（任务在初始化阶段被中断所致）。桥会自动识别并重启 `opencode serve`，
飞书里会收到「已自动重启」的提示，稍后重发即可；仍无响应可发 `/restart`。

**想在电脑终端接手飞书里的会话？**
发 `/status`，最后一段就是可直接复制的命令：

```bash
opencode attach http://127.0.0.1:4096 -s <session_id> --dir <会话工作目录>
```

**opencode 卡死 / 一直没响应？**
桥内置 serve 看门狗会自动重启并通知；超长构建被误判时调大 `OPENCODE_WATCHDOG_TOOL_GRACE_MS`。

**Windows 上启动报 `spawn opencode ENOENT` / `EINVAL`？**
桥没能定位到 opencode。用 `OPENCODE_BIN` 指定绝对路径后重启，日志里的 `launch kind=...` 会说明实际启动方式。

## 目录结构

```
opencode-feishu-bridge/
├── bin/                      # ofbs（启动）、ofbc（attach 快捷命令）
├── dist/                     # 纯 CommonJS，无编译步骤
│   ├── main.js               # 桥主程序：飞书事件、本地命令、转发、HTTP API
│   ├── opencode.js           # opencode serve 生命周期 + HTTP/SSE 客户端
│   ├── opencode-exec.js      # opencode CLI 跨平台启动/终止
│   ├── interaction.js        # 卡片构建与文本解析
│   ├── table-card.js         # Markdown 表格 → 卡片原生表格组件
│   ├── config.js             # 配置加载/校验
│   └── feishu-mcp-server.js  # 可选 stdio MCP server（feishu_send_file）
├── scripts/                  # install / uninstall + 单元测试
├── skills/feishu-bridge/     # 提供给模型的 Skill
├── examples/                 # launchd 常驻示例
└── config.example.json · package.json · CHANGELOG.md · LICENSE
```

## 开发

纯 CommonJS，无构建步骤；改完直接 `node dist/main.js` 运行。

```bash
npm run typecheck    # 全部 dist 文件语法检查
npm test             # 单元测试
```

## License

[ISC](./LICENSE)
