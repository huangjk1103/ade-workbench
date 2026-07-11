# ADE Workbench

ADE（Agentic Document Environment）是一个面向 Windows 的本地优先、多 Agent 文档工作台。本仓库目前处于 PoC 起步阶段。

## 当前垂直切片

- Windows 工作台布局。
- 项目文件树和文档阅读画布。
- 多 Agent 状态与选择。
- 文本选区批注的模拟交互。
- 批注到任务队列的本地闭环。
- Tauri 2 / Rust 桌面外壳源码骨架。

当前 UI 使用演示数据，尚未读取真实文件或启动真实 Agent。

## 本地运行

```powershell
npm install
npm run dev
```

浏览器访问 `http://localhost:1420`。

## Windows 桌面运行

先安装 Rust stable 和 Tauri 2 的 Windows 前置依赖，然后执行：

```powershell
npm run tauri dev
```

当前开发机尚未检测到 `cargo` 和 `rustc`，因此本轮只验证 Web 前端构建。

## 文档

- `ADE_Windows_Program_Framework.md`：完整产品与架构方案。
- `docs/ADR-001_IMPLEMENTATION_BASELINE.md`：首期实施决策。
- `docs/UI_DESIGN.md`：界面与交互设计基线。

