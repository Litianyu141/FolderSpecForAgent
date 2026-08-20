# 参与开发

[← 回到 README](README.zh-CN.md) · [English](CONTRIBUTING.md)

前置：Node ≥ 20、pnpm。

```bash
pnpm install
pnpm typecheck      # 会先构建 core，其余包依赖它的 .d.ts
pnpm -r test
pnpm -r build
```

四个包：

| 包 | 职责 |
|---|---|
| `@folderspec/core` | 纯逻辑：解析、序列化、扫描、git 状态、merge，以及宿主无关的 `Session` |
| `@folderspec/ui` | React SPA，只通过 `Bridge` 抽象和宿主对话，对宿主一无所知 |
| `folderspec` | CLI 宿主：HTTP + WebSocket + 无边框浏览器窗口 |
| `folderspec-vscode` | VSCode 宿主：`CustomTextEditorProvider` |

**`@folderspec/core` 必须先构建**，其他包的 typecheck 才能通过（`pnpm typecheck` 已经包含这一步）。

VSCode 的端到端冒烟测试单独跑，需要图形环境：

```bash
pnpm -C packages/vscode test:e2e
```

### 两条不变量

- **每一次写盘之前都先自校验**：`serialize → parse` 走一遍，读不回来就中止写入。这道闸门在
  `Session.raw()` 上，所以直接落盘的 CLI 和走 `WorkspaceEdit` 的 VSCode 都受它保护。
- **绝不用空契约覆盖用户的文件**：契约文件解析失败、或者存在但读不出来（权限、被别的进程
  占用……），会话一律进入只读模式并显示原因，而不是当成"没有文件"从头开始。
