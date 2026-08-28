# V2.0.2 发布说明

V2.0.2 修复后端分页模式下的前端同步闪烁问题，版本标签为 `V2.0.2`，对应分支为 `V2.0.2`，并已发布至 [GitHub Releases](https://github.com/lin04-24/gpt_image_playground/releases/tag/V2.0.2)。

## 功能情况

- 后端分页同步期间不再清空任务列表，保留当前页数据，新页到达后整体替换，消除筛选切换和翻页时的闪烁。
- 新增首次同步完成标记：首次同步完成前不渲染本地缓存任务，避免启动时闪现 IndexedDB 中的全量旧照片。
- 首次同步失败时只显示错误信息，不再把 IndexedDB 旧历史误当作当前列表展示，解决列表"时有时无"的现象。
- 提交任务的乐观更新保留至服务端列表确认替换，新任务不再短暂显示后消失。
- 保持服务端分页能力：每页最多 30 条，页码、上一页、下一页、提示词搜索、状态筛选和收藏夹筛选覆盖完整历史数据。

## 验证

- `npm run build`
- `npm test -- --run`（31 个测试文件，236 项测试）

---

# V2.0.0 发布说明

V2.0.0 根据 Redis + PostgreSQL 后端设计完成后端化改造，版本标签为 `V2.0.0`，并已发布至 [GitHub Releases](https://github.com/lin04-24/gpt_image_playground/releases/tag/V2.0.0)。Agent 功能按本次发布范围移除。

## 功能情况

- 服务端权威数据：PostgreSQL 保存任务、图片元数据、API Profile、收藏夹、应用状态和迁移记录；浏览器 IndexedDB 仅作为缓存。
- 后端任务执行：前端通过 REST 创建任务，Fastify API 将任务写入 PostgreSQL 和 Outbox，由独立 Worker 调用 OpenAI 兼容接口、fal.ai 或自定义 HTTP 服务商。
- Redis 队列与缓存：使用 Redis pending/processing 队列、任务时间索引、首页热点缓存、会话和实时事件；Redis 丢失后可从 PostgreSQL 重建。
- 任务可靠性：支持租约、崩溃恢复、最长 3 次执行和网络、超时、429、5xx 等可重试错误的指数退避。
- 服务端图片存储：原图和缩略图保存于受控持久化目录，采用 ID 分片、临时文件原子写入、SHA-256 校验和受保护图片接口。
- 分页、搜索和筛选：服务端任务列表每页最多 30 条，支持页码、上一页、下一页、提示词搜索、状态筛选和收藏夹筛选，覆盖完整历史数据。
- 实时更新：通过 SSE 推送任务状态、缩略图就绪和同步提示；断线后以前端重新查询 PostgreSQL 权威状态为准。
- 安全配置：API Key 仅在 Worker 内存中解密，数据库保存 AES-256-GCM 加密版本；登录使用 Redis 会话、HttpOnly/SameSite Cookie、CSRF 和来源校验。
- 旧数据迁移：提供可预览、幂等、可核对的 SQLite 和浏览器 IndexedDB 迁移流程：

  ```text
  npm run migrate:legacy -- --dry-run
  npm run migrate:legacy -- --apply
  npm run migrate:legacy -- --verify
  npm run rebuild:redis
  ```

- Docker Compose 部署：提供 `gip-api`、`gip-worker`、`gip-postgres`、`gip-redis` 四个服务，共享图片持久化卷；配置模板见 [`deploy/cloud/.env.example`](deploy/cloud/.env.example)。

## 部署说明

V2.0.0 的完整生图运行方式是 Docker Compose 后端部署，不再支持仅有静态前端且没有本项目后端的完整运行方式。生产环境至少需要设置 `LOGIN_TOKEN`、`CONFIG_ENCRYPTION_KEY`、`POSTGRES_PASSWORD` 和 `APP_ORIGIN`，并备份 PostgreSQL 数据、图片卷及加密主密钥。

## 兼容性与限制

- 当前仍是单用户模型，不提供多用户、组织或角色隔离。
- 不提供取消任务接口；手动重试会创建新任务。
- API 与 Worker 必须访问同一图片卷，当前设计适合同一 Docker 主机。
- 不支持幂等键的上游在极小故障窗口内可能重复调用，系统不宣称绝对 exactly-once。
- Redis Pub/Sub 不是持久事件日志，断线或重建后以前端重新查询为准。

## 验证

- `npm run build`
- `npm test`（31 个测试文件，235 项测试）
- `git diff --check`

发布内容不包含 `.env`、API Key、登录令牌、数据库文件、图片缓存、测试生成目录或本地设备数据。

---

# V1.0.0 发布说明

本版本已发布至 [GitHub Releases](https://github.com/lin04-24/gpt_image_playground/releases/tag/V1.0.0)，并对应 `V1.0.0` 分支。

## 功能情况

- 设置中心：可填写自定义 API URL 和 API Key，支持保存多个服务商配置。
- 模型管理：填写 API 后可拉取模型列表，并单独启用或禁用模型。
- 生图前选择：可在生图入口直接选择服务商和模型，不必切换设置页的当前配置。
- 单用户登录：公网部署时使用唯一访问令牌作为登录口令，未通过验证前不会加载工作区数据。
- 云端同步：登录后可在设备之间同步任务、图片、配置和模型清单。
- 移动端适配：登录页、设置页和生图入口适配手机屏幕。
- 图片性能优化：生成图片后自动生成并保存对应的小尺寸缩略图。
- 首页画廊和收藏夹封面优先加载缩略图，避免一次性解码大量高分辨率原图，提升历史记录较多时的启动和浏览速度。
- 详情弹窗按需加载原图：打开详情时只读取当前查看的输出图，切换多图结果时再加载下一张；原图读取期间先展示缩略图。
- 保留全屏预览、下载和编辑等功能，只有真正需要查看或操作原图时才读取原始图片数据。

## 敏感内容排除

发布内容不包含 `.env`、API Key、登录令牌、数据库文件、图片缓存、设备数据或其他本地私密配置。部署时请使用环境变量和示例配置文件注入运行参数。
