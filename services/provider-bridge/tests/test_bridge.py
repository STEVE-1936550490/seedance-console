from __future__ import annotations

import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from provider_bridge.app import BridgeApplication
from provider_bridge.config import BridgeConfig
from provider_bridge.registry import SubmissionRegistry
from provider_bridge.sdk_runtime import (
    ProviderCreateDiagnostic,
    ProviderCreateHttpError,
    ProviderCreateResponseMissingIdError,
)


class FakeRuntime:
    def __init__(self):
        self.create_calls = 0
        self.create_error = None
        self.last_create_request = None
        self.query_result = {"status": "running"}

    def create_task(self, request):
        self.create_calls += 1
        self.last_create_request = request
        if self.create_error is not None:
            raise self.create_error
        return "provider-task-1"

    def query_task(self, _provider_task_id):
        return self.query_result


class BridgeContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.config = BridgeConfig(
            host="127.0.0.1",
            port=43173,
            provider="seedance",
            provider_mode="aicc",
            real_api_test=True,
            bridge_token="fixture-token",
            base_url="https://provider.invalid/api/v3",
            api_key="fixture-key",
            model_id="fixture-model",
            public_key_path=root / "public.pem",
            private_key_path=root / "private.pem",
            registry_path=root / "registry.sqlite3",
            temporary_root=root / "tmp",
            output_host_allowlist=(".invalid",),
            request_timeout_seconds=10,
            download_timeout_seconds=10,
            max_download_bytes=1024,
        )
        self.runtime = FakeRuntime()
        self.application = BridgeApplication(
            self.config,
            self.runtime,
            SubmissionRegistry(self.config.registry_path),
        )

    def tearDown(self):
        self.temporary.cleanup()

    def test_create_is_registered_and_duplicate_is_not_recreated(self):
        handler = FakeHandler(
            "/v1/video/tasks", self._create_body(), "fixture-token"
        )
        self.application._handle_post(handler)
        duplicate = FakeHandler(
            "/v1/video/tasks", self._create_body(), "fixture-token"
        )
        self.application._handle_post(duplicate)
        self.assertEqual(self.runtime.create_calls, 1)
        self.assertEqual(handler.status, 200)
        self.assertEqual(duplicate.status, 200)

    def test_recover_does_not_create(self):
        create = FakeHandler(
            "/v1/video/tasks", self._create_body(), "fixture-token"
        )
        self.application._handle_post(create)
        recover = FakeHandler(
            "/v1/video/tasks/recover",
            {"clientRequestId": "fixture-request"},
            "fixture-token",
        )
        self.application._handle_post(recover)
        self.assertEqual(self.runtime.create_calls, 1)
        self.assertEqual(json.loads(recover.output)["id"], "provider-task-1")

    def test_create_gate_is_fail_closed_but_recover_remains_available(self):
        disabled = BridgeConfig(
            **{**self.config.__dict__, "real_api_test": False}
        )
        application = BridgeApplication(
            disabled,
            self.runtime,
            SubmissionRegistry(
                Path(self.temporary.name) / "disabled.sqlite3"
            ),
        )
        create = FakeHandler(
            "/v1/video/tasks", self._create_body(), "fixture-token"
        )
        application._handle_post(create)
        recover = FakeHandler(
            "/v1/video/tasks/recover",
            {"clientRequestId": "missing"},
            "fixture-token",
        )
        application._handle_post(recover)
        self.assertEqual(create.status, 403)
        self.assertEqual(recover.status, 200)
        self.assertEqual(self.runtime.create_calls, 0)

    def test_rejects_assets_and_unapproved_demo_parameters(self):
        body = self._create_body()
        body["request"]["content"].append(
            {"type": "image_url", "image_url": {"url": "https://x.invalid"}}
        )
        handler = FakeHandler(
            "/v1/video/tasks", body, "fixture-token"
        )
        self.application._handle_post(handler)
        self.assertEqual(handler.status, 400)
        self.assertEqual(self.runtime.create_calls, 0)

    def test_accepts_one_https_reference_image(self):
        body = self._create_body()
        body["request"]["content"].append(
            {
                "type": "image_url",
                "image_url": {
                    "url": "https://assets.example.com/api/provider-assets/asset-1"
                },
                "role": "reference_image",
            }
        )
        handler = FakeHandler(
            "/v1/video/tasks", body, "fixture-token"
        )
        self.application._handle_post(handler)
        self.assertEqual(handler.status, 200)
        self.assertEqual(self.runtime.create_calls, 1)
        self.assertEqual(
            self.runtime.last_create_request["content"][1]["role"],
            "reference_image",
        )

    def test_accepts_one_https_reference_video(self):
        body = self._create_body()
        body["request"]["content"].append(
            {
                "type": "video_url",
                "video_url": {
                    "url": "https://objects.example.com/reference.mp4"
                },
                "role": "reference_video",
            }
        )
        handler = FakeHandler(
            "/v1/video/tasks", body, "fixture-token"
        )
        self.application._handle_post(handler)
        self.assertEqual(handler.status, 200)
        self.assertEqual(self.runtime.create_calls, 1)
        self.assertEqual(
            self.runtime.last_create_request["content"][1],
            {
                "type": "video_url",
                "video_url": {
                    "url": "https://objects.example.com/reference.mp4"
                },
                "role": "reference_video",
            },
        )

    def test_rejects_non_https_or_multiple_reference_images(self):
        body = self._create_body()
        image = {
            "type": "image_url",
            "image_url": {"url": "http://127.0.0.1/image.png"},
            "role": "reference_image",
        }
        body["request"]["content"].append(image)
        handler = FakeHandler(
            "/v1/video/tasks", body, "fixture-token"
        )
        self.application._handle_post(handler)
        self.assertEqual(handler.status, 400)
        self.assertEqual(self.runtime.create_calls, 0)

        body["request"]["content"][1]["image_url"]["url"] = (
            "https://assets.example.com/image.png"
        )
        body["request"]["content"].append(
            {
                **image,
                "image_url": {
                    "url": "https://assets.example.com/image-2.png"
                },
            }
        )
        second = FakeHandler(
            "/v1/video/tasks", body, "fixture-token"
        )
        self.application._handle_post(second)
        self.assertEqual(second.status, 400)
        self.assertEqual(self.runtime.create_calls, 0)

    def test_requires_internal_bearer_token(self):
        handler = FakeHandler("/health", None, "wrong-token")
        self.application._handle_get(handler)
        self.assertEqual(handler.status, 401)

    def test_records_sanitized_non_200_create_diagnostic(self):
        self.runtime.create_error = ProviderCreateHttpError(
            ProviderCreateDiagnostic(
                http_status=429,
                error_code="QuotaExceeded",
                request_id="provider-request-1",
            )
        )
        handler = FakeHandler(
            "/v1/video/tasks", self._create_body(), "fixture-token"
        )
        self.application._handle_post(handler)

        payload = json.loads(handler.output)
        self.assertEqual(handler.status, 502)
        self.assertEqual(
            payload["error"]["code"], "PROVIDER_CREATE_HTTP_ERROR"
        )
        self.assertEqual(
            payload["error"]["requestId"], "provider-request-1"
        )
        is_new, submission = self.application.registry.begin(
            "fixture-request"
        )
        self.assertFalse(is_new)
        self.assertEqual(submission.status, "NOT_CREATED")
        self.assertEqual(submission.provider_http_status, 429)
        self.assertEqual(submission.provider_error_code, "QuotaExceeded")

    def test_persists_safe_request_audit_for_outcome_unknown(self):
        self.runtime.create_error = ProviderCreateResponseMissingIdError(
            ProviderCreateDiagnostic(
                http_status=200,
                request_id="provider-request-2",
                trace_id="trace-2",
                request_started_at="2026-08-02T13:16:53.000+00:00",
                request_ended_at="2026-08-02T13:18:53.000+00:00",
                failure_stage="PARSE_RESPONSE",
                exception_type="ProviderTaskIdMissing",
                request_body_sent=True,
            )
        )
        body = self._create_body()
        body["createAttemptId"] = "attempt-1"
        body["requestPayloadSha256"] = "a" * 64
        handler = FakeHandler(
            "/v1/video/tasks", body, "fixture-token"
        )
        handler.headers["X-Bridge-Request-Id"] = "bridge-request-1"

        self.application._handle_post(handler)

        payload = json.loads(handler.output)
        self.assertEqual(
            payload["error"]["audit"]["failureStage"], "PARSE_RESPONSE"
        )
        _, submission = self.application.registry.begin("fixture-request")
        self.assertEqual(submission.status, "OUTCOME_UNKNOWN")
        self.assertEqual(submission.create_attempt_id, "attempt-1")
        self.assertEqual(submission.bridge_request_id, "bridge-request-1")
        self.assertEqual(submission.provider_trace_id, "trace-2")
        self.assertTrue(submission.request_body_sent)

    def test_manual_reconciliation_never_calls_provider_create(self):
        self.application.registry.begin("fixture-request")
        handler = FakeHandler(
            "/v1/video/submissions/reconcile",
            {
                "clientRequestId": "fixture-request",
                "outcome": "ACCEPTED",
                "providerTaskId": "provider-task-recovered",
            },
            "fixture-token",
        )

        self.application._handle_post(handler)

        self.assertEqual(handler.status, 200)
        self.assertEqual(self.runtime.create_calls, 0)
        self.assertEqual(
            self.application.registry.recover("fixture-request"),
            "provider-task-recovered",
        )

    def test_distinguishes_200_response_without_task_id(self):
        self.runtime.create_error = ProviderCreateResponseMissingIdError(
            ProviderCreateDiagnostic(
                http_status=200, request_id="provider-request-2"
            )
        )
        handler = FakeHandler(
            "/v1/video/tasks", self._create_body(), "fixture-token"
        )
        self.application._handle_post(handler)

        payload = json.loads(handler.output)
        self.assertEqual(handler.status, 502)
        self.assertEqual(
            payload["error"]["code"],
            "PROVIDER_CREATE_RESPONSE_MISSING_ID",
        )
        self.assertEqual(self.runtime.create_calls, 1)

    def test_upgrades_existing_registry_for_create_diagnostics(self):
        path = Path(self.temporary.name) / "legacy.sqlite3"
        connection = sqlite3.connect(path)
        connection.execute(
            """
            CREATE TABLE submissions (
              client_request_id TEXT PRIMARY KEY,
              status TEXT NOT NULL,
              provider_task_id TEXT,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        connection.execute(
            """
            INSERT INTO submissions(client_request_id, status)
            VALUES ('legacy-request', 'OUTCOME_UNKNOWN')
            """
        )
        connection.commit()
        connection.close()

        registry = SubmissionRegistry(path)
        is_new, submission = registry.begin("legacy-request")

        self.assertFalse(is_new)
        self.assertEqual(submission.status, "OUTCOME_UNKNOWN")
        self.assertIsNone(submission.provider_http_status)

    def test_accept_preserves_audit_when_optional_values_are_omitted(self):
        path = Path(self.temporary.name) / "audit-preservation.sqlite3"
        registry = SubmissionRegistry(path)
        registry.begin(
            "audit-request",
            create_attempt_id="attempt-1",
            request_payload_sha256="a" * 64,
            bridge_request_id="bridge-request-1",
        )
        registry.accept(
            "audit-request",
            "provider-task-1",
            provider_request_id="provider-request-1",
            request_started_at="2026-08-02T14:50:34.783Z",
            request_ended_at="2026-08-02T14:50:47.018Z",
            request_body_sent=True,
        )
        registry.accept("audit-request", "provider-task-1")

        _, submission = registry.begin("audit-request")
        self.assertEqual(submission.provider_request_id, "provider-request-1")
        self.assertEqual(
            submission.request_started_at, "2026-08-02T14:50:34.783Z"
        )
        self.assertEqual(
            submission.request_ended_at, "2026-08-02T14:50:47.018Z"
        )
        self.assertTrue(submission.request_body_sent)

    @staticmethod
    def _create_body():
        return {
            "clientRequestId": "fixture-request",
            "model": "fixture-model",
            "request": {
                "content": [{"type": "text", "text": "fixture"}],
                "generate_audio": False,
                "ratio": "16:9",
                "duration": 11,
                "watermark": False,
            },
        }


class FakeHandler:
    def __init__(self, path, body, token):
        encoded = b"" if body is None else json.dumps(body).encode()
        self.path = path
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Content-Length": str(len(encoded)),
        }
        self.rfile = io.BytesIO(encoded)
        self.wfile = io.BytesIO()
        self.status = None

    def send_response(self, status):
        self.status = status

    def send_header(self, _name, _value):
        return

    def end_headers(self):
        return

    @property
    def output(self):
        return self.wfile.getvalue().decode()


if __name__ == "__main__":
    unittest.main()
