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

## patched.2 — 2026-10-02

- 新增 subagent_default_background；配置 true 独立启用后台能力，显式 background:false 保持前台等待。
- packages/opencode bun typecheck 通过。
- task.test.ts：24 项通过（含默认后台、显式前台、A 完成通知和复用 ID 续派时 B 仍运行）。首次默认 5 秒超时遇到 8 个冷启动超时；按构建的 60 秒超时重跑全部通过。
- 配置全局读取及项目覆盖：2 项通过；retry.test.ts：60 项通过；reconnect/worker：27 项通过。
- 补丁应用器：5 项通过；JSON 补丁还原：21 个文件逐字节匹配。
- Windows x64 编译成功，内嵌 Web UI，版本 1.18.34-patched.2。
- 编译后后台集成：环境标志显式 false，配置 true；能力接口返回 true；真实主代理循环启动 A/B 后继续，A 完成通知唤醒主代理，复用 A 的 task_id 执行 A2 时 B 仍运行。使用本地模拟模型，无付费 API。
- 编译后重连：7 次错误后第 8 次成功；预算 2 时严格 3 次请求。
- 完整 ConPTY TUI：查询、非法输入、运行中更改间隔/次数通过，4 次请求间隔 1170/45/45 ms。
- 所有临时数据在 E:\temp；未推送或发布。Actions 新增后台任务、配置合并和编译后回调验证。

## Actions Windows cleanup fix — 2026-10-02

The background behavior test passed in Actions, but teardown failed with EBUSY while removing its temporary directory. The test now requests backend disposal, terminates its own Windows process tree, and explicitly retries temporary-directory cleanup. If Windows retains a directory lock after 5 seconds, it prints a warning with the path; this cleanup-only condition does not turn passing assertions into a failure. Other cleanup errors and behavioral failures still fail the step. PASS is printed after teardown.

Validated with Bun 1.4.1 on Windows: 4 cleanup tests passed using real child processes and directory locks, including process-tree termination, a released lock, a persistent lock and path-boundary protection. The compiled background callback/reassignment smoke passed with exit code 0. This changes builder tests only; the executable version remains 1.18.34-patched.2. GitHub Actions must be run after pushing the fix.

## Actions startup probe hardening — 2026-10-02

A later Actions run printed the server listening address but timed out during the health probe. The old probe discarded HTTP failures and connection errors, so the supplied log does not establish the exact original cause.

The smoke now lets the CLI allocate its listening port and reads the actual address from stdout. All control requests use node:http directly, with no pooled connection or environment proxy, a bounded request deadline and fully consumed response bodies. Child proxy/password settings are isolated from inherited runner settings. Readiness requires valid healthy=true JSON; rejected HTTP responses, network errors and backend logs are preserved in failures. The callback phase gets its own deadline after readiness.

Local Windows/Bun 1.4.1 validation: 8 helper tests passed (including 503-to-healthy, HTTP 401 diagnostics, invalid health JSON and stalled response timeout). The compiled background smoke passed both normally and with deliberately invalid proxy settings plus an inherited test server password. Exact reproduction on GitHub remains pending a new workflow run after pushing this change. No executable source or version changed.
