<!-- 目录变化时请更新本文件 -->
# public/

PWA 前端静态文件目录，由 Express 直接提供服务。

## 文件说明

| 文件 | 地位 | 功能 |
|------|------|------|
| `index.html` | 核心 | PWA 主页面（HTML + CSS + JS 合一），聊天 UI + WebSocket 客户端 + Markdown 渲染 |
| `manifest.json` | 配置 | PWA manifest，standalone 模式 + 暗色主题 |
| `sw.js` | 辅助 | Service Worker，静态资源离线缓存 |
| `icon.svg` | 资源 | App 图标源文件（Hub 网络图，SVG） |
| `icon-192.png` | 资源 | App 图标 192x192（从 SVG 生成） |
| `icon-512.png` | 资源 | App 图标 512x512（从 SVG 生成） |
