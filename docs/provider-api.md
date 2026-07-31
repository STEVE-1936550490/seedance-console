# Seedance 2.0 Provider API

> 本文主体保留最初静态审计的证据和 `TODO_CONFIRM`，其中“未安装/未执行”描述的是
> 当时的审计阶段。当前已选择并实现私有 Python AICC Bridge，固定 SDK 已安装在
> Bridge 镜像中，唯一真实纯文生视频 Demo 已成功。当前事实状态见
> [真实 Provider Demo 最终检查点](REAL_PROVIDER_DEMO_CHECKPOINT.md)。

## 1. 文档状态与证据

本文根据以下本地材料静态整理，未安装、导入或执行 SDK，也未向移动云发起请求：

- 根目录 `pythonSDK-0515.zip`
- ZIP 内的 `maas_seedance_sdk-1.0.0-py3-none-any.whl`
- ZIP 中的 `maas_seedance_demo.py`

SDK 元数据确认包名为 `maas_seedance_sdk`、版本 `1.0.0`、要求 Python `>=3.8`。本文将信息分为：

- **已由 SDK 源码确认**：方法、路径、请求头和源码直接读取的响应字段。
- **仅由示例确认**：示例出现过，但合法取值、边界和默认值仍未知。
- **`TODO_CONFIRM`**：不能从 SDK 安全推断，真实适配器实现前必须由官方文档、平台页面或脱敏接口样例确认。

源码行为不等同于完整官方协议。官方文档与实际测试结果优先级更高。

当前本地制品校验值：

```text
pythonSDK-0515.zip
SHA-256 e718a80945c6885172aaf17826ca9fd362d0ba0d805d42ea07242f020a6cece9

maas_seedance_sdk-1.0.0-py3-none-any.whl
SHA-256 36f86be4d97400c1964eba0a0f9b845e047e8430499ae42990cb98cb9d961039
```

## 2. 历史候选调用边界与当前选型

```text
TypeScript Worker
  └─ SeedanceProvider
       ├─ mock        -> MockSeedanceProvider
       └─ seedance
            ├─ TypeScript HTTP Transport -> 移动云（优先，待官方协议确认）
            └─ 内网 Python Provider Bridge -> maas_seedance SDK -> 移动云（仅在 SDK 必需时）
```

以下是 P1/P2 当时的选型原则：

- 若官方确认 TypeScript 可以完整实现鉴权、AICC/机密通道、创建、查询和下载，则优先在现有 TypeScript Provider Adapter 内实现。
- 只有官方确认真实 API 必须通过当前 Python SDK，或未提供可兼容实现的机密通道协议时，才引入私有 Python Provider Bridge。
- 若使用 Bridge，它只能监听 Docker 内部网络，不能向浏览器或公网发布；API Key、RSA 私钥和 SDK 原始响应不能离开 Bridge。
- 不论 transport 如何选择，API、Worker 业务状态、数据库和前端只使用内部 Provider DTO。

当前已经选择并实现私有 Python AICC Bridge，真实 create、query、SDK
download/decrypt 和本地持久化均已通过唯一纯文生视频 Demo。Direct TypeScript
transport 仍是 **不可用/待确认** 状态；在官方提供完整 AICC 协议或兼容库前，不能
仅照抄 URL 和 Bearer Header。

## 3. 配置及实际 API Key 填写位置

不要把真实值写进本文、Git、TypeScript 源码、Next.js 环境变量或任何 `NEXT_PUBLIC_*` 变量。

当前 Python Bridge 部署在服务器使用独立的 SDK 配置文件：

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

这些是 SDK 构造器字段的参考映射；Bridge 同时兼容当前统一的 `AICC_*`、
`MAAS_*` 和 `SEEDANCE_*` 配置别名。Base URL 必须包含 `/api/v3`。配置文件权限应为
`0600`，只注入 Python Provider Bridge；不要注入 `web` 或 `api` 容器。Docker
Compose 显式引用外部 `env_file`，不把密钥复制进仓库。

密钥目录必须提前创建并持久化。SDK 在任一 PEM 文件缺失时会生成一对 RSA 4096 密钥，但不会创建父目录；私钥权限应为 `0600`。生产环境不要使用示例的相对 `./tmp` 路径。

## 4. Python SDK 调用契约

### 4.1 安装边界

SDK 现只安装在 `services/provider-bridge` Python 镜像中，不安装到 Next.js、
Fastify 或 TypeScript Worker，也不从浏览器动态下载。镜像从已审核的私有制品中
提取 wheel 并固定版本/校验值：

```bash
python -m pip install --no-cache-dir ./maas_seedance_sdk-1.0.0-py3-none-any.whl
```

当前 Bridge Docker 构建已经执行等价安装，并在安装前校验 wheel SHA-256。制品的
长期私有分发与授权仍需按第 11.4 节管理。

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

## 10. SDK 与无 SDK 候选 transport 的能力差异

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

应用层 Provider 只应暴露 `mock` 与 `seedance`；`seedance` 内部采用 TypeScript transport 还是 Python SDK Bridge，留待 P2 在协议确认后设计。任何 transport 缺少完整协议或安全配置时都必须启动失败，不能静默降级到明文请求。

## 11. 真实 Provider 协议确认矩阵

本节是实现真实 Provider 前的阻断清单。“示例确认”只表示字段或值出现在附带 demo 中，不代表生产环境、完整枚举、默认值或限制已经获得官方保证。

| #   | 必须确认项                                 | 当前可确认信息                                                                                                                     | 尚缺信息                                                                                                                                        |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | API Base URL                               | demo 使用 `https://zhenze-huhehaote.cmecloud.cn/api/v3`；SDK 业务路径相对此地址拼接。                                              | `TODO_CONFIRM` 测试与生产 Base URL、区域差异、API 版本、是否要求固定出口 IP/代理/自定义 CA。                                                    |
| 2   | 鉴权方式                                   | SDK 源码构造 `Authorization: Bearer <MAAS_API_KEY>` 和 JSON 请求；机密模式还执行远程证明与消息体加密。                             | `TODO_CONFIRM` Key 创建/权限/轮换/过期规则，是否还有租户、项目或签名 Header，无 SDK 调用是否受支持。                                            |
| 3   | 实际模型 ID                                | demo 传入 `doubao-seedance-2.0`，SDK 再调用 `/mapping/query` 获取 endpoint。                                                       | `TODO_CONFIRM` 当前账号实际开通的模型 ID、endpoint 映射结果、模型版本与退役策略。示例值不得直接视为生产可用模型。                               |
| 4   | 创建视频任务接口                           | SDK 源码使用 `POST /contents/generations/tasks`；HTTP 200 时读取响应 `id`。                                                        | `TODO_CONFIRM` 正式请求 schema、成功 HTTP 状态全集、响应完整 schema 和任务 ID 约束。                                                            |
| 5   | 查询任务接口                               | SDK 源码使用 `GET /contents/generations/tasks/{task_id}`。                                                                         | `TODO_CONFIRM` 正式响应 schema、404/过期语义、允许轮询频率和任务最长保留时间。                                                                  |
| 6   | 取消任务接口是否存在                       | SDK 提供 `DELETE /contents/generations/tasks/{task_id}`，方法名语义是删除。                                                        | `TODO_CONFIRM` 是否支持取消正在生成的任务、DELETE 是删除记录还是取消计算、允许调用状态、重复调用语义。                                          |
| 7   | 图片/视频/音频素材如何提交                 | demo 的 `content` 使用 `image_url`、`video_url`、`audio_url`，角色分别为 `reference_image`、`reference_video`、`reference_audio`。 | `TODO_CONFIRM` 各素材类型是否都正式支持、数量/顺序/组合规则、URL 可访问性和生命周期要求。                                                       |
| 8   | 素材使用 URL、Base64、`file_id` 或上传接口 | 现有 demo 只展示 URL。SDK 公共方法中未发现独立素材上传方法。                                                                       | `TODO_CONFIRM` 是否支持 Base64、`file_id`、multipart 或独立上传接口，私有对象存储如何授权。                                                     |
| 9   | 文件格式和大小限制                         | 现有材料没有完整限制。                                                                                                             | `TODO_CONFIRM` 图片/视频/音频的 MIME、扩展名、字节数、分辨率、时长、编码、声道和数量限制。                                                      |
| 10  | 文生视频和图生视频请求参数                 | demo 展示文本项以及文本与多种参考素材组合；`content` 中的文本项使用 `{"type":"text","text":"..."}`。                               | `TODO_CONFIRM` 纯文本最小请求、图生视频最小请求、必填字段、首尾帧/参考图角色、提示词长度和组合互斥规则。                                        |
| 11  | 分辨率、比例、时长、帧率范围               | demo 只展示 `ratio: "16:9"`、`duration: 11`；未展示分辨率和帧率字段。                                                              | `TODO_CONFIRM` `ratio`、分辨率、`duration`、帧率的字段名、类型、单位、枚举/范围、默认值和模型相关限制；`generate_audio`、`watermark` 也需确认。 |
| 12  | 服务商完整任务状态集合                     | SDK/示例源码出现 `pending`、`queued`、`running`、`succeeded`、`failed`。                                                           | `TODO_CONFIRM` 完整枚举、大小写、每个状态是否终态、取消/过期/审核状态、未知状态处理要求。                                                       |
| 13  | 成功返回结构                               | 创建成功源码读取顶层 `id`；查询成功示例读取 `status`，下载逻辑读取 `content.video_url`。                                           | `TODO_CONFIRM` 创建和查询的完整脱敏 JSON 样例、输出数组/单对象语义、媒体元数据、完成时间、校验和。                                              |
| 14  | 失败返回结构                               | 示例查询可能读取顶层 `error`，但类型和层级未确认；SDK 非 200 行为不统一。                                                          | `TODO_CONFIRM` 创建/查询/下载失败的脱敏 JSON、HTTP 状态、业务码、消息、request ID 和可重试标志。                                                |
| 15  | 错误码                                     | 现有材料没有正式错误码表。                                                                                                         | `TODO_CONFIRM` 鉴权、参数、素材、审核、配额、限流、服务故障、任务不存在和下载失败的完整错误码。                                                 |
| 16  | 429 和 5xx 重试规则                        | 现有材料没有官方规则。                                                                                                             | `TODO_CONFIRM` 哪些操作可重试、`Retry-After`/限流 Header、退避上限、最大次数；创建任务结果不明时禁止盲目重发。                                  |
| 17  | 幂等键                                     | 现有材料未发现幂等 Header 或按客户端请求 ID 查询能力。                                                                             | `TODO_CONFIRM` 创建是否支持幂等键、键名/格式/有效期/冲突语义，以及超时后如何确认创建结果。                                                      |
| 18  | Webhook                                    | SDK 公共方法和 demo 未展示 Webhook。                                                                                               | `TODO_CONFIRM` 是否支持回调、注册方式、签名验证、重放防护、事件类型、重试与顺序保证。                                                           |
| 19  | 视频下载是否需要鉴权                       | SDK 下载逻辑对 `content.video_url` 发起流式 GET；静态源码未见显式附加业务 API Authorization。                                      | `TODO_CONFIRM` URL 是否自带签名、是否还需 Header/Cookie、允许 host、重定向规则、机密视频解密前置条件。                                          |
| 20  | 视频 URL 有效期                            | 现有材料未说明。                                                                                                                   | `TODO_CONFIRM` URL TTL、起算时间、能否刷新、任务记录保留时间和过期后的恢复方式。                                                                |
| 21  | Token、用量和费用字段                      | 现有 SDK/示例未发现可确认的进度、Token、用量或费用字段。                                                                           | `TODO_CONFIRM` 字段路径、单位、精度、币种、税费、预估/实付语义、何时最终确定以及缺失语义。                                                      |
| 22  | 请求并发和限流                             | 现有材料未说明。                                                                                                                   | `TODO_CONFIRM` 账号/模型/区域的 QPS、并发任务数、队列上限、日/月配额、限流响应 Header。                                                         |
| 23  | 内容审核失败返回方式                       | 现有材料未展示内容审核响应。                                                                                                       | `TODO_CONFIRM` 审核发生阶段、状态或错误码、可展示消息、是否计费、是否允许修改后重试。                                                           |
| 24  | AICC/机密计算环境                          | SDK 源码请求 `/v1/security/token`，并设置 `X-AICC-Encryption-*` Header 后加密消息体；生成视频还可请求文件加密。                    | `TODO_CONFIRM` 官方对 AICC/机密计算的数据流说明、覆盖范围、是否强制、证明验证要求、数据驻留/保留策略和合规材料。                                |
| 25  | 取消后的最终状态语义                       | 内部系统已有 `CANCELLED`，但 SDK 只有语义未明的 DELETE。                                                                           | `TODO_CONFIRM` Provider 取消成功/受理/冲突响应，最终状态名、竞态处理、是否计费、输出是否保留、删除与取消的关系。                                |

## 12. 补充运维协议

以下信息同样不能从当前业务样例安全推断：

- SDK/ZIP 是否允许纳入私有镜像或私有制品库：`TODO_CONFIRM`
- SDK 官方下载、更新、签名和校验渠道：`TODO_CONFIRM`
- 除元数据中的 Python `>=3.8` 外，官方支持的 Python 版本、操作系统和 CPU 架构：`TODO_CONFIRM`
- SDK 日志是否可关闭、调整级别或配置脱敏：`TODO_CONFIRM`
- 推荐轮询间隔、单任务最长处理时间和任务保留时间：`TODO_CONFIRM`
- SDK/服务端超时建议，以及代理、DNS、TLS 和证书要求：`TODO_CONFIRM`

## 13. 已知 SDK 集成风险

- SDK 初始化的模型映射请求会记录响应正文。
- 创建方法会记录完整请求体，可能包含提示词和素材 URL。
- 创建非 200 时只返回空任务 ID，错误细节可能丢失。
- 查询非 200 时可能直接返回错误 JSON，需与正常任务响应区分。
- 下载代码未显式设置超时或调用 `raise_for_status()`。
- 若一个 PEM 文件缺失，SDK 会重新生成整对密钥；密钥目录必须持久化并监控。
- SDK 下载解密失败时可能留下文件，Bridge 必须使用隔离临时目录并清理。

这些风险由 Bridge 的日志过滤、调用超时、响应校验、临时文件隔离和健康检查缓解；不得直接修改 wheel 后再把它当作原版 SDK。
