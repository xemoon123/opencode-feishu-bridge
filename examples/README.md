# examples

- com.opencode-feishu-bridge.plist   macOS launchd 常驻示例（替换 /ABS/PATH/TO 与 /Users/YOU 后使用）
  安装：cp 该文件到 ~/Library/LaunchAgents/ 后执行 launchctl load -w <plist>
  移除：launchctl unload -w <plist>；重载：launchctl kickstart -k gui/$(id -u)/com.opencode-feishu-bridge

飞书开放平台后台需要的最小配置见项目根 README。

- com.example.opencode-feishu-bridge.daemon.plist  系统级 LaunchDaemon 示例（开机免登录，以 UserName 运行）
  替换文件里的 /ABS/PATH/TO 与 YOUR_USER 后，需 root 安装到 /Library/LaunchDaemons
