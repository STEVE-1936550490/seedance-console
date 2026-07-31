# Seedance AICC Bridge HTTP 契约

## 1. 范围

本契约定义 TypeScript `SeedanceProviderAdapter` 与私有 Python AICC Bridge 之间的
最小 HTTP 边界。TypeScript Client、Zod schema、Python 服务、固定 SDK 镜像和
fake Bridge 测试均已实现；create、query 和 output stream 已由唯一真实 Demo 验证。

Bridge 只能监听 Docker 私有网络，不发布公网端口。真实 API Key、AICC SDK 和 RSA
私钥只存在于 Bridge；Web 与 API 不接触这些值。

## 2. 鉴权与通用规则

Worker 对每个请求发送：

```http
Authorization: Bearer <SEEDANCE_BRIDGE_TOKEN>
Accept: application/json
```

规则：

- Token 只通过服务端环境变量注入 Worker 和 Bridge。
- Bridge URL、Token、Authorization、完整素材 URL、完整视频签名 URL 和请求 body 不写日志。
- JSON 请求与响应拒绝未知顶层字段。
- task ID 作为单个 URL path segment 编码。
- 创建操作不自动重试；查询和下载错误只标记为可安全重试，由后续 Worker 调度决定。

## 3. 健康检查

```http
GET /health
```

成功：

```json
{
  "status": "ok",
  "capabilities": {
    "cancellation": false
  }
}
```

健康检查只验证进程、配置和本地 SDK 可加载性，不创建任务，不调用收费接口。

## 4. 创建视频任务

```http
POST /v1/video/tasks
Content-Type: application/json
```

请求：

```json
{
  "clientRequestId": "internal-request-id",
  "model": "configured-model-id",
  "request": {
    "content": [
      {
        "type": "text",
        "text": "fixture prompt"
      },
      {
        "type": "image_url",
        "image_url": {
          "url": "https://assets.invalid/input/fixture.jpg?token=redacted"
        },
        "role": "reference_image"
      }
    ],
    "generate_audio": true,
    "ratio": "16:9",
    "duration": 11,
    "watermark": false
  }
}
```

成功：

```json
{
  "id": "provider-task-id"
}
```

`clientRequestId` 供 Bridge 本地提交注册表使用，不作为未经确认的 Provider 字段发送。HTTP 超时、连接中断或 5xx 导致创建结果不明确时返回/映射为 `PROVIDER_CREATE_OUTCOME_UNKNOWN`，Worker 不得自动重复创建。

Bridge 必须先按 `clientRequestId` 查询自己的持久化注册表。已有映射时返回原 `id`，不得再次调用 Provider。

Worker 恢复提交状态时调用：

```http
GET /v1/video/submissions/{clientRequestId}
```

找到映射时返回 `{"id":"provider-task-id"}`，尚无映射时返回
`{"id":null}`。该读取操作不得触发 Provider 创建。

## 5. 查询视频任务

```http
GET /v1/video/tasks/{providerTaskId}
```

处理中：

```json
{
  "status": "running"
}
```

成功：

```json
{
  "status": "succeeded",
  "content": {
    "video_url": "https://media.invalid/output/video.mp4?token=redacted"
  }
}
```

失败：

```json
{
  "status": "failed",
  "error": {
    "fixture": true
  }
}
```

当前只允许 `pending`、`queued`、`running`、`succeeded`、`failed` 进入 Adapter 映射。Bridge schema 接受非空字符串以便检测未来状态；Adapter 对未知状态抛协议错误，不猜测内部状态。

原始 `error` 结构尚未确认，只能用于 Bridge 内部判断。TypeScript Adapter 不透传它，失败任务返回稳定通用错误。

## 6. 取消/删除

```http
DELETE /v1/video/tasks/{providerTaskId}
```

当前 capability 为 false，Bridge 应返回：

```http
HTTP/1.1 501 Not Implemented
Content-Type: application/json
```

```json
{
  "error": {
    "code": "OPERATION_UNSUPPORTED",
    "message": "Provider cancellation is not supported.",
    "operation": "CANCEL",
    "retry": "NEVER",
    "requestId": "internal-correlation-id"
  }
}
```

SDK 的 DELETE 是否代表远端取消尚未确认，因此本阶段不得调用真实删除接口。

## 7. 下载并解密输出

```http
GET /v1/video/tasks/{providerTaskId}/output
Accept: video/*
```

成功：

```http
HTTP/1.1 200 OK
Content-Type: video/mp4
Content-Length: <bytes>

<binary video stream>
```

Bridge 使用 SDK 重新查询视频 URL、下载和解密；TypeScript Client 不接收或记录
完整签名 URL。自动化测试的 fake server 返回测试字节，真实 Demo 已验证 MP4
stream、Worker 校验和本地落盘。

失败使用统一 JSON 错误。部分文件、密文和明文临时文件必须由 Bridge 清理。

## 8. 统一错误

```json
{
  "error": {
    "code": "STABLE_ERROR_CODE",
    "message": "Safe error message.",
    "operation": "GET",
    "retry": "SAFE_READ",
    "retryAfterMs": 1000,
    "requestId": "internal-correlation-id"
  }
}
```

字段：

| 字段           | 类型          | 说明                                                             |
| -------------- | ------------- | ---------------------------------------------------------------- |
| `code`         | string        | Bridge 稳定错误码，不直接使用未知 Provider 业务码                |
| `message`      | string        | 脱敏文本                                                         |
| `operation`    | enum          | `HEALTH`、`CREATE`、`RECOVER`、`GET`、`CANCEL`、`DOWNLOAD`       |
| `retry`        | enum          | `NEVER`、`SAFE_READ`、`IDEMPOTENT_ONLY`、`MANUAL_RECONCILIATION` |
| `retryAfterMs` | integer，可选 | Bridge 明确给出的等待时间                                        |
| `requestId`    | string，可选  | 脱敏关联 ID；仅允许安全字符，不是密钥                            |

HTTP 分类：

- 401/403：认证失败，不重试。
- 429：查询/下载可标记 `SAFE_READ`；创建不自动重试。
- 创建 5xx/超时：结果未知，人工协调。
- SDK 创建收到非 200：`PROVIDER_CREATE_HTTP_ERROR`，结果保守视为未知，人工协调。
- SDK 创建收到 200 但缺少非空 ID：`PROVIDER_CREATE_RESPONSE_MISSING_ID`，人工协调。
- 查询/下载 5xx/超时：暂时错误，可由 Worker 退避重试。

创建诊断只持久化 Bridge 稳定分类、HTTP 状态、受限 Provider 业务码及 allowlist
关联 ID。不得持久化响应正文、错误消息、Authorization、API Key、完整 URL 或请求体。

- 501：能力不支持。
- 无效 JSON、缺字段或未知字段：协议错误。

错误响应不得包含 Token、Authorization、SDK traceback、API Key、原始请求、完整 Provider 响应或签名 URL。
