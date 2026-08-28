## V2.0.0（2026-08-28）

### 后端架构
- 完成 Redis + PostgreSQL 后端化改造：Fastify API、独立 Worker、PostgreSQL 和 Redis 由 Docker Compose 统一运行。
- PostgreSQL 成为任务、图片元数据、Profile、收藏夹和应用状态的权威数据源，IndexedDB 降级为浏览器缓存。
- Redis 提供任务队列、可重建的分页索引、热点缓存、会话和 SSE 事件；支持租约恢复、重试和 Outbox 投递。
- 所有生图请求移至服务端 Worker，支持 OpenAI 兼容接口、fal.ai 和自定义 HTTP 服务商。

### 数据与安全
- 服务端目录保存原图和缩略图，采用分片路径、原子写入、SHA-256 校验和受保护读取。
- API Key 使用 AES-256-GCM 加密存储，仅在 Worker 内存中解密，接口和日志不返回敏感字段。
- 新增登录会话、CSRF、Origin 校验、请求参数校验和 Redis 登录限流。
- 新增 SQLite 与浏览器 IndexedDB 的 dry-run、apply、verify 迁移流程，以及 Redis 重建命令。

### 前端体验
- 任务列表改为服务端分页，每页最多 30 条，搜索、状态和收藏筛选覆盖完整历史。
- 通过 SSE 接收任务状态、缩略图就绪和同步提示，断线后自动重新查询权威数据。

### 部署与验证
- 新增 `deploy/cloud/docker-compose.yml`、`deploy/cloud/.env.example` 和 API/Worker 健康检查。
- `npm run build` 通过；`npm test` 通过（31 个测试文件，235 项测试）。

## v1.0.0（2026-08-26）

### 修复
- 修复 `grok-imagine-image-2.0` 生成图片时的尺寸参数兼容问题。
- 将应用内尺寸自动换算为上游原生 `aspect_ratio`：例如 `2560x1440` 对应 `16:9`，避免模型回退为默认 `2:3` 图片比例。
- 覆盖 Images API、图像编辑、Responses API 与批量生成，保持各入口的比例行为一致。

### 部署
- Docker 更新命令明确为 `docker compose up -d --build --force-recreate`，避免仅重建容器而继续复用旧镜像。

### 验证
- Vitest：408 项测试通过。
- 生产构建：TypeScript 与 Vite 构建通过。

## v0.2.0（2026-08-19）

### 性能优化
- 生成图片完成后自动生成并持久化小尺寸缩略图。
- 首页任务卡片和收藏夹封面优先使用缩略图，减少大量历史图片同时打开时的内存占用和解码压力。
- 详情弹窗改为按当前图片按需加载原图，切换多图结果时才继续加载下一张。
- 原图加载完成前显示缩略图，降低打开详情时的等待感。

### 兼容性
- 继续保留 IndexedDB 中原图存储、全屏预览、下载、编辑和导出能力。
- 对已有图片支持后台补生成缩略图，不需要重新生成历史任务。

## v0.7.3（2026-08-01）

### 修复
- 修复 Service Worker 缓存同源动态 GET 请求的问题：仅缓存应用外壳及构建静态资源，避免异步生图轮询接口持续返回首次缓存的处理中状态，并在更新后自动清理旧缓存 (#127)。
