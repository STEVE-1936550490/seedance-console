# Seedance Console

Seedance Console 是面向 Linux 内部环境的 AI 视频生成控制台。项目同时提供默认
Mock 工作流和受双重门保护的 Seedance AICC Python Bridge；日常运行不会自动调用
真实 Seedance 服务。

## 当前基线

当前里程碑：

- Mock MVP：已完成 Ubuntu 24.04 Docker 端到端验收。
- AICC Bridge：已完成固定 SDK、机密通道、创建、查询、下载/解密和安全日志边界。
- 真实 Demo：纯文生视频和单参考图图生视频均已完成
  `create → poll → download → 本地持久化`，MP4 的 Web 播放和下载均通过。
- 参考图片发布：支持私有 EOS/S3 上传和限时 GET 预签名 URL，也保留自建 HMAC 回滚
  实现；真实单参考图链路已完成一次验收。
- 默认运行状态：`SEEDANCE_PROVIDER=mock`、`REAL_API_TEST=false`；真实创建门关闭
  时返回 403。

真实调用能力已接入，但不是默认 Provider，也不得在没有用户对当次调用明确授权时
开启。真实 Demo 的最终事实记录见
[真实 Provider Demo 最终检查点](docs/REAL_PROVIDER_DEMO_CHECKPOINT.md)。

详细记录：

- [Linux Docker 部署与运维](docs/DEPLOYMENT.md)
- [Mock MVP 端到端验收](docs/MOCK_E2E_ACCEPTANCE.md)
- [真实 Provider 协议状态](docs/provider-api.md)
- [真实 Provider 待确认清单](docs/PROVIDER_PROTOCOL_CHECKLIST.md)
- [Provider 版本化轮询实现](docs/POLLING_SCHEDULING.md)
- [真实 Provider 分阶段实施完成记录](docs/REAL_PROVIDER_IMPLEMENTATION_PLAN.md)
- [Provider 参考图片安全发布](docs/ASSET_PUBLISHING.md)
- [单参考视频 MVP](docs/REFERENCE_VIDEO_MVP.md)

## Linux Docker 启动

服务器只需安装 Docker Engine 和 Docker Compose v2：

```bash
test -f .env || cp .env.example .env
docker compose config --quiet
docker compose up -d --build --wait
docker compose ps
```

Compose 会依次启动 PostgreSQL、Redis、数据库迁移、共享文件存储初始化、API、Worker 和 Web。迁移成功后才启动应用服务。

打开：

- 创作台：`http://<服务器IP>:43170`
- 任务历史：`http://<服务器IP>:43170/history`

API 与 Worker 只绑定服务器回环地址：

```bash
curl http://127.0.0.1:43171/health
curl http://127.0.0.1:43172/health
docker compose logs -f api worker web
```

默认端口为 Web `43170`、API `43171`、Worker `43172`、PostgreSQL `45432`、Redis `46379`，可在 `.env` 调整。浏览器通过 Next.js 同源代理访问 API，不需要知道服务器内部地址。

根目录 `.env` 已被 Git 和 Docker 构建上下文忽略。当前必须保持：

```dotenv
SEEDANCE_PROVIDER=mock
```

Mock 模式不要求任何真实 Provider 配置。`SEEDANCE_API_KEY` 和 `SEEDANCE_BRIDGE_TOKEN` 不会注入 Web 或 API；客户端构建还会执行密钥扫描。

## 本地源码开发

需要 Node.js 22、Corepack 和 Docker Compose：

```bash
corepack enable
corepack prepare pnpm@10.15.0 --activate
test -f .env || cp .env.example .env
pnpm install
docker compose up -d postgres redis
pnpm db:migrate
pnpm dev
```

本地页面仍使用同源代理，默认访问 `http://localhost:43170`。

## Mock MVP 验证

1. 在创作台选择 `Mock Video V1` 并填写提示词。
2. 上传一张 JPG、PNG 或 WebP 参考图片。
3. 选择比例、分辨率和时长，保持“测试结果”为“生成成功”。
4. 点击“生成视频”，观察排队、提交和生成状态。
5. 成功后播放并下载 Mock MP4。
6. 刷新页面，确认当前任务恢复。
7. 进入任务历史，确认任务参数、状态和 Mock 用量仍存在。

Provider 没有返回进度时，页面只显示状态与已等待时间。“模拟失败”可验证错误展示，“持续处理中”可验证长时间等待界面。

## 质量检查

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check:client-secrets
```

测试覆盖 Mock Provider 幂等、成功、失败、慢处理和取消，以及
`QUEUED → SUBMITTING → PROCESSING → SUCCEEDED` 状态流转、本地 Storage、Provider
capabilities 和 MP4 预览响应。

EOS 发布器单元测试使用完全本地的 SDK mock，不访问真实对象存储。2026-08-02 已在部署
环境运行 `pnpm eos:verify`，完成上传、5 分钟 GET URL 校验和删除闭环；脚本可用于后续
凭据或 Bucket 配置变更后的复验。

可在装有 Docker 的环境额外检查：

```bash
docker compose config
docker compose up -d --build --wait
```

## 停止

```bash
docker compose down
```

保留数据卷即可再次恢复任务和历史。只有明确需要清空全部本地数据时才执行：

```bash
docker compose down -v
```

该命令会不可恢复地删除 PostgreSQL、Redis 和生成文件。

## 真实 Provider 状态

真实 Seedance AICC 路径已经分别通过一次纯文生视频和一次单参考图图生视频任务完成
验收，包括真实创建、版本化轮询、SDK 下载/解密、本地 MP4 持久化以及 Web 播放下载。
部署根因验证同时确认 `AICC_BASE_URL` 必须包含 `/api/v3`。

当前仍必须保持：

```dotenv
SEEDANCE_PROVIDER=mock
REAL_API_TEST=false
```

真实 create 同时要求用户对当次调用明确授权和 `REAL_API_TEST=true`。已完成的真实 Demo
不得重复创建，后续任务仍需新的明确授权。当前已实现一张 PNG/JPEG 经私有 EOS
上传及短期 GET 预签名 URL 的发布流程，无需服务器公网 HTTPS 入口；EOS 上传、读取和
删除闭环及一次真实 Provider 拉取均已验收，但在新的单次授权前不得再次执行真实任务。
未确认的素材限制和组合、远端取消、用量/费用、正式错误码和远端幂等能力继续以
`docs/provider-api.md` 中的 `TODO_CONFIRM` 为准。

## 工作区

```text
apps/web                   Next.js 创作台和任务历史
apps/api                   Fastify API、上传和任务查询
apps/worker                BullMQ Worker 和 Mock 任务处理
services/provider-bridge   私有 Python AICC SDK Bridge
packages/shared            共享 DTO 和队列契约
packages/config            环境变量校验
packages/seedance-provider Provider 契约、Mock 与 Seedance Bridge Adapter
packages/db                Prisma schema、迁移和客户端
packages/storage           本地文件存储抽象
```
