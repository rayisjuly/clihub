# CliHub

中文 | [English](README.md)

自托管 CLI 会话管理器 — 用手机管理多个 Claude Code 会话。

一个轻量级 PWA，通过 WebSocket 将手机浏览器与开发机上运行的 Claude Code CLI 进程连接起来。

## 功能特性

- **多会话** — 同时运行 10+ 个 Claude Code 会话
- **流式输出** — 实时 Markdown 渲染，支持语法高亮
- **远程授权** — 在手机上批准/拒绝工具调用
- **图片支持** — 通过粘贴/拖拽/附件向 Claude 发送截图
- **推送通知** — Claude 回复或需要授权时收到通知
- **斜杠命令** — 完整的内置和自定义命令自动补全
- **双语界面** — 中英文自动检测，可手动切换
- **PWA** — 添加到主屏幕，获得原生应用体验
- **Telegram Bot** — 通过 Telegram 管理会话（创建、切换、停止、恢复、审批权限、发送图片）
- **SQLite 持久化** — 结构化事件存储，支持会话历史
- **停止生成** — 一键中断 Claude 的响应
- **离线可用** — Service Worker 缓存所有资源

## 架构

```
手机 (PWA)
    ↓ HTTPS / WSS
Cloudflare Tunnel（或任意反向代理）
    ↓ localhost:5678
CliHub 服务端 (Node.js + Express + ws)
    ↓ stdin/stdout (NDJSON stream-json)
Claude Code CLI 进程
```

## 环境要求

- **Node.js** >= 18
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`（需已登录）
- **jq** — `brew install jq`（权限 Hook 需要）

## 快速开始

### 一键安装

```bash
git clone https://github.com/rayisjuly/clihub.git
cd clihub
./setup.sh
```

安装脚本会检查依赖、安装包、创建 `.env`、可选安装权限 Hook，然后启动服务。

### 手动安装

```bash
git clone https://github.com/rayisjuly/clihub.git
cd clihub
npm install
cp .env.example .env
# 编辑 .env — 设置 BEARER_TOKEN 为你的密码
nano .env

# 启动服务
node server.js
```

### 进程管理（推荐）

CliHub 内置 [pm2](https://pm2.keymetrics.io/) 进程管理器支持。使用 pm2 后，服务崩溃自动重启，关闭终端也不影响运行。

```bash
npm install -g pm2
pm2 start ecosystem.config.js    # 启动并开启自动重启
pm2 startup && pm2 save          # 设置开机自启
```

常用命令：

```bash
pm2 logs clihub       # 查看日志
pm2 restart clihub    # 重启服务
pm2 stop clihub       # 停止服务
pm2 status clihub     # 查看状态
```

> **注意：** 修改 `.env` 后，必须执行 `pm2 delete clihub && pm2 start ecosystem.config.js`，不能用 `pm2 restart`，因为 restart 不会重新加载环境变量。

没有 pm2 时，`setup.sh` 会使用内置的 watchdog 循环，同样支持崩溃自动重启（但关闭终端后会停止，需配合 `nohup` 或 `tmux` 使用）。

### Docker

```bash
git clone https://github.com/rayisjuly/clihub.git
cd clihub
cp .env.example .env
# 编辑 .env，设置 BEARER_TOKEN

docker compose up -d
```

> **注意：** Docker 模式会挂载宿主机的 `~/.claude` 用于认证。请先在宿主机上安装并登录 Claude Code CLI（`npm install -g @anthropic-ai/claude-code && claude` 完成认证）。

在手机上打开 `http://localhost:5678`（或配置隧道进行远程访问）。

### Telegram Bot（可选）

通过 Telegram 管理会话：

1. 通过 [@BotFather](https://t.me/BotFather) 创建 Bot
2. 通过 [@userinfobot](https://t.me/userinfobot) 获取你的用户 ID
3. 在 `.env` 中添加：
   ```
   TELEGRAM_BOT_TOKEN=你的_token
   TELEGRAM_ALLOWED_USERS=你的用户ID
   ```
4. 重启服务

可用命令：`/new`、`/list`、`/switch`、`/stop`、`/resume`、`/status`

也可以直接发送图片，Bot 会将图片作为视觉输入转发给 Claude。

> **安全提示**：未设置 `TELEGRAM_ALLOWED_USERS` 时，默认拒绝所有用户。

## 远程访问方式

CliHub 提供两种远程控制方式：

| | PWA + 隧道 | Telegram Bot |
|--|-----------|-------------|
| 完整 UI（Markdown、语法高亮） | ✅ | ❌ 纯文本 |
| 发送图片 | ✅ 粘贴/拖拽/附件 | ✅ 直接发图 |
| 权限审批 | ✅ 内联按钮 | ✅ 内联按钮 |
| 离线缓存 | ✅ Service Worker | ❌ |
| 无需隧道 | ❌ 需要 Cloudflare/ngrok | ✅ 开箱即用 |
| 多设备通知 | 需配置推送 | ✅ 原生通知 |
| 配置难度 | 中等（隧道配置） | 低（BotFather + 环境变量） |

**用 PWA**：想要完整体验 — Markdown 渲染、语法高亮、斜杠命令、会话历史界面。

**用 Telegram**：想要快速上手 — 无需隧道，随时随地发消息、审批权限、监控会话。

两者可以同时使用。

## 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BEARER_TOKEN` | *（必填）* | Web 界面认证令牌 |
| `HOOK_TOKEN` | 同 BEARER_TOKEN | 权限 Hook 请求令牌 |
| `PORT` | `5678` | 服务端口 |
| `PROJECTS_DIR` | `~/Documents/Project` | 项目根目录（按实际情况调整） |
| `CF_ACCESS_DOMAIN` | *（无）* | Cloudflare Access 域名，用于 CSP 头（可选） |
| `TELEGRAM_BOT_TOKEN` | *（无）* | Telegram Bot Token，从 @BotFather 获取（可选） |
| `TELEGRAM_ALLOWED_USERS` | *（无）* | 允许的 Telegram 用户 ID，逗号分隔（启用 Bot 时必填） |

## 安全性

CliHub 设计用于**个人使用**，部署在私有网络或隧道后面。

- **Bearer Token 认证** — 所有 HTTP 和 WebSocket 连接需要令牌
- **频率限制** — 登录尝试限流（15 分钟内最多 5 次）
- **CSP 头** — 严格的内容安全策略，禁止内联脚本
- **路径遍历防护** — 项目目录沙箱隔离
- **XSS 过滤** — 所有 Markdown 输出经过 DOMPurify 处理

远程访问推荐使用 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 并配置 Access 策略。

## 权限 Hook

CliHub 包含一个 `PreToolUse` Hook，将 Claude Code 的权限请求路由到手机端供你审批。

**自动安装**（通过 setup.sh）：安装脚本会询问是否配置 Hook。

**手动安装**：添加到 `~/.claude/settings.json`：

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "",
      "hooks": ["bash:/你的clihub绝对路径/hooks/permission-hook.sh"]
    }]
  }
}
```

> 将 `/你的clihub绝对路径/` 替换为实际的 clihub 目录路径。

当 Claude 尝试使用工具（写文件、执行命令等）时，你的手机会收到通知，显示批准/拒绝按钮。

## 技术栈

- **后端**：Node.js + Express + ws (WebSocket)
- **前端**：原生 HTML/CSS/JS — 零框架、零构建步骤
- **Markdown**：marked + highlight.js + DOMPurify（本地 vendor 副本）
- **持久化**：SQLite (better-sqlite3)
- **Telegram**：node-telegram-bot-api（可选）
- **进程管理**：Node.js `child_process` + NDJSON stream-json 协议

## 项目结构

```
server.js              # 后端入口
db.js                  # SQLite 数据库层
telegram.js            # 可选 Telegram Bot 集成
ecosystem.config.js    # PM2 进程管理配置
public/
  index.html           # 主 HTML 外壳
  css/style.css        # 样式
  js/                  # 前端模块（app, i18n, messages, sessions, ...）
  locales/             # i18n 翻译文件（en.json, zh.json）
  vendor/              # 第三方库（marked, hljs, DOMPurify）
hooks/
  permission-hook.sh   # PreToolUse Hook，远程权限审批
Dockerfile             # Docker 镜像
docker-compose.yml     # Docker Compose 配置
```

## 许可证

[MIT](LICENSE)
