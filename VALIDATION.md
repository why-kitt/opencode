# 本地验证记录

日期：2026-10-02。Windows x64，Bun 1.4.1。

- 上游：`anomalyco/opencode`，tag `v1.18.34`。
- 上游 commit：`aec0b9a6d8898f68f923aaf08b7306d931fd9d76`。
- 产物版本：`1.18.34-patched.1`。
- 临时文件：`E:\temp\opencode-build`；依赖缓存：`E:\temp\opencode-bun-cache`。

## 已完成

| 验证 | 结果 |
|---|---|
| core、opencode、tui 的 `bun typecheck` | 全部通过 |
| 重试策略、配置校验、运行时控制及真实 Worker RPC | 87 项通过 |
| TUI 命令分发与上游剪贴板测试 | 9 项通过 |
| 上游 Windows 子进程捕获、管道及终止测试 | 24 项通过 |
| Python 补丁应用器测试 | 5 项通过 |
| JSON 补丁锚点与干净源码还原 | 22 处改动、16 个文件逐一一致 |
| Windows x64 CLI 构建（含嵌入式 Web UI） | 成功，`--version` 为 `1.18.34-patched.1` |
| 编译后 CLI 对接本机模拟服务 | 允许 8 次重试时，失败 7 次后成功；上限 2 时恰好 3 个请求 |
| 完整 TUI + ConPTY + 本机模拟服务 | 查询和非法命令不发模型请求；运行中修改间隔、次数生效；原有等待不提前结束 |
| 发布包 | ZIP 完整性检查通过；解压到 E:\\temp 后独立 CLI 验证通过；附带 .patch 可还原全部修改 |

共 125 项自动化测试，另有补丁还原、构建、二进制和完整 TUI 验证。模拟服务始终在本机，未调用付费模型。

TUI 验证根据真实 HTTP 请求次数与时间判断功能；终端采用增量重绘，不能将原始输出简单拼接当作完整屏幕文本。固定 40ms 的后续请求实测约 45–60ms（含处理开销），首次已开始的 1000ms 等待保持完成。

Windows 检查发现上游通用进程、Effect spawner、LSP 和 taskkill 已有隐藏窗口参数；本补丁补齐剪贴板 PowerShell 路径。未改交互式 PTY 行为。

GitHub 仓库、push、Actions 云端执行和 Release 发布由用户后续操作；本次未执行。流水线 YAML 已解析检查，固定的 Bun 1.4.1 官方 release 已确认存在。
