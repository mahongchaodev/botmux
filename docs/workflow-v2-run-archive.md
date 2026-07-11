# Workflow v2 run 静态归档

v2 runtime 删除前，历史 run 会被一次性固化成私有、内容寻址的静态归档。归档不是可执行资产，也不保留 replay/runtime 代码；它只保存审计字节与删除前的 ops projection。

## 命令

```bash
# 零写入扫描：必须先确认所有 run 已终态
botmux template archive-runs

# 创建归档；发布后自动执行静态校验 + live source/projection 对账
botmux template archive-runs --commit

# PR5-D 删除 v2 读写面前重新执行双关校验
botmux template archive-runs --verify sha256:<digest>
```

默认源目录为 `BOTMUX_WORKFLOW_RUNS_DIR`，否则为 Botmux durable dataDir 下的 `workflow-runs/`；归档默认写入同一 dataDir 下的 `workflow-archives/v2-runs/`。可用 `--runs-dir` / `--archive-dir` 显式覆盖。

## 归档契约

- 每个有效 run 的源目录逐字节复制到 `runs/<runId>/raw/`，并用删除前的 `ops-projection` 生成 `projection.json`。
- 无事件日志的历史残目录/文件也复制到 `residual/`，不会静默丢弃。
- `manifest.json` 覆盖全部目录拓扑（包括空目录）、文件长度和 SHA-256、终态 verdict、缺失的历史可选文件与 warning。
- `COMMITTED` 是最终 commit marker，认证 manifest；目标目录由 manifest content hash 决定。
- 目录强制 `0700`、文件强制 `0600`。归档包含参数、日志预览和绝对路径等敏感审计数据，不提供 dashboard/public reader。

## 发布与验证

发布在同文件系统 staging 中完成：严格预扫 → 安全 fd 复制 → 再次全量哈希与 projection → 写 manifest → 原子 rename → 写 commit marker → 静态 + source-aware 校验。任何 symlink、hardlink、FIFO/socket/device、坏 journal、非终态 run、并发修改或已有目标冲突都会 fail-loud；不会修复或覆盖源数据。

静态 verifier 不信任 manifest：它会独立遍历目录，拒绝 extra/missing/type/mode 变化并重算所有 hash。source-aware verifier 还会重算 live source 树和当前 ops projection。

## PR5-D 删除门

只有同时满足以下条件，才允许删除 v2 runtime/read paths：

1. 最新归档 `staticVerified=true`；
2. 对仍存在的 live v2 runs 执行校验得到 `sourceVerified=true`；
3. inventory 中不存在非终态 run；
4. manifest 覆盖所有 run 与 residual，warning 已人工审阅。

本地 SHA-256 用于发现损坏与普通并发修改，不宣称抵御同一 OS 用户主动同时篡改源和 manifest；需要防篡改审计时应使用签名或 WORM/远端存储。
