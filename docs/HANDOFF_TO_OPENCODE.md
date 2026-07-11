# ADE → OpenCode 接手说明

> 状态：编码已暂停，等待 OpenCode 接手  
> 工作目录：`D:\hermes\ADE`  
> 日期：2026-07-11

## 1. 用户目标

构建一个可实际使用的 Windows ADE（Agentic Document Environment），参考 `stablyai/orca` 的界面层级与操作逻辑，但以文档阅读、圈选批注和多 Agent 修改闭环为核心。

核心要求：

1. 支持 Hermes、Claude Code、Kimi Code、Codex 等多种本地 CLI Agent。
2. 一个项目绑定一个真实文件夹，Agent 的 `cwd` 必须是该项目目录。
3. 支持 Markdown、文本、图片、PDF、DOCX、PPTX、XLSX 等格式。
4. 用户可圈选文字或元素创建批注，并将批注发送给 Agent。
5. 项目、批注和 Agent 配置必须持久化。
6. Agent 修改前创建文件快照，允许恢复。

## 2. 已完成内容

### 方案与设计

- `ADE_Windows_Program_Framework.md`：完整产品与架构方案。
- `docs/ADR-001_IMPLEMENTATION_BASELINE.md`：MVP 执行模式与技术决策。
- `docs/UI_DESIGN.md`：初版界面设计基线。
- 已研究 `https://github.com/stablyai/orca` 的公开界面和源码结构。

从 Orca 借鉴的操作逻辑：

- 项目/工作空间和 Agent 会话集中在左侧。
- 文件、Agent 终端作为中心标签页打开。
- 右侧作为文件树或批注上下文面板。
- 批注可直接转成 Agent 输入。
- 多 Agent 通过独立会话呈现，不使用普通聊天气泡作为主界面。

### 前端

技术栈：React 19、TypeScript 7、Vite 8、Tauri 2。

当前已实现：

- 真实项目选择入口，不再使用演示项目。
- 最近项目和 Agent 检测状态的启动页。
- Orca 风格的项目/会话左侧栏、中心标签页、右侧检查器。
- 项目文件树、快速文件搜索和多文件标签。
- Monaco 文本编辑和保存状态。
- Markdown 渲染和文字圈选。
- 图片、PDF、DOCX、XLSX/CSV、PPTX 查看器代码。
- xterm.js Agent 终端组件。
- 批注创建、持久化、发送和恢复入口。

主要前端文件：

```text
src/App.tsx
src/lib/bridge.ts
src/types/domain.ts
src/components/Landing.tsx
src/components/ProjectSidebar.tsx
src/components/ProjectFileTree.tsx
src/components/FileViewer.tsx
src/components/AgentTerminal.tsx
src/components/AnnotationPanel.tsx
src/styles.css
```

### Rust/Tauri 后端

当前已写入：

- 项目目录递归扫描，忽略 `.git`、`node_modules`、`target` 等目录。
- 项目内路径规范化和目录逃逸检查。
- 文本/二进制文件读取、文本文件写入。
- `%APPDATA%` 中的 ADE 状态持久化。
- 已安装 Agent 命令检测。
- 使用 `portable-pty`/Windows ConPTY 启动 Agent、传递输入、接收输出、调整终端和停止进程。
- 任务文件快照与恢复命令。

主要后端文件：

```text
src-tauri/src/lib.rs
src-tauri/src/model.rs
src-tauri/src/project_files.rs
src-tauri/src/persistence.rs
src-tauri/src/agents.rs
src-tauri/src/snapshots.rs
```

## 3. 当前验证状态

已经通过：

- `npm install`
- `npm run check`（在最后一轮快照接口补丁之前通过）
- `npm run build`（在最后一轮快照接口补丁之前通过）

需要重新执行：

```powershell
cd D:\hermes\ADE
npm run check
npm run build
```

Rust 1.97 与 Cargo 1.97 已安装到 `%USERPROFILE%\.cargo\bin`。

尚未完成：

- Visual Studio 2022 Build Tools / MSVC workload 未安装成功。
- `cargo check` 曾开始下载依赖，但根据用户要求已经停止。
- 尚未完成 Tauri 原生窗口构建和端到端验收。

## 4. 已检测到的本地 Agent

```text
Hermes: %USERPROFILE%\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe
Claude: PowerShell/npm shim（Get-Command claude 可发现）
Kimi: %USERPROFILE%\.kimi-code\bin\kimi.exe
Codex: PowerShell/npm shim（Get-Command codex 可发现）
```

后端 `resolve_command()` 使用 `where.exe`。必须验证 Claude/Codex 的 `.cmd` 是否能被 `where.exe` 找到；如果只有 `.ps1`，需补充 PowerShell `Get-Command` 降级解析。

## 5. 优先检查的已知风险

### P0：先让工程重新通过检查

最后一次补丁加入了快照前端接口和恢复按钮，但尚未重新运行 TypeScript 检查。先修复所有类型错误，再处理 Rust。

### P0：Rust 后端尚未编译

重点检查：

- `portable-pty 0.9` 的 `Child`、`MasterPty` trait 对象约束。
- `CommandBuilder::new()` 和 `.args()` 在 Windows 路径下的参数类型。
- Tauri `AppHandle.emit()` 是否需要额外 trait 导入。
- Tauri capabilities 中 `dialog:default`、`opener:default` 是否与插件版本匹配。
- `cargo check` 依赖下载可能较慢，不要误判为死锁。

### P0：Agent 启动与提示发送时序

当前批注发送逻辑在启动 Agent 后固定等待 700 ms，然后写入提示。真实 TUI 的就绪时间不稳定，应改为：

- Provider 特定的就绪检测；或
- 首次启动后让用户确认终端已就绪；或
- 检测稳定输出/光标后再自动发送。

### P1：终端早期输出可能丢失

Agent 可能在 React 的 `AgentTerminal` 完成事件监听前产生输出。建议在 `bridge.ts` 或 App 层维护全局 Agent 事件缓冲，再由终端订阅回放。

### P1：Office 依赖和包体

- `pptx-preview` 带来若干弃用依赖，且其源代码许可说明特殊，需要重新评估是否适合正式分发。
- `FileViewer` 构建后重型依赖较多；已将整个查看器设为 `React.lazy`，但还应将 Monaco、ExcelJS、Mammoth、PPTX 各自动态导入。
- 上一次生产构建的重型查看器 chunk 总体约 3.5 MB。

### P1：安全与完整性

- DOCX HTML 已用 DOMPurify 清理。
- 快照目前只复制批注目标文件，不覆盖 Agent 可能修改的其他文件。
- 正式执行前，应扫描 Agent 实际变更集，并为允许写入范围建立完整快照。
- 文本写入当前是直接 `fs::write`，尚未实现原子替换。

## 6. 建议接手顺序

1. 运行 `npm run check`，修复最后补丁的 TypeScript 问题。
2. 安装 MSVC：

   ```powershell
   winget install --id Microsoft.VisualStudio.2022.BuildTools --exact `
     --accept-package-agreements --accept-source-agreements `
     --override "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```

3. 新开 PowerShell，设置 Cargo 路径并运行：

   ```powershell
   $env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"
   cd D:\hermes\ADE\src-tauri
   cargo check
   ```

4. 修复 Rust 编译问题。
5. 运行 `npm run tauri dev`，验证项目文件夹选择。
6. 使用 `D:\hermes\ADE` 自身作为测试项目，验证文件树、Markdown、保存和批注持久化。
7. 分别启动 Hermes、Kimi、Claude、Codex，验证 ConPTY 输入输出。
8. 用一个测试文件发送批注，验证快照、Agent 修改和恢复。
9. 再处理 Office 格式、包体拆分和 UI 精修。

## 7. 不应回退的产品决策

- ADE 的正式释义固定为 Agentic Document Environment。
- 项目对应真实目录，内部任务和批注使用项目相对路径。
- MVP 采用“直接事务模式”：Agent 直接写项目目录，接受表示保留，拒绝表示恢复。
- 多 Agent 可配置，但同一项目的写任务首期应串行。
- MCP 作为工具连接协议，不作为 Agent 会话生命周期协议。
- 纯终端 Agent 不得在 UI 中伪装成拥有结构化工具事件和精确权限拦截能力。

## 8. OpenCode 可直接使用的任务提示

```text
接手 D:\hermes\ADE 项目。先完整阅读：
1. ADE_Windows_Program_Framework.md
2. docs/ADR-001_IMPLEMENTATION_BASELINE.md
3. docs/UI_DESIGN.md
4. docs/HANDOFF_TO_OPENCODE.md

目标是把当前半完成的 Tauri 2 + React + Rust ADE 做成可运行 Windows 桌面版，不要恢复演示数据。

按 HANDOFF_TO_OPENCODE.md 的“建议接手顺序”执行。优先让 TypeScript 和 Rust 编译通过，然后验证真实项目选择、真实文件读取/保存、批注持久化、ConPTY Agent 终端、批注发送和文件快照恢复。保持 Orca 风格的工作空间/标签页/上下文操作逻辑，但不要复制 Orca 品牌素材。

不要删除用户现有文件，不要执行 git reset/checkout 覆盖现场。当前目录不是标准 Git 仓库，先以现有文件为唯一事实来源。
```

