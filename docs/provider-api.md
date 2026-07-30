# Seedance 2.0 Provider API

## 1. 文档状态与证据

本文根据以下本地材料静态整理，未安装、导入或执行 SDK，也未向移动云发起请求：

- 根目录 `pythonSDK-0515.zip`
- `maas_seedance_sdk-1.0.0-py3-none-any.whl`
- ZIP 中的 `maas_seedance_demo.py`
- 用户提供的 Python 示例

SDK 元数据确认包名为 `maas_seedance_sdk`、版本 `1.0.0`、要求 Python `>=3.8`。本文将信息分为：

- **已由 SDK 源码确认**：方法、路径、请求头和源码直接读取的响应字段。
- **仅由示例确认**：示例出现过，但合法取值、边界和默认值仍未知。
- **待用户/官方补充**：不能从 SDK 安全推断，真实适配器实现前必须填写。

源码行为不等同于完整官方协议。官方文档与实际测试结果优先级更高。

当前本地制品校验值：

```text
pythonSDK-0515.zip
SHA-256 e718a80945c6885172aaf17826ca9fd362d0ba0d805d42ea07242f020a6cece9

maas_seedance_sdk-1.0.0-py3-none-any.whl
SHA-256 36f86be4d97400c1964eba0a0f9b845e047e8430499ae42990cb98cb9d961039
```

## 2. 推荐的双调用架构

```text
TypeScript Worker
  └─ SeedanceProvider
       ├─ mock        -> MockSeedanceProvider
       ├─ maas-sdk    -> 内网 Python Provider Bridge -> maas_seedance SDK -> 移动云
       └─ direct-http -> TypeScript HTTP Transport   -> 移动云（待协议确认）
```

推荐生产机密模型使用 `maas-sdk`：

- SDK 是 Python 包，而主项目是 TypeScript，因此用独立 Python Bridge 封装 SDK。
- Bridge 只监听 Docker 内部网络，不向浏览器或公网发布。
- Worker 与 Bridge 交换规范化任务 DTO；API Key、RSA 私钥和 SDK 原始响应不离开 Bridge。
- 使用常驻进程复用 SDK 客户端，不为每次轮询启动 Python 子进程。

保留 `direct-http` 传输，但当前必须标记为 **不可用/实验性**。静态源码显示 SDK 会执行远程证明并加密请求与响应；在官方提供无 SDK 调用协议或确认普通 HTTP 可用前，不能仅照抄 URL 和 Bearer Header。

## 3. 配置及实际 API Key 填写位置

不要把真实值写进本文、Git、TypeScript 源码、Next.js 环境变量或任何 `NEXT_PUBLIC_*` 变量。

后续部署时请在服务器创建：

```text
/etc/seedance-console/provider.env
```

文件内容由你填写：

```dotenv
SEEDANCE_PROVIDER_DRIVER=maas-sdk
MAAS_BASE_URL=https://zhenze-huhehaote.cmecloud.cn/api/v3
MAAS_API_KEY=<在这里填写真实移动云 API Key>
MAAS_MODEL=doubao-seedance-2.0
MAAS_ENABLE_VIDEO_ENCRYPT=true
MAAS_PUBLIC_KEY_PATH=/var/lib/seedance-console/keys/seedance_pub.pem
MAAS_PRIVATE_KEY_PATH=/var/lib/seedance-console/keys/seedance_priv.pem
```

该文件权限应为 `0600`，只注入 Python Provider Bridge；不要注入 `web` 或 `api` 容器。未来选择 `direct-http` 时，密钥只注入 Worker。Docker Compose 文件创建后应显式引用这个外部 `env_file`，而不是把密钥复制进仓库。

密钥目录必须提前创建并持久化。SDK 在任一 PEM 文件缺失时会生成一对 RSA 4096 密钥，但不会创建父目录；私钥权限应为 `0600`。生产环境不要使用示例的相对 `./tmp` 路径。

## 4. Python SDK 调用契约

### 4.1 安装边界

SDK 只安装在未来的 `services/provider-bridge` Python 镜像中，不安装到 Next.js、Fastify 或 TypeScript Worker，也不从浏览器动态下载。阶段 6 构建镜像时，从已审核的私有制品中提取 wheel 并固定版本/校验值：

```bash
python -m pip install --no-cache-dir ./maas_seedance_sdk-1.0.0-py3-none-any.whl
```

本轮不执行该命令。是否允许将 wheel 放入私有镜像或私有制品库，仍需在第 11.4 节确认。

### 4.2 初始化

```python
from maas_seedance import MaasSeedanceClient

client = MaasSeedanceClient(
    maas_base_url=MAAS_BASE_URL,
    maas_api_key=MAAS_API_KEY,
    maas_model=MAAS_MODEL,
    enable_video_encrypt=True,
)

client.set_video_file_encrypt_key(
    public_key_path=PUBLIC_KEY_PATH,
    private_key_path=PRIVATE_KEY_PATH,
)
```

`enable_video_encrypt` 控制**生成视频文件**是否加密，不能理解为关闭机密请求通道。当前封装客户端没有暴露关闭机密请求通道的参数。

SDK 初始化时会查询模型映射；失败、非 200 或响应无 `endpoint` 时会回退到传入的 `maas_model`。

### 4.3 SDK 公共方法

| 操作         | Python 方法                                                                      | 已确认返回                                    |
| ------------ | -------------------------------------------------------------------------------- | --------------------------------------------- |
| 创建任务     | `create_video_generation_task(data)`                                             | `task_id: str`；非 200 时源码可能返回空字符串 |
| 查询任务     | `query_video_generation_task(task_id)`                                           | `dict`                                        |
| 查询列表     | `query_video_generation_task_list(page_num, page_size, status, task_ids, model)` | `dict`                                        |
| 下载视频     | `download_video(task_id, local_file_path)`                                       | `bool`                                        |
| 删除任务     | `delete_video_generation_task(task_id)`                                          | `bool`                                        |
| 设置文件密钥 | `set_video_file_encrypt_key(public_key_path, private_key_path)`                  | `None`                                        |

SDK 的“删除任务”不能直接解释为“取消生成”。只有官方确认删除正在处理的任务会取消执行后，Provider 的 `cancelTask()` 才可映射到它。

## 5. 创建任务请求

### 5.1 示例确认的请求体

```json
{
  "content": [
    {
      "type": "text",
      "text": "<提示词>"
    },
    {
      "type": "image_url",
      "image_url": { "url": "<可访问的图片 URL>" },
      "role": "reference_image"
    },
    {
      "type": "video_url",
      "video_url": { "url": "<可访问的视频 URL>" },
      "role": "reference_video"
    },
    {
      "type": "audio_url",
      "audio_url": { "url": "<可访问的音频 URL>" },
      "role": "reference_audio"
    }
  ],
  "generate_audio": true,
  "ratio": "16:9",
  "duration": 11,
  "watermark": false
}
```

SDK 会原地加入/覆盖 `model` 字段，值为模型映射后的 endpoint。只确认示例中的字段和值成功用于演示；目前不知道：

- `content` 的最少/最大项数、排序语义和可组合规则。
- URL 是否必须公网可访问、是否允许短期签名 URL，以及能否直接上传文件。
- 支持的图片、视频、音频格式、大小和时长。
- `ratio` 的全部枚举。
- `duration` 的允许范围和单位是否固定为秒。
- `generate_audio`、`watermark` 是否必填及其默认值。
- 文本长度、语言、敏感内容及其他模型限制。

真实 UI 与校验 schema 必须等第 11 节补齐后确定，不能从示例值扩展枚举或范围。

### 5.2 SDK 自动行为

- 请求中包含任意 `type == "video_url"` 的 content 项时，增加 `Input-Has-Video: true`。
- `enable_video_encrypt=true` 时，增加视频结果加密请求头和公钥。
- 包装层会记录完整请求体；生产 Bridge 必须配置日志过滤，禁止记录提示词和素材 URL。

## 6. SDK 源码确认的 HTTP 路径

所有下列业务路径均相对于 `MAAS_BASE_URL`。以示例 Base URL 计算：

| 操作     | 方法与完整示例路径                                                            | 请求/响应要点                                   |
| -------- | ----------------------------------------------------------------------------- | ----------------------------------------------- |
| 模型映射 | `POST https://zhenze-huhehaote.cmecloud.cn/api/v3/mapping/query`              | Body `{"model":"..."}`；200 响应读取 `endpoint` |
| 创建任务 | `POST https://zhenze-huhehaote.cmecloud.cn/api/v3/contents/generations/tasks` | 200 响应读取 `id`                               |
| 查询任务 | `GET .../contents/generations/tasks/{task_id}`                                | 200 返回任务 JSON                               |
| 查询列表 | `GET .../contents/generations/tasks`                                          | 返回列表 JSON，具体结构待补充                   |
| 删除任务 | `DELETE .../contents/generations/tasks/{task_id}`                             | 返回 JSON，语义待补充                           |

列表查询参数由 SDK 源码确认：

- `page_num`
- `page_size`
- `filter.status`
- 可重复的 `filter.task_ids`
- `filter.model`
- 底层 SDK 另支持 `filter.service_tier`，但外层 `MaasSeedanceClient` 当前未暴露此参数。

普通业务请求以 `Authorization: Bearer <MAAS_API_KEY>` 和 `Content-Type: application/json` 构造；在机密模式下，SDK 随后对消息体进行加密。

## 7. 机密通道与视频文件加密

### 7.1 请求/响应机密通道

根据 SDK 源码，远程证明地址由 Base URL 的 scheme 与 host 拼接为：

```text
https://zhenze-huhehaote.cmecloud.cn/v1/security/token
```

SDK 的安全 HTTP 客户端会设置：

```text
X-AICC-Encryption-Enable: true
X-AICC-Encryption-SDK: aicc
X-AICC-Encryption-Version: 0.1.0
```

随后用 SDK 内置的安全通道协议加密请求体并解密响应。此协议不能只凭这些 Header 重新实现；无 SDK 模式需要官方提供完整协议、兼容库或明确的非机密端点。

### 7.2 生成视频文件加密

启用文件加密时，创建请求还会设置：

```text
Enable-TOS-Content-Result-Encryption: true
X-Encryption-Algorithm: RSA_OAEP_4096_AES_256
PK: <Base64 编码的 PEM 公钥>
```

下载响应中 SDK 读取 `x-tos-meta-enc-dek`，使用 RSA 私钥解出文件密钥，再解密视频。Bridge 应下载至隔离临时文件，验证成功后原子移动到 Storage；失败时清理密文和临时文件。不得把私钥、`PK`、加密数据密钥或带凭证 URL写入日志/数据库。

## 8. 查询结果与状态映射

SDK/示例明确读取以下字段：

```json
{
  "status": "succeeded",
  "content": {
    "video_url": "<下载 URL>"
  },
  "error": "<失败信息，实际结构待确认>"
}
```

源码出现的 Provider 状态只有：

| Provider 状态 | 内部状态                                                           |
| ------------- | ------------------------------------------------------------------ |
| `pending`     | `PROCESSING`                                                       |
| `queued`      | `PROCESSING`                                                       |
| `running`     | `PROCESSING`                                                       |
| `succeeded`   | 先保持 `PROCESSING`；视频下载、解密并写入 Storage 后转 `SUCCEEDED` |
| `failed`      | `FAILED`                                                           |
| 未知值        | 不猜测；记录脱敏事件并保持可恢复状态/触发运维告警                  |

没有证据表明响应提供进度或用量，因此当前不得生成 `progress` 或 `UsageRecord`。`error` 的结构也未确认，适配器必须先以宽松但安全的 schema 捕获，再在拿到真实样例后收紧。

## 9. 下载行为

`download_video(task_id, path)` 会再次查询任务，仅当状态为 `succeeded` 且存在 `content.video_url` 时下载。SDK 当前通过 `requests.get(video_url, stream=True)` 下载；静态源码中未看到显式下载超时和 HTTP 状态检查。

Bridge 集成时应额外实施：

- 单次调用的进程级超时与并发上限。
- 仅允许 `https`，并对下载 host 建立配置化 allowlist，防止 SSRF。
- 限制最大下载大小，校验 MIME/文件签名和校验和。
- 使用服务生成的临时路径；SDK 拒绝覆盖已有非空文件。
- 成功解密和校验后再写入最终 Storage。

## 10. SDK 与无 SDK Provider 的统一能力

`SeedanceProvider` 上层契约保持不变，底层 transport 可替换：

| 能力           | `maas-sdk`   | `direct-http`                  |
| -------------- | ------------ | ------------------------------ |
| 模型映射       | SDK 自动执行 | 待官方确认                     |
| 机密请求通道   | SDK 内置     | 当前无实现依据                 |
| 创建/查询      | 可通过 SDK   | 路径已知，协议未完整确认       |
| 下载与文件解密 | SDK 支持     | 算法线索已知，完整兼容性待确认 |
| 删除           | SDK 支持     | 路径已知，语义待确认           |
| 取消           | 未确认       | 未确认                         |
| 用量           | 未发现       | 未确认                         |

选择 transport 的配置值为 `mock`、`maas-sdk` 或 `direct-http`。当选择尚不可用的 `direct-http` 时，服务必须启动失败并提示缺少协议配置，不能静默降级到明文请求。

## 11. 请你补充的具体位置

请直接编辑本节；未知项可先保留 `TODO`。不要填写真实 API Key。

### 11.1 官方协议与环境

- 官方文档版本/日期：`TODO`
- 测试环境 Base URL：`TODO`
- 生产环境 Base URL：`TODO`
- 无 SDK 是否被官方支持：`TODO（是/否）`
- 若支持，无 SDK 的机密通道协议或官方库：`TODO（文档或文件位置）`
- 是否要求固定出口 IP、代理或证书：`TODO`

### 11.2 创建参数约束

- 文本长度限制：`TODO`
- `content` 支持类型、角色、数量和顺序：`TODO`
- 素材 URL 可访问性/签名 URL 要求：`TODO`
- 图片格式、大小、分辨率：`TODO`
- 参考视频格式、大小、时长：`TODO`
- 参考音频格式、大小、时长：`TODO`
- `ratio` 完整枚举：`TODO`
- `duration` 单位、范围与枚举：`TODO`
- `generate_audio` 默认值与限制：`TODO`
- `watermark` 默认值与限制：`TODO`
- 其他必填/可选字段：`TODO`

### 11.3 响应、状态与错误

- 创建成功的脱敏响应样例：`TODO`
- 查询处理中/成功/失败的脱敏响应样例：`TODO`
- 状态完整枚举及含义：`TODO`
- HTTP 错误码和业务错误结构：`TODO`
- 限流 Header、配额和安全重试规则：`TODO`
- 是否支持幂等键或按客户端 ID 查询：`TODO`
- 删除是否等同于取消，允许在哪些状态调用：`TODO`
- 输出 URL 有效期、下载鉴权和允许 host：`TODO`
- 是否返回进度、用量、token 或计费单位：`TODO`

### 11.4 SDK 运维信息

- SDK/ZIP 是否允许纳入私有镜像或私有制品库：`TODO`
- SDK 更新和校验渠道：`TODO`
- 官方支持的 Python 版本与操作系统/架构：`TODO`
- SDK 日志是否可关闭或配置脱敏：`TODO`
- 推荐轮询间隔、任务最长处理时间：`TODO`

## 12. 已知 SDK 集成风险

- SDK 初始化的模型映射请求会记录响应正文。
- 创建方法会记录完整请求体，可能包含提示词和素材 URL。
- 创建非 200 时只返回空任务 ID，错误细节可能丢失。
- 查询非 200 时可能直接返回错误 JSON，需与正常任务响应区分。
- 下载代码未显式设置超时或调用 `raise_for_status()`。
- 若一个 PEM 文件缺失，SDK 会重新生成整对密钥；密钥目录必须持久化并监控。
- SDK 下载解密失败时可能留下文件，Bridge 必须使用隔离临时目录并清理。

这些风险由 Bridge 的日志过滤、调用超时、响应校验、临时文件隔离和健康检查缓解；不得直接修改 wheel 后再把它当作原版 SDK。
