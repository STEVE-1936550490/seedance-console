# Mock MVP 端到端验收记录

## 1. 验收结论

Seedance Console Mock MVP 已在 Ubuntu 24.04 Linux 服务器通过 Docker 端到端验收，可以作为接入真实 Provider 前的功能基线。

验收日期：2026-07-30  
验收运行环境：Docker Engine `29.6.2`、Docker Compose `v5.3.1`  
Provider：`mock`  
真实收费接口调用：无

本记录只证明 Mock 链路和当前 Docker 部署基线，不证明真实 Seedance API 的字段、限制、状态或计费行为。

## 2. 服务与基础设施

以下项目已通过：

- [x] Web 容器启动并通过健康检查。
- [x] API 容器启动并通过健康检查。
- [x] Worker 容器启动并通过健康检查。
- [x] PostgreSQL 容器启动并通过健康检查。
- [x] Redis 容器启动并通过健康检查。
- [x] 数据库迁移容器成功完成。
- [x] 文件存储初始化容器成功完成。
- [x] Web 可通过宿主机端口 `43170` 访问。
- [x] API `43171`、Worker `43172`、PostgreSQL `45432`、Redis `46379` 只绑定宿主机回环地址。
- [x] API 健康检查能汇总 API、Worker、PostgreSQL 和 Redis 状态。
- [x] Worker 健康检查能报告 Redis 和 Mock Provider 状态。

## 3. 业务链路

完整链路已通过：

```text
上传素材
  → 创建数据库任务
  → BullMQ 入队
  → Worker 消费
  → Mock Provider 创建并轮询
  → 生成并保存 Mock MP4
  → API 返回内部任务状态
  → Web 播放和下载
  → 历史记录保留
```

验收项：

- [x] 上传 JPG、PNG 或 WebP 参考图片。
- [x] 上传元数据和校验和写入 PostgreSQL。
- [x] 使用 `clientRequestId` 创建任务。
- [x] 任务进入 `QUEUED → SUBMITTING → PROCESSING → SUCCEEDED`。
- [x] Worker 从 Redis/BullMQ 获取并处理任务。
- [x] Mock Provider 成功场景返回固定测试视频。
- [x] Mock Provider 失败场景返回稳定、脱敏的错误。
- [x] Mock Provider 慢处理场景保持处理中，页面持续展示等待状态。
- [x] 取消场景进入 `CANCELLED`。
- [x] Provider 不返回进度时，页面不伪造进度。
- [x] 成功任务可以在线播放 MP4。
- [x] 成功任务可以下载 MP4。
- [x] 页面刷新后可以恢复最近任务。
- [x] 历史页面保留任务参数、状态和 Mock 用量。
- [x] 任务输出和输入素材保存在共享文件存储卷。

## 4. 重启与持久化

以下项目已通过：

- [x] 重启 Web、API 和 Worker 后任务历史仍存在。
- [x] 容器重启后 PostgreSQL 数据仍存在。
- [x] 容器重启后上传文件和生成视频仍存在。
- [x] Redis 使用 AOF 和 named volume。
- [x] `docker compose down` 后 named volumes 默认保留。

持久化依赖 `postgres-data`、`redis-data` 和 `app-storage` 三个 Docker named volumes。未执行破坏性的 `docker compose down -v`。

## 5. 自动化质量检查

以下命令已通过：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
docker compose config --quiet
```

自动化测试覆盖 Mock Provider 创建幂等、成功、失败、慢处理、取消、参数校验、用量，以及 API/Worker 健康检查、任务流转和本地 Storage。

## 6. Git 与敏感数据检查

P0 基线复核结果：

- [x] 根目录 `.env` 未被 Git 跟踪，并同时被 `.gitignore` 与 `.dockerignore` 排除。
- [x] `.env` 在验收服务器上的权限为 `0600`。
- [x] 未发现真实 API Key、Authorization 或私钥被 Git 跟踪。
- [x] 运行时上传目录和本地 Storage 目录被 `.gitignore` 排除。
- [x] 运行时生成的 MP4/MOV 文件被 `.gitignore` 排除。
- [x] PostgreSQL、Redis 和应用文件数据位于 Docker named volumes，不在 Git 工作树。
- [x] 仓库未跟踪服务器 Nginx、Caddy、Traefik 或其他机器专用代理配置。

仓库中唯一有意跟踪的 MP4 是：

```text
packages/seedance-provider/fixtures/mock-output.mp4
```

它是 Mock Provider 的固定测试 fixture，不是上传素材或运行时生成结果。

## 7. 本阶段未验收

- [ ] 真实 Seedance API 创建、查询、取消或下载。
- [ ] 真实 Provider 的模型、参数、状态、错误码、用量和费用。
- [ ] 真实收费接口调用。
- [ ] Nginx、HTTPS、登录和公网安全加固。
- [ ] 自动备份、恢复演练、监控和告警。

这些内容不属于 Mock MVP 验收结论；后续必须先完成真实 Provider 协议确认和设计评审。
