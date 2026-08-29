# V3.0.0 发布说明

V3.0.0 为任务网格引入重排动画（Layout Transition），并增加「遵循系统减少动态效果」无障碍设置，版本标签为 `V3.0.0`，已发布至 [GitHub Releases](https://github.com/lin04-24/gpt_image_playground/releases/tag/V3.0.0)，并对应 `V3.0.0` 分支。

## 功能情况

### 网格重排动画（Layout Transition）

- 任务网格在筛选状态、搜索词变化或新增/删除任务导致网格重组时，卡片不再突兀闪现，而是按 FLIP（First-Last-Invert-Play）方式平滑飞入新槽位：布局更新前记录每张卡片的页面坐标，重排后计算新旧位移差，先施加反向 `transform` 位移并禁用过渡，强制回流后再以 `cubic-bezier(0.16, 1, 0.3, 1)` 的 300ms 过渡回到新位置。
- 筛选后新出现的卡片（含后端模式翻页）以 20ms 交错延迟（上限 120ms）淡入放大（260ms，同一缓动曲线），首屏加载不播放入场动画。
- FLIP 坐标使用页面坐标（含滚动偏移），仅滚动页面不会触发假动画；坐标差不超过 1px 的重渲染不产生动画。
- 窗口 resize 后旧坐标全部失效，自动跳过下一次动画只更新坐标，避免跨列宽布局的横向漂移。
- 动画的内联样式与定时器在动画完成、hook 重入和组件卸载时都会清理，不污染卡片后续的 hover 等过渡。

### 无障碍：遵循系统减少动态效果

- 习惯配置页新增「遵循系统减少动态效果」开关（默认开启）。开启后，系统启用 `prefers-reduced-motion` 时网格重排/入场动画直接跳过，并通过 `<html>` 上的 `reduce-motion` 类把全局装饰性动画与过渡压缩为瞬时完成；关闭后始终播放动画。
- 系统偏好的实时切换（`matchMedia` change）立即生效，无需刷新。
- 设置向后兼容：旧持久化数据缺少 `respectReducedMotion` 字段时按 `true` 处理，升级无需迁移操作。

### 既有能力（自 V2.0.0 起保持）

- 服务端权威数据：PostgreSQL 保存任务、图片元数据、API Profile、收藏夹、应用状态和迁移记录；浏览器 IndexedDB 仅作为缓存。
- 后端任务执行：前端通过 REST 创建任务，Fastify API 将任务写入 PostgreSQL 和 Outbox，由独立 Worker 调用 OpenAI 兼容接口、fal.ai 或自定义 HTTP 服务商。
- Redis 队列与缓存：使用 Redis pending/processing 队列、任务时间索引、首页热点缓存、会话和实时事件；Redis 丢失后可从 PostgreSQL 重建。
- 任务可靠性：支持租约、崩溃恢复、最长 3 次执行和网络、超时、429、5xx 等可重试错误的指数退避。
- 服务端图片存储：原图和缩略图保存于受控持久化目录，采用 ID 分片、临时文件原子写入、SHA-256 校验和受保护图片接口。
- 分页、搜索和筛选：服务端任务列表每页最多 30 条，支持页码、上一页、下一页、提示词搜索、状态筛选和收藏夹筛选，覆盖完整历史数据。
- 实时更新：通过 SSE 推送任务状态、缩略图就绪和同步提示；断线后以前端重新查询 PostgreSQL 权威状态为准。
- 安全配置：API Key 仅在 Worker 内存中解密，数据库保存 AES-256-GCM 加密版本；登录使用 Redis 会话、HttpOnly/SameSite Cookie、CSRF 和来源校验。
- Docker Compose 部署：提供 `gip-api`、`gip-worker`、`gip-postgres`、`gip-redis` 四个服务，共享图片持久化卷；配置模板见 [`deploy/cloud/.env.example`](deploy/cloud/.env.example)。

## 部署说明

完整生图运行方式是 Docker Compose 后端部署。生产环境至少需要设置 `LOGIN_TOKEN`、`CONFIG_ENCRYPTION_KEY`、`POSTGRES_PASSWORD` 和 `APP_ORIGIN`，并备份 PostgreSQL 数据、图片卷及加密主密钥。

## 兼容性与限制

- 当前仍是单用户模型，不提供多用户、组织或角色隔离。
- 不提供取消任务接口；手动重试会创建新任务。
- API 与 Worker 必须访问同一图片卷，当前设计适合同一 Docker 主机。
- 不支持幂等键的上游在极小故障窗口内可能重复调用，系统不宣称绝对 exactly-once。
- Redis Pub/Sub 不是持久事件日志，断线或重建后以前端重新查询为准。

## 验证

- `npm run build`
- `npm test`（33 个测试文件，254 项测试）

发布内容不包含 `.env`、API Key、登录令牌、数据库文件、图片缓存、测试生成目录或本地设备数据。
