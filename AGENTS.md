# 项目上下文

### 项目名称：智能问数 (VOC 3.0 AI Data Copilot)

### 版本技术栈

- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI 组件**: shadcn/ui (基于 Radix UI) + 自定义磨砂玻璃设计系统
- **Styling**: Tailwind CSS 4 + 自定义 VOC 层 (globals.css @layer voc)
- **图表**: Recharts (渐变柱状图、环形图、折线图)
- **AI**: coze-coding-dev-sdk (LLMClient, 流式 SSE)
- **图标**: Lucide React

## 目录结构

```
├── public/                 # 静态资源
├── scripts/                # 构建与启动脚本
├── src/
│   ├── app/
│   │   ├── api/chat/       # 流式 AI 对话 API 路由 (SSE)
│   │   │   └── route.ts    # LLM 流式调用入口
│   │   ├── globals.css     # 全局样式 + VOC 磨砂玻璃设计系统
│   │   ├── layout.tsx      # 根布局
│   │   └── page.tsx        # 主页面 (状态管理 + 首页/对话视图切换)
│   ├── components/
│   │   ├── home-view.tsx   # 首页搜索中心
│   │   ├── chat-view.tsx   # 对话结果页
│   │   ├── chart-card.tsx  # 图表卡片 (Recharts)
│   │   └── ui/             # shadcn/ui 组件库
│   ├── hooks/
│   ├── lib/
│   │   ├── types.ts        # 类型定义 + 常量 (Message, ChartData, DataSource 等)
│   │   └── utils.ts
│   └── server.ts
├── DESIGN.md               # 设计规范 (磨砂玻璃视觉系统)
├── AGENTS.md               # 本文件
├── next.config.ts
├── package.json
└── tsconfig.json
```

## 核心功能

1. **首页搜索中心**: 数据源切换 (MySQL/Excel/历史)、深度推理模式、搜索输入、建议标签
2. **对话结果页**: 用户气泡、AI 流式回复、推理过程 (ThoughtBubble)、图表可视化、SQL 预览、追问面板
3. **LLM 流式集成**: 后端 `/api/chat` 路由使用 coze-coding-dev-sdk 流式输出，前端 Reader 逐字渲染

## API 接口

- `POST /api/chat` - 流式 AI 对话
  - Body: `{ query: string, isReasoning: boolean, history: Array<{role, content}> }`
  - Response: SSE 流 (text/event-stream)
  - 数据块: `data: {"content": "..."}\n\n`
  - 结束标记: `data: [DONE]\n\n`

## 设计系统 (VOC Glass)

在 `globals.css` 的 `@layer voc` 中定义，主要类名：
- `.voc-page-bg` - 冷调浅蓝灰渐变背景
- `.voc-glass` / `.voc-glass-strong` / `.voc-glass-input` - 不同强度的磨砂玻璃
- `.voc-chip` / `.voc-suggestion` - 胶囊标签 (薄荷/紫/蓝三色)
- `.voc-ai-badge` - AI 徽章
- `.voc-send-btn` - 发送按钮
- `.voc-user-bubble` - 用户深色气泡
- `.voc-thought-bubble` - 推理过程气泡
- `.voc-sql-box` - SQL 预览
- `.voc-chart-card` - 图表卡片

## 包管理规范

**仅允许使用 pnpm** 作为包管理器，**严禁使用 npm 或 yarn**。

## 开发规范

### 编码规范

- TypeScript strict 模式，禁止隐式 any
- LLM SDK 仅在后端使用，禁止在客户端导入
- 流式输出优先：默认使用 `stream()` 方法 + SSE
- 所有交互元素圆角 >= 12px，禁止锐角

### Hydration 问题防范

- 动态数据必须用 'use client' + useEffect/useState
- 禁止在 JSX 中使用 typeof window、Date.now()、Math.random()
