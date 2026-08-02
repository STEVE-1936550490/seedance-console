# Linux Docker 部署与运维

## 1. 部署基线

Seedance Console Mock MVP 已在 Ubuntu 24.04 Linux 服务器完成 Docker 端到端验收。验收主机使用 Docker Engine `29.6.2` 和 Docker Compose `v5.3.1`；这两个版本是已验证环境记录，不代表项目声明的最低版本。

当前 Compose 默认启用 Mock Provider，不调用真实 Seedance API。私有 AICC Bridge
已实现并完成一次真实 Demo 验收，但只在显式 profile、受保护配置、
`REAL_API_TEST=true` 和用户单次授权同时满足时使用。Web 是唯一面向使用者的入口；
API、Worker、PostgreSQL 和 Redis 默认只绑定宿主机回环地址。

## 2. 环境要求

- Ubuntu 24.04 或兼容的 64 位 Linux 服务器。
- Docker Engine，以及支持 `docker compose` 命令的 Compose v2 插件。
- 当前用户可以访问 Docker daemon；否则使用具备 Docker 权限的部署账户。
- 能从 Docker Hub 拉取 `node:22-bookworm-slim`、`postgres:16-alpine` 和 `redis:7-alpine`，并能在构建时访问 Debian 软件源。
- 为镜像、PostgreSQL、Redis、上传素材和生成视频预留足够磁盘空间。
- Web 默认使用 TCP `43170`。API `43171`、Worker `43172`、PostgreSQL `45432` 和 Redis `46379` 只绑定 `127.0.0.1`。

Docker 部署不要求宿主机安装 Node.js 或 pnpm。只有本地源码开发和质量检查才需要 Node.js 22、Corepack 和 pnpm 10.15.0。
API 与 Worker 镜像包含 ffprobe，用于单参考 MP4 的容器和媒体元数据检查。

检查安装：

```bash
docker version
docker compose version
docker info
```

若 `docker info` 报 Docker socket 权限错误，应修复部署账户的 Docker 权限并重新登录会话；不要把 Docker socket 暴露到公网。

## 3. `.env` 配置

在仓库根目录创建本地配置：

```bash
test -f .env || cp .env.example .env
chmod 600 .env
```

部署前至少检查以下配置：

```dotenv
POSTGRES_USER=seedance
POSTGRES_PASSWORD=<替换为仅本机使用的强密码>
POSTGRES_DB=seedance_console
POSTGRES_PORT=45432
REDIS_PORT=46379
WEB_PORT=43170
WEB_ORIGIN=http://localhost:43170
UPLOAD_MAX_BYTES=10485760
SEEDANCE_PROVIDER=mock
```

注意：

- `.env` 已被 `.gitignore` 和 `.dockerignore` 排除，不得执行强制添加。
- `.env.example` 只能包含无密钥的示例值。
- Mock 是默认 Provider，且不要求真实 Provider 配置。`SEEDANCE_API_KEY` 不注入 Web 或 API。
- 不要使用 `NEXT_PUBLIC_*` 保存任何服务端凭据。
- 从其他主机浏览时，按实际访问地址设置 `WEB_ORIGIN`；浏览器正常通过 Web 的同源 `/api` 代理访问 API。

## 4. 构建和启动

在仓库根目录执行：

```bash
docker compose config --quiet
docker compose up -d --build --wait
docker compose ps
```

Compose 按依赖关系启动 PostgreSQL、Redis、存储初始化、数据库迁移、API、Worker 和 Web。`migrate` 与 `storage-init` 成功退出是正常状态；长期运行的 `postgres`、`redis`、`api`、`worker` 和 `web` 应为 `healthy`。

访问地址：

- 创作台：`http://<服务器IP或域名>:43170`
- 任务历史：`http://<服务器IP或域名>:43170/history`

仓库当前不包含服务器 Nginx/Caddy 配置，也不会修改防火墙。若服务器已有反向代理，配置应由服务器运维侧单独管理，且不得提交包含域名私钥、上游凭据或机器专用路径的配置。

## 5. 健康检查

检查 Compose 状态：

```bash
docker compose ps
```

检查宿主机端点：

```bash
curl --fail http://127.0.0.1:43170/
curl --fail http://127.0.0.1:43171/health
curl --fail http://127.0.0.1:43172/health
```

API 健康响应应报告 API、Worker、PostgreSQL 和 Redis 为 `up`。Worker 健康响应应报告 Redis 为 `up`，Provider 名称为 `mock`。

也可从容器内部排除宿主机网络因素：

```bash
docker compose exec -T api node -e "fetch('http://127.0.0.1:43171/health').then(async r => { console.log(r.status, await r.text()); if (!r.ok) process.exit(1) })"
docker compose exec -T worker node -e "fetch('http://127.0.0.1:43172/health').then(async r => { console.log(r.status, await r.text()); if (!r.ok) process.exit(1) })"
docker compose exec -T web node -e "fetch('http://127.0.0.1:43170').then(r => { console.log(r.status); if (!r.ok) process.exit(1) })"
```

## 6. 日志查看

查看全部服务：

```bash
docker compose logs --tail=200
docker compose logs -f
```

按服务查看：

```bash
docker compose logs --tail=200 postgres redis migrate
docker compose logs -f api worker web
```

日志中不得出现 Authorization、API Key、数据库密码、完整素材内容或带签名的下载 URL。对外分享日志前仍应人工脱敏。

## 7. 重启、更新与停止

重启应用服务：

```bash
docker compose restart api worker web
docker compose ps
```

代码更新后重新构建：

```bash
git pull --ff-only
docker compose config --quiet
docker compose up -d --build --wait
```

停止并移除容器和网络，但保留数据卷：

```bash
docker compose down
```

再次启动：

```bash
docker compose up -d --wait
```

只有明确需要永久清空全部任务、队列和文件时才可执行：

```bash
docker compose down -v
```

`-v` 会删除本项目的 PostgreSQL、Redis 和文件存储卷，无法通过 Compose 自动恢复。

## 8. 数据持久化

Compose 使用三个 Docker named volumes：

| Compose 卷      | 当前项目卷名                     | 容器内目录                 | 内容                         |
| --------------- | -------------------------------- | -------------------------- | ---------------------------- |
| `postgres-data` | `seedance-console_postgres-data` | `/var/lib/postgresql/data` | 任务、素材元数据、事件和用量 |
| `redis-data`    | `seedance-console_redis-data`    | `/data`                    | BullMQ 队列和 Redis AOF      |
| `app-storage`   | `seedance-console_app-storage`   | `/data/storage`            | 上传图片和生成视频           |

Docker 默认数据根目录下的实际宿主机路径由 Docker 管理，不应由应用直接读写。已验收主机上的默认路径为：

```text
/var/lib/docker/volumes/seedance-console_postgres-data/_data
/var/lib/docker/volumes/seedance-console_redis-data/_data
/var/lib/docker/volumes/seedance-console_app-storage/_data
```

不同主机或自定义 Docker data-root 下路径可能不同，以以下命令为准：

```bash
docker volume ls --filter label=com.docker.compose.project=seedance-console
docker volume inspect seedance-console_postgres-data
docker volume inspect seedance-console_redis-data
docker volume inspect seedance-console_app-storage
```

不要把这些目录、数据库导出、上传文件或生成视频复制进 Git 工作树。正式备份与恢复方案属于后续运维加固阶段。

## 9. 真实参考图片的 EOS 边界

参考图片使用私有、S3 兼容的移动云 EOS Bucket，不依赖服务器公网 80/443、Caddy 或
DuckDNS。Bucket 不得开放匿名读写；Worker 的凭证应只允许指定前缀的 Put/Get/Delete。

生产配置：

```dotenv
ASSET_PUBLISHER=eos
EOS_ENDPOINT=https://<EOS 控制台提供>
EOS_REGION=<EOS 控制台提供>
EOS_BUCKET=<私有 Bucket>
EOS_ACCESS_KEY_ID=<服务器 secret>
EOS_SECRET_ACCESS_KEY=<服务器 secret>
EOS_OBJECT_PREFIX=seedance-inputs/
EOS_PRESIGN_TTL_SECONDS=3600
EOS_FORCE_PATH_STYLE=false
EOS_DELETE_ON_TERMINAL=true
SEEDANCE_ASSET_MAX_BYTES=10485760
```

Endpoint、Region 和 `EOS_FORCE_PATH_STYLE` 必须以当前租户的官方信息为准。AccessKey、
SecretKey 不得写入 Compose 文件、Git、日志或 `NEXT_PUBLIC_*`。切换真实 Provider 前先
运行 `pnpm eos:verify`；它会上传 fixture、生成 5 分钟 URL、GET 校验并删除对象。

HMAC 端点仍作为回滚方案保留。回滚时设置 `ASSET_PUBLISHER=hmac` 并恢复
`SEEDANCE_ASSET_SIGNING_KEY`、`SEEDANCE_ASSET_PUBLIC_BASE_URL` 和
`SEEDANCE_ASSET_URL_TTL_MS`，然后重启 API/Worker；不要回滚或删除已应用的数据库表。
完整生命周期和清理说明见 [Provider 参考图片安全发布](ASSET_PUBLISHING.md)。

## 10. 常见故障排查

### Docker socket 权限不足

现象：`permission denied while trying to connect to the docker API`。

```bash
docker info
id
```

使用具备 Docker 权限的部署账户并重新登录。不要通过开放未鉴权 TCP socket 规避权限问题。

### 端口被占用

```bash
ss -ltnp | grep -E ':(43170|43171|43172|45432|46379)\b'
docker compose ps
```

在 `.env` 中修改对应宿主机端口后重新执行 `docker compose up -d --wait`。容器内部端口无需修改。

### 镜像构建或拉取超时

```bash
docker compose build --progress=plain
docker compose pull postgres redis
```

检查 Docker Hub、Debian 软件源、DNS、代理和磁盘空间。网络恢复后重新构建；不要反复删除持久化卷。

### 服务 unhealthy

```bash
docker compose ps
docker compose logs --tail=200 <服务名>
docker inspect --format '{{json .State.Health}}' seedance-console-<服务名>-1
```

优先检查 `postgres`、`redis`、`migrate` 和 `storage-init`，再检查 API、Worker、Web。

### 数据库迁移失败

```bash
docker compose logs --tail=200 postgres migrate
docker compose run --rm migrate
```

确认 `.env` 中数据库名称、用户和密码一致。不要删除卷来掩盖迁移问题。

### Worker 不处理任务

```bash
curl --fail http://127.0.0.1:43172/health
docker compose logs --tail=200 worker redis
docker compose restart worker
```

确认 Worker 健康响应中的 Redis 为 `up`、Provider 为 `mock`。

### 上传或视频下载失败

```bash
docker compose logs --tail=200 api worker
docker volume inspect seedance-console_app-storage
df -h
docker system df
```

检查上传大小限制、磁盘空间、`app-storage` 挂载和文件权限。不要把运行时文件移到仓库目录作为临时修复。

### 页面不可访问但容器 healthy

```bash
curl --fail http://127.0.0.1:43170/
ss -ltnp | grep ':43170'
```

若本机访问正常，继续检查云安全组、服务器防火墙和外部反向代理；本项目不会自动修改这些配置。
