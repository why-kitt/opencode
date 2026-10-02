# OpenCode patched Windows x64

解压后运行 `opencode.exe`。这是普通 x64 构建，需要支持 AVX2 的 CPU。

将 `reconnect.example.json` 的 `reconnect` 段合并到自己的 `opencode.json` 或 `opencode.jsonc`，不要覆盖已有配置。官方在线 schema 不认识私有补丁字段；编辑器可能提示额外字段，但本补丁版会校验并支持它。

```text
/reconnect
/reconnect default
/reconnect fixed 3000
/reconnect retries 5000
/reconnect retries default
```

- `fixed` 间隔为 1–2147483647 毫秒的整数，忽略服务端 Retry-After。
- 重试次数为 1–10000，表示初次请求失败后额外允许的重试次数。
- `default` 恢复上游指数退避和 Retry-After 行为，不改变次数覆盖。
- `retries default` 恢复上游 5 次，不是配置文件中的自定义次数。
- 命令只改变当前本地 CLI 后端进程的内存，主代理和子代理共享覆盖；重启后重新读配置。已经开始的等待不会提前结束，下一次重试判断采用新设置。
- `/reconnect` 是完整 TUI 的内置命令，不会提交给模型；远程 attach、远程 workspace 不支持。`opencode run` 和 `--mini` 使用启动配置，未增加动态命令入口。
- 不配置 `reconnect` 时保留上游重试策略；补丁不扩大哪些错误可以重试。
- 版本号带 `-patched.1`，自动更新不会把它替换为官方包。手动升级请下载自己构建的新包。
- Windows 剪贴板 PowerShell 调用增加隐藏窗口参数；上游 Git/shell/LSP 进程封装已有隐藏窗口设置，交互终端保持原行为。
- 子代理没有新增数量配额，沿用上游 `subagent_depth` 默认 1 层及权限规则。

`build-info.json` 记录上游 commit、版本和校验值。并行发布的 `.patch` 包含全部源码变更（包括验证测试）。
