# opencode-patched-builder

手动触发 GitHub Actions，拉取 `anomalyco/opencode` 正式 release，校验并应用补丁，构建 Windows x64 CLI（包含上游嵌入式 Web UI），上传 Artifact，并按开关发布到自己的仓库 Release。

当前补丁基线：`v1.18.34`。构建工具固定为已验证的 Bun `1.4.1`（满足上游 `^1.3.14` 要求），记录在 `build.json`。这是独立的补丁仓库，不要把整个 OpenCode 源码和 `node_modules` 推上去。

## 功能

- `opencode.json/jsonc` 支持 `reconnect.mode`、`interval_ms`、`max_retries`。
- 完整 TUI 支持 `/reconnect`，运行中也可更改下一次重试采用的设置，覆盖仅存在当前本地后端进程内，主代理与子代理共享。
- 固定间隔忽略 Retry-After；默认模式保留上游退避策略；重试次数接受 1–10000。
- 补齐 Windows 剪贴板 PowerShell 后台命令的隐藏窗口参数。
- 版本号带 `-patched.N`，禁用这类构建的官方自动更新，避免覆盖补丁。
- 子代理不增加数量限制，保留上游默认嵌套深度 1 和权限检查。

具体命令、边界和配置示例见 [RUNNING.md](RUNNING.md)。`opencode run` 与 `--mini` 使用启动配置；动态命令入口在完整 TUI。远程 attach/workspace 不接受本地运行时覆盖。

## GitHub Actions

1. 将本目录推到你自己的私有仓库，启用 Actions。
2. 打开 **Build patched Windows x64 → Run workflow**。
3. 首次建议 `tag` 填 `v1.18.34`；留空会查询最新正式 release。上游更新后若锚点不再匹配，流水线会在构建前停止，需要重新维护补丁。
4. `publish_release` 控制是否发布 Release；关闭时仍上传 Artifact。

产物位于 Artifact `opencode-windows-x64`（保留 7 天）和可选 Release：

```text
opencode-1.18.34-patched.1-windows-x64.zip
opencode-1.18.34-patched.1-windows-x64.patch
opencode-1.18.34-patched.1-windows-x64.json
SHA256SUMS.txt
```

zip 保留上游 CLI 的可执行文件布局，另含使用说明、配置示例与构建信息。附带 diff 包含新增文件和测试；JSON 记录真实上游 commit、Bun 版本及哈希。标准 x64 构建要求 AVX2，未构建桌面安装器、ARM64 或 baseline 包。

Actions 会依次执行：补丁应用器测试、锚点检查、依赖安装、类型检查、重试与 Worker 测试、TUI 单测、构建、Windows 子进程测试、编译后二进制的模拟服务测试和完整 ConPTY TUI 测试。失败不会发布新包。模拟服务全部在本机运行，不调用付费模型。

## 本地构建（PowerShell）

需要 Git、Python 3.12+、Bun 1.4.1、Node.js（完整 TUI 验证使用）。从本仓库根目录执行：

```powershell
# 当前机器按用户要求把临时目录和 Bun 缓存放在 E:\temp。
New-Item -ItemType Directory -Force E:\temp\opencode-build,E:\temp\opencode-bun-cache | Out-Null
$env:TEMP = 'E:\temp\opencode-build'
$env:TMP = $env:TEMP
$env:BUN_INSTALL_CACHE_DIR = 'E:\temp\opencode-bun-cache'

git clone --depth 1 --branch v1.18.34 https://github.com/anomalyco/opencode.git opencode-src
python scripts/apply_patches.py --root opencode-src --check
python scripts/apply_patches.py --root opencode-src
# 每一步成功后再继续；失败时不要构建或发布。
Push-Location opencode-src
bun install --frozen-lockfile
Pop-Location
$env:OPENCODE_VERSION = '1.18.34-patched.1'
$env:OPENCODE_CHANNEL = 'latest'
$env:OPENCODE_RELEASE = ''
Push-Location opencode-src/packages/opencode
bun typecheck
bun test test/session/reconnect.test.ts test/session/reconnect-worker.test.ts test/session/retry.test.ts --timeout 60000 --only-failures
bun run script/build.ts --single --skip-install
Pop-Location
bun scripts/smoke.ts opencode-src/packages/opencode/dist/opencode-windows-x64/bin/opencode.exe
node scripts/tui-smoke.cjs opencode-src
python scripts/package.py --root opencode-src --tag v1.18.34 --version 1.18.34-patched.1
```

## 补丁维护

`scripts/apply_patches.py` 先检查全部改动，锚点缺失/重复或新文件已存在时不写入任何源码；`--check` 始终只检查。现有文件的 CRLF 会保留。路径不能越出源码目录。

在同一基线的源码目录完成修改和测试后：

```powershell
python scripts/capture_patches.py --root opencode-src --base v1.18.34
python scripts/verify_roundtrip.py --root opencode-src --base v1.18.34
python -m unittest discover -s tests -v
```

捕获脚本只收集 `packages/` 下的改动；请审阅生成的 `patches/windows-reconnect.json`，确保没有混入无关改动。还原测试从 Git 中导出干净基线，将补丁结果逐文件与已审阅源码比较。更新补丁后递增 `build.json` 的 `patch_revision`，同步版本示例，并重新跑构建和模拟服务验证。

本地验证记录见 [VALIDATION.md](VALIDATION.md)。GitHub 上的实际 Actions 运行需要你 push 后手动触发。
