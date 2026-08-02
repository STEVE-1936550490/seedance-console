from __future__ import annotations

import hmac
import ipaddress
import json
import logging
import os
import re
import shutil
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from .config import BridgeConfig
from .registry import SubmissionRegistry
from .sdk_runtime import (
    AiccRuntime,
    DownloadLimitError,
    DownloadTargetError,
    ProviderCreateDiagnostic,
    ProviderCreateError,
    ProviderCreateHttpError,
    ProviderCreateNotSentError,
)

TASK_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,256}$")
KNOWN_STATUSES = {"pending", "queued", "running", "succeeded", "failed"}
LOGGER = logging.getLogger("seedance_provider_bridge")


class BridgeApplication:
    def __init__(
        self,
        config: BridgeConfig,
        runtime: AiccRuntime,
        registry: SubmissionRegistry,
    ):
        self.config = config
        self.runtime = runtime
        self.registry = registry

    def handler_class(self):
        application = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "SeedanceBridge/1"
            sys_version = ""

            def log_message(self, _format, *_args):
                return

            def do_GET(self):
                application._handle_get(self)

            def do_POST(self):
                application._handle_post(self)

        return Handler

    def _handle_get(self, handler: BaseHTTPRequestHandler) -> None:
        if not self._authorized(handler):
            return
        path = urlparse(handler.path).path
        if path == "/health":
            self._json(
                handler,
                HTTPStatus.OK,
                {"status": "ok", "capabilities": {"cancellation": False}},
            )
            return
        output_match = re.fullmatch(
            r"/v1/video/tasks/([^/]+)/output", path
        )
        if output_match:
            provider_task_id = self._task_id(output_match.group(1))
            if provider_task_id is None:
                self._error(handler, 400, "DOWNLOAD", "INVALID_TASK_ID")
                return
            self._download(handler, provider_task_id)
            return
        task_match = re.fullmatch(r"/v1/video/tasks/([^/]+)", path)
        if task_match:
            provider_task_id = self._task_id(task_match.group(1))
            if provider_task_id is None:
                self._error(handler, 400, "GET", "INVALID_TASK_ID")
                return
            self._query(handler, provider_task_id)
            return
        self._error(handler, 404, "GET", "NOT_FOUND")

    def _handle_post(self, handler: BaseHTTPRequestHandler) -> None:
        if not self._authorized(handler):
            return
        path = urlparse(handler.path).path
        if path == "/v1/video/submissions/reconcile":
            body = self._body(handler, "RECOVER")
            if body is None:
                return
            client_request_id = body.get("clientRequestId")
            outcome = body.get("outcome")
            provider_task_id = body.get("providerTaskId")
            if (
                not self._client_request_id(client_request_id)
                or outcome not in {"ACCEPTED", "NOT_CREATED"}
                or (
                    outcome == "ACCEPTED"
                    and (
                        not isinstance(provider_task_id, str)
                        or self._task_id(provider_task_id) is None
                    )
                )
                or (outcome == "NOT_CREATED" and provider_task_id is not None)
            ):
                self._error(handler, 400, "RECOVER", "INVALID_REQUEST")
                return
            if outcome == "ACCEPTED":
                self.registry.accept(client_request_id, provider_task_id)
                updated = True
            else:
                updated = self.registry.confirm_not_created(client_request_id)
            self._json(handler, 200, {"updated": updated})
            return
        if path == "/v1/video/tasks/recover":
            body = self._body(handler, "RECOVER")
            if body is None:
                return
            client_request_id = body.get("clientRequestId")
            if not self._client_request_id(client_request_id):
                self._error(handler, 400, "RECOVER", "INVALID_REQUEST")
                return
            self._json(
                handler,
                200,
                {"id": self.registry.recover(client_request_id)},
            )
            return
        if path != "/v1/video/tasks":
            self._error(handler, 404, "CREATE", "NOT_FOUND")
            return
        if not self.config.create_enabled:
            self._error(
                handler,
                403,
                "CREATE",
                "REAL_API_TEST_DISABLED",
                "NEVER",
            )
            return
        body = self._body(handler, "CREATE")
        if body is None:
            return
        validated = self._create_request(body)
        if validated is None:
            self._error(handler, 400, "CREATE", "INVALID_REQUEST")
            return
        (
            client_request_id,
            create_attempt_id,
            request_payload_sha256,
            provider_request,
        ) = validated
        supplied_bridge_request_id = handler.headers.get(
            "X-Bridge-Request-Id", ""
        )
        bridge_request_id = (
            supplied_bridge_request_id
            if self._audit_identifier(supplied_bridge_request_id)
            else str(uuid.uuid4())
        )
        is_new, submission = self.registry.begin(
            client_request_id,
            create_attempt_id=create_attempt_id,
            request_payload_sha256=request_payload_sha256,
            bridge_request_id=bridge_request_id,
        )
        if not is_new:
            if (
                submission.status == "ACCEPTED"
                and submission.provider_task_id is not None
            ):
                self._json(handler, 200, {"id": submission.provider_task_id})
                return
            self._error(
                handler,
                409,
                "CREATE",
                "PROVIDER_OUTCOME_UNKNOWN",
                "MANUAL_RECONCILIATION",
            )
            return
        try:
            provider_task_id = self.runtime.create_task(provider_request)
            diagnostic = getattr(
                self.runtime, "last_create_diagnostic", None
            ) or ProviderCreateDiagnostic(request_body_sent=True)
            self.registry.accept(
                client_request_id,
                provider_task_id,
                provider_request_id=diagnostic.request_id,
                provider_trace_id=diagnostic.trace_id,
                request_started_at=diagnostic.request_started_at,
                request_ended_at=diagnostic.request_ended_at,
                request_body_sent=diagnostic.request_body_sent,
            )
            self._json(
                handler,
                200,
                {
                    "id": provider_task_id,
                    "audit": self._audit_response(
                        bridge_request_id, diagnostic
                    ),
                },
            )
        except (ProviderCreateNotSentError, ProviderCreateHttpError) as error:
            self.registry.mark_not_created(
                client_request_id,
                error_code=error.code,
                **self._registry_diagnostic(error.diagnostic),
            )
            self._log_create_failure(
                error.code, bridge_request_id, error.diagnostic
            )
            self._error(
                handler,
                502,
                "CREATE",
                error.code,
                "NEVER",
                error.diagnostic.request_id,
                self._audit_response(bridge_request_id, error.diagnostic),
            )
        except ProviderCreateError as error:
            self.registry.mark_unknown(
                client_request_id,
                error_code=error.code,
                **self._registry_diagnostic(error.diagnostic),
            )
            self._log_create_failure(
                error.code, bridge_request_id, error.diagnostic
            )
            self._error(
                handler,
                502,
                "CREATE",
                error.code,
                "MANUAL_RECONCILIATION",
                error.diagnostic.request_id,
                self._audit_response(bridge_request_id, error.diagnostic),
            )
        except Exception as error:
            diagnostic = ProviderCreateDiagnostic(
                failure_stage="BRIDGE_RUNTIME",
                exception_type=type(error).__name__[:128],
                request_body_sent=None,
            )
            self.registry.mark_unknown(
                client_request_id,
                error_code="PROVIDER_CREATE_OUTCOME_UNKNOWN",
                **self._registry_diagnostic(diagnostic),
            )
            self._log_create_failure(
                "PROVIDER_CREATE_OUTCOME_UNKNOWN",
                bridge_request_id,
                diagnostic,
            )
            self._error(
                handler,
                502,
                "CREATE",
                "PROVIDER_CREATE_OUTCOME_UNKNOWN",
                "MANUAL_RECONCILIATION",
                audit=self._audit_response(bridge_request_id, diagnostic),
            )

    @staticmethod
    def _log_create_failure(
        classification: str,
        bridge_request_id: str,
        diagnostic: ProviderCreateDiagnostic,
    ) -> None:
        LOGGER.warning(
            "provider_create_failed classification=%s http_status=%s "
            "provider_error_code=%s provider_request_id=%s "
            "provider_trace_id=%s bridge_request_id=%s failure_stage=%s "
            "exception_type=%s request_body_sent=%s stack_fingerprint=%s",
            classification,
            diagnostic.http_status,
            diagnostic.error_code,
            diagnostic.request_id,
            diagnostic.trace_id,
            bridge_request_id,
            diagnostic.failure_stage,
            diagnostic.exception_type,
            diagnostic.request_body_sent,
            diagnostic.stack_fingerprint,
        )

    @staticmethod
    def _registry_diagnostic(diagnostic: ProviderCreateDiagnostic) -> dict:
        return {
            "provider_http_status": diagnostic.http_status,
            "provider_error_code": diagnostic.error_code,
            "provider_request_id": diagnostic.request_id,
            "provider_trace_id": diagnostic.trace_id,
            "request_started_at": diagnostic.request_started_at,
            "request_ended_at": diagnostic.request_ended_at,
            "failure_stage": diagnostic.failure_stage,
            "exception_type": diagnostic.exception_type,
            "request_body_sent": diagnostic.request_body_sent,
            "stack_fingerprint": diagnostic.stack_fingerprint,
        }

    @staticmethod
    def _audit_response(
        bridge_request_id: str, diagnostic: ProviderCreateDiagnostic
    ) -> dict:
        values = {
            "bridgeRequestId": bridge_request_id,
            "requestStartedAt": diagnostic.request_started_at,
            "requestEndedAt": diagnostic.request_ended_at,
            "failureStage": diagnostic.failure_stage,
            "exceptionType": diagnostic.exception_type,
            "requestBodySent": diagnostic.request_body_sent,
            "providerHttpStatus": diagnostic.http_status,
            "providerErrorCode": diagnostic.error_code,
            "providerRequestId": diagnostic.request_id,
            "providerTraceId": diagnostic.trace_id,
        }
        return {key: value for key, value in values.items() if value is not None}

    def _query(
        self, handler: BaseHTTPRequestHandler, provider_task_id: str
    ) -> None:
        try:
            snapshot = self.runtime.query_task(provider_task_id)
            status = snapshot.get("status")
            if status not in KNOWN_STATUSES:
                self._error(handler, 502, "GET", "PROVIDER_PROTOCOL_ERROR")
                return
            response: dict[str, object] = {"status": status}
            if status == "succeeded":
                content = snapshot.get("content")
                video_url = (
                    content.get("video_url")
                    if isinstance(content, dict)
                    else None
                )
                if not isinstance(video_url, str) or not video_url:
                    self._error(
                        handler, 502, "GET", "PROVIDER_OUTPUT_MISSING"
                    )
                    return
                response["content"] = {"video_url": video_url}
            elif status == "failed":
                response["error"] = "Provider task failed."
            self._json(handler, 200, response)
        except Exception:
            self._error(
                handler, 503, "GET", "PROVIDER_TRANSIENT_ERROR", "SAFE_READ"
            )

    def _download(
        self, handler: BaseHTTPRequestHandler, provider_task_id: str
    ) -> None:
        output: Path | None = None
        try:
            output = self.runtime.download_output(provider_task_id)
            size = output.stat().st_size
            handler.send_response(200)
            handler.send_header("Content-Type", "video/mp4")
            handler.send_header("Content-Length", str(size))
            handler.send_header("Cache-Control", "no-store")
            handler.end_headers()
            with output.open("rb") as source:
                shutil.copyfileobj(source, handler.wfile, length=64 * 1024)
        except DownloadTargetError:
            self._error(handler, 502, "DOWNLOAD", "PROVIDER_OUTPUT_INVALID")
        except DownloadLimitError:
            self._error(handler, 413, "DOWNLOAD", "PROVIDER_OUTPUT_INVALID")
        except Exception:
            self._error(
                handler,
                503,
                "DOWNLOAD",
                "PROVIDER_TRANSIENT_ERROR",
                "SAFE_READ",
            )
        finally:
            if output is not None:
                output.unlink(missing_ok=True)

    def _authorized(self, handler: BaseHTTPRequestHandler) -> bool:
        expected = f"Bearer {self.config.bridge_token}"
        supplied = handler.headers.get("Authorization", "")
        if hmac.compare_digest(supplied, expected):
            return True
        self._error(handler, 401, "HEALTH", "UNAUTHORIZED")
        return False

    def _body(
        self, handler: BaseHTTPRequestHandler, operation: str
    ) -> dict | None:
        try:
            content_length = int(handler.headers.get("Content-Length", "0"))
            if content_length <= 0 or content_length > 64 * 1024:
                raise ValueError
            value = json.loads(handler.rfile.read(content_length))
            if not isinstance(value, dict):
                raise ValueError
            return value
        except Exception:
            self._error(handler, 400, operation, "INVALID_JSON")
            return None

    def _create_request(
        self, value: dict
    ) -> tuple[str, str | None, str | None, dict] | None:
        required = {"clientRequestId", "model", "request"}
        optional = {"createAttemptId", "requestPayloadSha256"}
        if not required.issubset(value) or not set(value).issubset(
            required | optional
        ):
            return None
        client_request_id = value.get("clientRequestId")
        if not self._client_request_id(client_request_id):
            return None
        create_attempt_id = value.get("createAttemptId")
        if create_attempt_id is not None and not self._audit_identifier(
            create_attempt_id
        ):
            return None
        request_payload_sha256 = value.get("requestPayloadSha256")
        if request_payload_sha256 is not None and not re.fullmatch(
            r"[a-f0-9]{64}", request_payload_sha256
        ):
            return None
        if value.get("model") != self.config.model_id:
            return None
        request = value.get("request")
        if not isinstance(request, dict) or set(request) != {
            "content",
            "generate_audio",
            "ratio",
            "duration",
            "watermark",
        }:
            return None
        content = request.get("content")
        if (
            not isinstance(content, list)
            or len(content) not in {1, 2}
            or not isinstance(content[0], dict)
            or set(content[0]) != {"type", "text"}
            or content[0].get("type") != "text"
            or not isinstance(content[0].get("text"), str)
            or not content[0]["text"].strip()
        ):
            return None
        if len(content) == 2:
            asset = content[1]
            if not isinstance(asset, dict):
                return None
            is_image = (
                set(asset) == {"type", "image_url", "role"}
                and asset.get("type") == "image_url"
                and asset.get("role") == "reference_image"
                and isinstance(asset.get("image_url"), dict)
                and set(asset["image_url"]) == {"url"}
                and self._public_https_url(asset["image_url"].get("url"))
            )
            is_video = (
                set(asset) == {"type", "video_url", "role"}
                and asset.get("type") == "video_url"
                and asset.get("role") == "reference_video"
                and isinstance(asset.get("video_url"), dict)
                and set(asset["video_url"]) == {"url"}
                and self._public_https_url(asset["video_url"].get("url"))
            )
            if not is_image and not is_video:
                return None
        if (
            request.get("generate_audio") is not False
            or request.get("ratio") != "16:9"
            or request.get("duration") != 11
            or request.get("watermark") is not False
        ):
            return None
        return (
            client_request_id,
            create_attempt_id,
            request_payload_sha256,
            request,
        )

    @staticmethod
    def _public_https_url(value: object) -> bool:
        if not isinstance(value, str) or len(value) > 4096:
            return False
        parsed = urlparse(value)
        hostname = (parsed.hostname or "").lower()
        try:
            ipaddress.ip_address(hostname)
            is_ip_literal = True
        except ValueError:
            is_ip_literal = False
        return (
            parsed.scheme == "https"
            and bool(hostname)
            and parsed.username is None
            and parsed.password is None
            and not is_ip_literal
            and hostname != "localhost"
            and not hostname.endswith(".localhost")
            and not hostname.endswith(".local")
            and "." in hostname
        )

    @staticmethod
    def _client_request_id(value: object) -> bool:
        return (
            isinstance(value, str)
            and 1 <= len(value) <= 128
            and all(character.isalnum() or character in "-_" for character in value)
        )

    @staticmethod
    def _audit_identifier(value: object) -> bool:
        return (
            isinstance(value, str)
            and 1 <= len(value) <= 128
            and all(
                character.isalnum() or character in "-_.:"
                for character in value
            )
        )

    @staticmethod
    def _task_id(value: str) -> str | None:
        decoded = unquote(value)
        return decoded if TASK_ID_PATTERN.fullmatch(decoded) else None

    def _json(
        self, handler: BaseHTTPRequestHandler, status: int, value: dict
    ) -> None:
        body = json.dumps(value, separators=(",", ":")).encode()
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(body)))
        handler.send_header("Cache-Control", "no-store")
        handler.end_headers()
        handler.wfile.write(body)

    def _error(
        self,
        handler: BaseHTTPRequestHandler,
        status: int,
        operation: str,
        code: str,
        retry: str = "NEVER",
        request_id: str | None = None,
        audit: dict | None = None,
    ) -> None:
        error = {
            "code": code,
            "message": "Provider operation failed.",
            "operation": operation,
            "retry": retry,
        }
        if request_id is not None:
            error["requestId"] = request_id
        if audit is not None:
            error["audit"] = audit
        self._json(
            handler,
            status,
            {"error": error},
        )


def run() -> None:
    config = BridgeConfig.from_environment()
    registry = SubmissionRegistry(config.registry_path)
    runtime = AiccRuntime(config)
    application = BridgeApplication(config, runtime, registry)
    server = ThreadingHTTPServer(
        (config.host, config.port), application.handler_class()
    )
    server.serve_forever()


if __name__ == "__main__":
    run()
