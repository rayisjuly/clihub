# 更新日志

## [2.8.1] - 2026-03-09

### 新增
- `ecosystem.config.js`：PM2 进程管理配置（自动重启、.env 加载、日志管理）
- `setup.sh` 内置 watchdog 循环，无 pm2 环境也能自动重启
- PM2 npm 脚本：`pm2:start`、`pm2:stop`、`pm2:restart`、`pm2:logs`、`pm2:status`

### 变更
- `setup.sh`：自动检测 pm2，有则用进程守护，无则用 watchdog 循环
- `package.json`：新增 pm2 快捷脚本
- `.gitignore`：忽略 `logs/` 目录

## [2.8.0] - 2026-03-04

### 新增
- AskUserQuestion 交互式 UI：单选/多选、自由输入、提交按钮（CLI 风格，蓝色主题）
- EnterPlanMode/ExitPlanMode 自定义权限标签
- Plan Mode 绿色横幅指示器
- `public/js/questions.js`：问题交互模块
- Hook `additionalContext` 回退：用户回答通过上下文传递给 Claude
- 问题请求推送通知

### 变更
- `server.js`：INTERACTIVE_TOOLS 集合，问题请求/响应 WS 事件，AskUserQuestion 180 秒超时
- `hooks/permission-hook.sh`：`hookSpecificOutput` JSON，文件级调试日志
- 侧边栏未读数包含待回答问题
- 工具结果显示：已回答的 AskUserQuestion 显示 ✓ 而非 ✗

## [2.7.0] - 2026-03-04

### 新增
- 侧边栏 CLI 风格美化：状态指示器（✓/旋转/✗）、紧凑布局、水平底栏
- `hooks/README.md`：权限 Hook 配置文档

### 变更
- 侧边栏会话项：缩小内边距和字体，移除胶囊徽章（改为彩色文字）
- 侧边栏底栏：竖向排列 → 水平弹性布局
- 新建会话按钮：`+ new` 纯文字按钮
- 分组标题：简化计数格式 `(N)`
- 删除按钮：更小，悬停变红
- 侧边栏响应式宽度：300→280px（移动端），320→300px（桌面端）
- `setup.sh`：完全重写（5 项依赖检查、.env 自动创建、权限 Hook 自动安装）
- `README.md`：新增环境要求、一键安装、Docker 宿主机 CLI 说明

## [2.6.2] - 2026-03-03

### 修复
- Token 用量显示 100%：服务端用 `+=` 累加 `input_tokens`，但 Claude API 返回的是当前上下文窗口大小（非增量），改为 `=`
- 上下文百分比计算缺少 `output_tokens`
- Token 显示优先级：优先使用 `totalUsage` 而非 `lastTurnUsage`
- iOS PWA 底部间隙：添加 `100dvh` 视口高度，减少安全区底部内边距

### 新增
- `scripts/sync-to-clihub.sh`：一键同步到公开仓库
- `scripts/sync-exclude.txt`：私有文件黑名单
- `scripts/sync-protect.txt`：clihub 专有文件保护

## [2.6.1] - 2026-03-03

### 修复
- 工具行水平溢出：多层溢出保护
- 权限请求强制滚动到底部
- Token 用量显示：`renderTokenBar` 回退到 `totalUsage`
- 历史滚动分页：从 `seq` 改为数据库自增 `id`
- iOS 滚动穿透：body `overflow:hidden` + `overscroll-behavior:contain`

### 新增
- 响应式断点：sm (≤480px)、lg (≥769px)、xl (≥1025px)
- 安全区支持（header 和侧边栏）
- 触控目标优化：菜单按钮最小 44×44px

### 变更
- Header 压缩：标题+元信息单行显示
- 启动面板压缩：更小的按钮和选择框
- Viewport meta：移除 `user-scalable=no`，添加 `viewport-fit=cover`
- 登录框：`width:300px` → `width:90%; max-width:300px`

## [2.6.0] - 2026-03-02

### 新增
- CLI 终端交互模式：前端渲染全面重构，模拟 Claude Code CLI 体验
- 工具树形渲染：`· verb summary` / `└ param`，旋转点动画、✓/✗ 状态指示
- 用户消息 `❯` 提示符风格，助手消息流式 Markdown
- 权限提示内联到消息流中：`Allow? [Allow] [Allow Session] [Deny]`
- CLI 风格思考指示器，可折叠思考过程
- 等宽字体族（SF Mono、Fira Code、Consolas、Monaco）

### 变更
- tools.js：从 `<details>` 卡片系统完全重写为 CLI 树形渲染
- messages.js：从聊天气泡完全重写为终端提示符+流式文本
- permissions.js：弹窗 → 内联到消息流
- style.css：大规模重构，移除所有气泡/卡片/弹窗样式，新增 `.tl-*` CLI 行样式

### 修复
- 服务重启后会话列表丢失：补充前端会话处理中缺失的 `createdAt` 字段

### 移除
- 聊天气泡 UI（头像、消息头、消息容器）
- 工具卡片 UI（基于 `<details>` 的展开卡片）
- 权限弹窗 HTML 和样式
- 旧版思考块样式

## [2.5.0] - 2026-03-02

### 新增
- SQLite 持久化存储（better-sqlite3）：替代 NDJSON 的结构化事件存储
- 工具卡片 UI：可展开卡片，专用渲染器（Bash/Read/Edit/Write/Glob/Grep）
- 深色/浅色主题系统：CSS 变量、系统偏好自动检测、手动切换
- 会话恢复：已停止会话的恢复按钮
- 首次启动自动迁移已有 JSON/NDJSON 文件到 SQLite

### 变更
- `handleClaudeEvent()` 重写：文本在 block_stop 时批量处理
- `get_history` 返回结构化事件格式
- `session_status` 处理器调用 `updateActiveUI()` 进行状态转换

### 移除
- NDJSON 文件持久化（被 SQLite 替代）
- JSON 文件元数据存储（被 SQLite sessions 表替代）

## [2.4.0] - 2026-03-02

### 新增
- i18n 双语系统（中/英），自动检测 + 手动切换
- Docker 支持（Dockerfile + docker-compose.yml）
- WebSocket 心跳：服务端 ping/pong (30s) + 客户端 keep-alive (25s)
- 消息同步：seq 编号 + 重放缓冲区（500 事件），断线恢复
- 断连宽限期（2 秒），避免快速重连时 UI 闪烁
- 指数退避重连（1s → 最大 30s）
- CSP `CF_ACCESS_DOMAIN` 环境变量

### 变更
- 所有源代码注释和消息翻译为英文
- `broadcast()` → `broadcastSession()`，会话事件带序列号

## [2.3.3] - 2026-03-02

### 修复
- CSP 兼容 Cloudflare Access
- manifest.json CORS：添加 crossorigin="use-credentials"
- favicon.ico 404：添加 SVG 图标 + favicon 路由
- 弃用的 apple-mobile-web-app-capable meta 标签

### 新增
- 权限对话框按会话分组
- 应用图标（SVG + PNG 192/512）
- 会话列表排序：活跃会话优先

## [2.3.2] - 2026-03-02

### 修复
- CDN 依赖本地化到 public/vendor/（Safari ITP 修复）
- 会话列表点击：inline onclick 改为事件委托（CSP）
- 删除按钮移动端误触修复
- 第三方库加载防御性检查

### 新增
- 多客户端权限同步：一端处理，其他端自动关闭
- 多客户端用户消息同步：实时广播

## [2.3.1] - 2026-03-01

### 修复
- WS 重连后输入框禁用：visibilitychange + ping/pong 心跳
- 断连后待处理权限丢失：重连时重发
- 斜杠命令自动补全缺少认证头
- 会话恢复缺少 approvedTools 字段
- 重复权限对话框：toolUseId 去重

### 新增
- "本次允许"权限按钮：同一工具在会话期间自动批准

## [2.3.0] - 2026-03-01

### 安全
- 图片 API 路径遍历修复
- /api/commands 端点认证
- readHistory 路径遍历修复
- projectDir 白名单验证
- CDN 脚本 SRI 哈希固定
- Token 从 URL 参数移除，使用 fetch + blob URL
- escapeHTML：添加引号转义
- Hook 脚本：jq JSON 构建（Shell 注入修复）
- CSP：移除 unsafe-inline，添加 HSTS
- 内联脚本提取到 init.js

### 修复
- WS 重连后输入框禁用

## [2.2.0] - 2026-03-01

### 新增
- 图片发送/接收：附件、粘贴、拖拽，Canvas 压缩
- 推送通知（Notification API + Service Worker）
- 侧边栏通知开关

## [2.1.0] - 2026-03-01

### 新增
- 上下文窗口使用百分比状态栏
- 会话费用显示
- 消息历史分页（每页 50 条，滚动加载更多）
- 思考指示器（可折叠块）
- 会话列表按项目分组

## [2.0.1] - 2026-03-01

### 修复
- 权限 sessionId 不匹配：Hook 使用环境变量
- 内置权限绕过：添加 --permission-mode bypassPermissions

## [2.0.0] - 2026-03-01

### 新增
- 多会话管理：并行 Claude Code 进程
- 侧边栏：抽屉式会话列表，状态点 + 未读徽章
- 会话切换：按会话隔离消息
- 远程权限审批：PreToolUse Hook + HTTP 长轮询 + UI 对话框
- 会话恢复：--resume 标志
- WS 协议 v2：所有消息携带 sessionId
- tool_use/tool_result 事件显示

## [1.0.0] - 2026-02-28

### 新增
- Express + WebSocket + Claude Code CLI 桥接（NDJSON 协议）
- 聊天界面：深色主题、移动优先、流式 Markdown 语法高亮
- 项目目录选择器，自动扫描
- 斜杠命令自动补全（内置 + 自定义）
- PWA：manifest.json + Service Worker 离线缓存
- setup.sh：一键安装 + 隧道配置
