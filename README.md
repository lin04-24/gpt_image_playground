# GPT Image Playground

## V4.1.2 功能情况

V4.1.2 聚焦上传与上游图片下载的内存峰值治理，版本标签为 `V4.1.2`。

- multipart 图片上传和浏览器迁移上传改为直接写入临时文件，并在流中计算 SHA-256，避免将完整请求同时保存在 `chunks` 和 `Buffer` 中。
- 图片存储复用现有原子发布流程，支持从临时文件解析元数据、校验摘要并安全落盘。
- Worker 按任务输入字节数和像素数限制生成任务资源预算，输入图片改为顺序读取，降低并发任务同时装载完整 Buffer 的峰值。
- 上游远程图片下载增加响应大小限制、超时、响应流大小检查和 `Content-Type: image/*` 校验。
- 超限、冲突和异常路径会清理临时文件；保留现有图片 ID 摘要冲突保护。

验证：`npm run build`、`npm test -- --run`（34 个测试文件，258 项测试）和 `git diff --check` 均已通过。

## V4.1.1 功能情况

V4.1.1 修复 Worker 过期租约恢复时忽略最大尝试次数的问题，版本标签为 `V4.1.1`。

- 过期租约恢复现在按 `attempt_count < max_attempts` 分流，未超限作业才会重新排队。
- 达到最大尝试次数的作业原子地标记为 `error`，不再因 Worker 持续崩溃而无限重跑。
- 达到上限的 generation task 同步标记失败，并发布 `task.failed` 事件；可重试作业继续通过 outbox 发布 `job.enqueue`。
- 新增 Worker 租约恢复回归测试，覆盖重新入队和达到上限失败两条路径。

验证：`npm run build`、`npm test -- --run`（34 个测试文件，258 项测试）和 `git diff --check` 均已通过。

## V4.1.0 功能情况

V4.1.0 将生产运行时统一收敛到 Fastify + PostgreSQL + Redis API/Worker，版本标签为 `V4.1.0`。

- 前端认证、任务、图片、Profile、收藏夹、应用状态、SSE 和浏览器迁移统一使用 `/api/*` 接口。
- 移除旧 Node 22 + SQLite 快照服务、`cloud-api` 协议、分页快照实现和旧 SQLite 迁移命令。
- 任务创建、重试、删除和收藏操作固定走后端 API，由独立 Worker 执行供应商任务。
- Docker 默认入口改为 `node server/api/main.mjs`，Compose 明确分离 API、Worker、PostgreSQL 和 Redis。
- 新增认证路由回归测试，更新后端 API/同步测试，并保留浏览器 IndexedDB 到 PostgreSQL 的迁移流程。
- 旧 SQLite 数据不会自动升级；切换前需由部署方自行备份和处理旧数据库及图片目录。

验证：`npm run build`、`npm test`（34 个测试文件，257 项测试）和 `docker compose config` 均已通过。

## 生产运行方式

生产环境统一使用 Fastify + PostgreSQL + Redis API/Worker。前端只调用同源 `/api/*` 接口，API 与 Worker 由 `deploy/cloud/docker-compose.yml` 启动并共享图片卷；单独的静态构建仅用于需要后端配套的前端产物。

```sh
cd deploy/cloud
cp .env.example .env
docker compose up -d --build
```

请在 `.env` 中设置 `LOGIN_TOKEN`、`CONFIG_ENCRYPTION_KEY`、`POSTGRES_PASSWORD` 和 `APP_ORIGIN`。正式接口包括 `/api/auth/*`、`/api/tasks/*`、`/api/images/*`、`/api/profiles/*`、`/api/app-state`、`/api/events` 和 `/api/migration/*`。

这是一次有意的兼容性断裂：仓库不再提供旧 Node/SQLite 快照服务、旧快照协议或旧 SQLite 迁移命令。升级前必须由部署方自行备份并处理旧 SQLite 数据、图片目录及浏览器缓存；浏览器缓存可通过 `/api/migration/browser/*` 补充导入 PostgreSQL。切换前请使用 `docker compose config` 检查 API/Worker 命令和依赖关系。

# V4.0.0 发布说明

V4.0.0 将 API 配置管理升级为「API 配置档案」列表，版本标签为 `V4.0.0`。

## 功能情况

### API 配置档案列表化

- 保留同一服务商拥有多个 Profile 的数据模型，不合并配置，不改变任务对 Profile ID 的引用方式。
- 设置页常驻显示按服务商分组的 API 配置档案，分组顺序遵循 `providerOrder`，同组内保持原 Profile 顺序，未知服务商稳定追加到末尾。
- 每个档案显示名称、服务商标识和模型摘要，并标记当前设置页编辑项。
- 保留新建、复制、复制导入 URL、删除、点击切换编辑、拖拽排序和触摸排序；Profile 可跨服务商分组调整全局顺序，服务商分组标题不可拖拽。
- 保留服务商类型切换，可在 OpenAI 兼容接口、fal.ai 和自定义服务商之间切换当前 Profile。

### 生图配置独立选择

- 生图入口统一使用「生图配置档案」术语。
- `generationProfileId` 与 `generationModel` 继续独立决定下一次生图使用的 Profile 和模型；设置页切换当前编辑项不会意外改变生图默认选择。
- 删除生图默认 Profile 时继续自动回退到剩余有效 Profile；历史任务复用和后端同步仍使用原 Profile ID。

### 验证与兼容性

- 新增 Profile 分组排序辅助逻辑及 Vitest 覆盖，验证同服务商归组、组内顺序、服务商排序和未知服务商追加规则。
- 保持 `AppSettings`、Profile API、数据库结构、导入导出格式、云同步格式和任务记录字段不变。
- 已通过 `npm run build` 和 `npm test -- --run`（35 个测试文件，273 项测试）。

## 部署说明

完整生图运行方式是 Docker Compose 后端部署。生产环境至少需要设置 `LOGIN_TOKEN`、`CONFIG_ENCRYPTION_KEY`、`POSTGRES_PASSWORD` 和 `APP_ORIGIN`，并备份 PostgreSQL 数据、图片卷及加密主密钥。

---

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
