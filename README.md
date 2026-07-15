# ADE Workbench

**ADE（Agentic Document Environment）** —— 面向 Windows 的本地优先、多 Agent 文档工作台。

将文档阅读、文件预览、项目管理和多 Agent 协作整合到一个统一的桌面应用中，实现「定位 → 批注 → 派发 → 修改 → 验收」的完整闭环。

---

## 版本

**v0.1.0** — PoC 垂直切片，具备完整的文件预览矩阵、Agent 终端、批注系统和本地项目闭环。

---

## 功能概览

### 文件预览引擎

支持 **12 种文件类型**的原生预览，无需切换外部应用：

| 查看器 | 文件类型 | 实现方式 |
|--------|----------|----------|
| **DocxView** | Word 文档 (.docx) | mammoth 渲染 |
| **PptxView** | PowerPoint (.pptx) | pptx-preview + 自定义导出管线 |
| **PdfView** | PDF 文档 | pdfjs-dist 4.x |
| **SpreadsheetView** | Excel 表格 (.xlsx/.csv) | exceljs 解析 |
| **MarkdownView** | Markdown (.md) | react-markdown + GFM |
| **CodeEditor** | 代码文件 | Monaco Editor |
| **SequenceView** | 序列数据 | 自定义渲染 |
| **TreeView** | 树形/JSON 数据 | 语法高亮 tokenizer |
| **TabularView** | 表格数据 | 通用表格渲染 |
| **Ab1View** | AB1 色谱文件 | 自研 AB1 二进制解析器 |
| **DnaView** | DNA 序列文件 (.dna) | 自研 DNA 格式解析器 |
| **TiffView** | TIFF 图像 | UTIF2 解码 + Canvas 渲染 |

### PowerPoint 深度支持

本版本对 PowerPoint 进行了全面增强：

- **内嵌预览**：调用 PowerPoint 应用程序 COM 接口导出高保真幻灯片预览
- **格式转换**：VBS/PS1 脚本支持 PPTX → 图片 / PDF 转换
- **媒体提取**：自动提取 PPTX 内嵌图片和媒体资源
- **编辑接口**：通过 PowerShell 脚本实现幻灯片级别的程序化编辑

### 多 Agent 协作

- **Agent 终端**：基于 xterm.js 的全功能终端，支持 Hermes、Claude Code、Kimi Code 等多种 Agent
- **Token 用量追踪**：实时检测 Agent 输出的 token 报告，自动汇总到项目日志
- **会话管理**：多会话并行，Agent 生命周期管理（启动 / 暂停 / 终止）
- **工作目录隔离**：每个 Agent 以项目根目录作为工作目录，操作可追溯

### 批注与审核闭环

- **文本选区批注**：在任意文档中选中内容，添加批注，关联 Agent
- **结构化任务包**：批注携带精确锚点、上下文和约束条件，派发给 Agent
- **修改审核**：接受 / 部分接受 / 退回修改，批注状态追踪
- **活动日志**：ActivityFeed 展示完整操作历史

### 项目管理

- **本地项目优先**：一个项目对应一个真实文件夹，Agent 默认工作在该目录下
- **文件树浏览**：ProjectFileTree 实时展示项目文件结构
- **文件夹选择器**：增强的 FolderPicker，支持最近项目和快速导航
- **设置面板**：项目配置、数据管理（日志 / 快照）、Token 消耗统计

### Rust 后端服务

独立 Rust sidecar 提供高性能后端能力：

- **HTTP API 服务器**：Actix-web 框架，处理前端所有请求
- **文件系统操作**：安全的项目文件读写、目录遍历、文件监听
- **日志系统**：AdeJournal — 会话记录、token 统计、快照管理
- **本地持久化**：项目状态、Agent 配置、批注数据全部存储在项目目录下

### 格式转换管线

`server/scripts/` 目录提供完整的 Office 文档处理能力：

| 脚本 | 功能 |
|------|------|
| `doc-format-convert.cjs` | 通用文档格式转换 |
| `html-to-docx.cjs` | HTML → DOCX 生成 |
| `word-format-convert.vbs` | Word 文档格式转换（COM） |
| `powerpoint-preview-export.cjs` | PPTX 预览导出 |
| `powerpoint-preview-export.vbs` | PPTX 预览导出（COM） |
| `powerpoint-format-convert.vbs` | PPTX 格式转换 |
| `powerpoint-editor.cjs` | PPTX 程序化编辑 |
| `powerpoint-editor.ps1` | PPTX 编辑（PowerShell） |
| `pptx-media-convert.cjs` | PPTX 媒体提取 |
| `rasterize-office-image.ps1` | Office 图片光栅化 |

---

## 本版本新增

### 新增文件查看器
- **Ab1View** + `ab1.ts`：AB1 格式色谱文件二进制解析与可视化
- **DnaView** + `dna.ts`：DNA 序列文件 (.dna) 解析与渲染
- **TiffView** + `tiff.ts`：TIFF 图像解码与 Canvas 渲染

### PowerPoint 管线大修
- `PptxView.tsx` 全面重写（+685 行）：多幻灯片预览、缩放、媒体提取
- 新增 6 个 PowerPoint 处理脚本（editor, preview-export, format-convert, media-convert）
- 支持 COM 接口调用和纯 Node.js 双路径处理

### 架构清理
- 移除 Tauri 侧废弃模块：`agents.rs`, `model.rs`, `persistence.rs`, `snapshots.rs`
- 功能已迁移至 Rust sidecar server，架构更清晰
- `lib.rs` 重构精简

### 组件增强
- `FolderPicker`：新增最近项目记录、快速导航（+210 行）
- `FileViewer`：增强文件类型路由和预览切换
- `bridge.ts`：新增 token 追踪 API、PPTX 相关接口
- `SequenceView`：改进数据展示（+139 行）
- `AnnotationPanel`：简化批注交互
- `DocxView`：增强文档批注能力

### 构建工具
- `scripts/build-sidecar.mjs`：Rust sidecar 自动构建脚本
- `scripts/test_ab1_parser.mjs`：AB1 解析器测试
- `scripts/test_dna_parser.mjs`：DNA 解析器测试

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | React 19 + TypeScript 7 |
| 构建工具 | Vite 8 |
| 桌面外壳 | Tauri 2 (Rust) |
| 后端服务 | Rust (Actix-web sidecar) |
| 终端模拟 | xterm.js 6 |
| 代码编辑 | Monaco Editor |
| 文档解析 | mammoth (Word), exceljs (Excel), pdfjs-dist (PDF), pptx-preview (PPTX) |
| 图像处理 | UTIF2 (TIFF) |
| Markdown | react-markdown + remark-gfm |
| 图标 | Lucide React |

---

## 本地运行

### Web 开发模式

```powershell
npm install
npm run dev
```

浏览器访问 `http://localhost:1420`。

> `npm run dev` 同时启动 Vite 前端和 Rust sidecar 服务器。

### 单独启动

```powershell
# 仅前端
npm run dev:web

# 仅后端
npm run dev:api
```

### Tauri 桌面应用

需安装 Rust stable 和 Tauri 2 的 Windows 前置依赖：

```powershell
npm run tauri dev
```

### 构建

```powershell
# TypeScript 构建
npm run build

# Rust sidecar 构建
npm run build:sidecar

# 生产模式服务
npm run serve
```

---

## 项目结构

```
ADE/
├── src/                          # React 前端
│   ├── components/
│   │   ├── viewers/              # 12 个文件查看器
│   │   │   ├── Ab1View.tsx       # AB1 色谱查看器
│   │   │   ├── DnaView.tsx       # DNA 序列查看器
│   │   │   ├── TiffView.tsx      # TIFF 图像查看器
│   │   │   ├── DocxView.tsx      # Word 文档查看器
│   │   │   ├── PptxView.tsx      # PowerPoint 查看器
│   │   │   ├── PdfView.tsx       # PDF 查看器
│   │   │   ├── SpreadsheetView.tsx # Excel 查看器
│   │   │   ├── MarkdownView.tsx  # Markdown 查看器
│   │   │   ├── CodeEditor.tsx    # 代码编辑器
│   │   │   ├── SequenceView.tsx  # 序列查看器
│   │   │   ├── TreeView.tsx      # 树形数据查看器
│   │   │   ├── TabularView.tsx   # 表格查看器
│   │   │   ├── ab1.ts            # AB1 二进制解析器
│   │   │   ├── dna.ts            # DNA 格式解析器
│   │   │   └── shared.tsx        # 共享组件
│   │   ├── AgentTerminal.tsx     # Agent 终端
│   │   ├── AnnotationPanel.tsx   # 批注面板
│   │   ├── FileViewer.tsx        # 文件查看路由
│   │   ├── FolderPicker.tsx      # 文件夹选择器
│   │   ├── ProjectFileTree.tsx   # 文件树
│   │   ├── ProjectSidebar.tsx    # 项目侧边栏
│   │   ├── SettingsPanel.tsx     # 设置面板
│   │   ├── ActivityFeed.tsx      # 活动日志
│   │   └── Landing.tsx           # 启动页
│   ├── lib/
│   │   ├── bridge.ts             # API 桥接层
│   │   ├── docxReview.ts         # 文档审阅
│   │   ├── tiff.ts               # TIFF 解析
│   │   ├── preferences.ts        # 偏好设置
│   │   └── useResizableSidebar.ts # 可调整侧边栏
│   ├── styles.css                # 全局样式
│   └── App.tsx                   # 应用根组件
├── server/                       # Rust 后端
│   ├── src/
│   │   ├── main.rs               # HTTP API 入口
│   │   ├── project_files.rs      # 文件系统操作
│   │   ├── ade_journal.rs        # 日志与 token 追踪
│   │   ├── agents.rs             # Agent 管理
│   │   ├── model.rs              # 数据模型
│   │   ├── persistence.rs        # 持久化层
│   │   └── snapshots.rs          # 快照管理
│   └── scripts/                  # 格式转换脚本
│       ├── doc-format-convert.cjs
│       ├── html-to-docx.cjs
│       ├── word-format-convert.vbs
│       ├── powerpoint-preview-export.cjs
│       ├── powerpoint-preview-export.vbs
│       ├── powerpoint-format-convert.vbs
│       ├── powerpoint-editor.cjs
│       ├── powerpoint-editor.ps1
│       ├── pptx-media-convert.cjs
│       └── rasterize-office-image.ps1
├── scripts/                      # 构建与测试脚本
│   ├── build-sidecar.mjs
│   ├── test_ab1_parser.mjs
│   └── test_dna_parser.mjs
├── src-tauri/                    # Tauri 桌面外壳
├── docs/                         # 设计文档
│   ├── ADR-001_IMPLEMENTATION_BASELINE.md
│   └── UI_DESIGN.md
├── ADE_Windows_Program_Framework.md  # 完整产品架构方案
├── package.json
├── vite.config.ts
└── tsconfig.json
```

---

## 设计原则

- **本地优先**：数据存储在项目文件夹中，不上传云端
- **文件为中心**：操作对象是文件和文档，不是孤立聊天窗口
- **Agent 权限受限**：Agent 默认仅访问项目目录，不授予全盘权限
- **可追溯**：所有 Agent 操作记录在日志中，修改可审核、可回退
- **多 Agent 互斥写**：同一文件不允许多 Agent 同时覆写

---

## 文档

- `ADE_Windows_Program_Framework.md`：完整产品定位、架构方案与路线图
- `docs/ADR-001_IMPLEMENTATION_BASELINE.md`：首期实施决策记录
- `docs/UI_DESIGN.md`：界面与交互设计基线

---

## 许可证

Private — 当前为闭源开发阶段。
