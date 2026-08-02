from __future__ import annotations

import io
import tempfile
import unittest
import zipfile
from contextlib import nullcontext
from datetime import datetime, timezone
from pathlib import Path

import httpx

from provider_bridge.sdk_runtime import (
    AiccRuntime,
    ProviderCreateError,
    ProviderCreateHttpError,
    ProviderCreateNotSentError,
    ProviderCreateResponseMissingIdError,
)


class FakeResponse:
    def __init__(self, status_code, payload, headers=None):
        self.status_code = status_code
        self._payload = payload
        self.headers = headers or {}

    def json(self):
        return self._payload


class FakeSecureClient:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error

    def send(self, _request, *_args, **_kwargs):
        if self.error is not None:
            raise self.error
        return self.response


class FakeVolcClient:
    def __init__(self, secure_client):
        self.secure_http_client = secure_client


class FakeSdkClient:
    def __init__(self, response=None, task_id="provider-task-1", error=None):
        self.volc_client = FakeVolcClient(
            FakeSecureClient(response=response, error=error)
        )
        self.task_id = task_id

    def create_video_generation_task(self, _request):
        self.volc_client.secure_http_client.send(object())
        return self.task_id


class AiccRuntimeCreateDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.runtime = AiccRuntime.__new__(AiccRuntime)
        self.runtime._lock = __import__("threading").Lock()
        self.runtime._silent_sdk = nullcontext

    def tearDown(self):
        self.temporary.cleanup()

    def test_classifies_5xx_as_outcome_unknown_without_retaining_body(self):
        secret_message = "secret provider response text"
        self.runtime._client = FakeSdkClient(
            response=FakeResponse(
                503,
                {
                    "error": {
                        "code": "UpstreamUnavailable",
                        "message": secret_message,
                    }
                },
                {"x-request-id": "request-503"},
            ),
            task_id="",
        )

        with self.assertRaises(ProviderCreateError) as raised:
            self.runtime.create_task({"content": []})

        self.assertEqual(raised.exception.diagnostic.http_status, 503)
        self.assertEqual(
            raised.exception.diagnostic.error_code, "UpstreamUnavailable"
        )
        self.assertEqual(raised.exception.diagnostic.request_id, "request-503")
        self.assertNotIn(secret_message, str(raised.exception))
        self.assertNotIn(secret_message, repr(raised.exception.diagnostic))

    def test_classifies_connect_failure_as_confirmed_not_sent(self):
        request = httpx.Request("POST", "https://provider.invalid/tasks")
        self.runtime._client = FakeSdkClient(
            error=httpx.ConnectError("connect failed", request=request)
        )

        with self.assertRaises(ProviderCreateNotSentError) as raised:
            self.runtime.create_task({"content": []})

        self.assertEqual(raised.exception.diagnostic.failure_stage, "CONNECT")
        self.assertFalse(raised.exception.diagnostic.request_body_sent)

    def test_classifies_read_timeout_as_outcome_unknown_after_body_sent(self):
        request = httpx.Request("POST", "https://provider.invalid/tasks")
        self.runtime._client = FakeSdkClient(
            error=httpx.ReadTimeout("read timeout", request=request)
        )

        with self.assertRaises(ProviderCreateError) as raised:
            self.runtime.create_task({"content": []})

        self.assertNotIsInstance(raised.exception, ProviderCreateNotSentError)
        self.assertEqual(
            raised.exception.diagnostic.failure_stage, "READ_RESPONSE"
        )
        self.assertTrue(raised.exception.diagnostic.request_body_sent)

    def test_classifies_200_without_id_as_protocol_failure(self):
        self.runtime._client = FakeSdkClient(
            response=FakeResponse(200, {"unexpected": True}), task_id=""
        )

        with self.assertRaises(ProviderCreateResponseMissingIdError) as raised:
            self.runtime.create_task({"content": []})

        self.assertEqual(raised.exception.diagnostic.http_status, 200)

    def test_transport_failure_remains_outcome_unknown(self):
        self.runtime._client = FakeSdkClient(error=TimeoutError("timeout"))

        with self.assertRaises(ProviderCreateError) as raised:
            self.runtime.create_task({"content": []})

        self.assertNotIsInstance(raised.exception, ProviderCreateHttpError)
        self.assertIsNone(raised.exception.diagnostic.http_status)

    def test_rejects_unsafe_diagnostic_fields(self):
        diagnostic = self.runtime._create_diagnostic(
            FakeResponse(
                400,
                {"code": "bad code with secret=fixture-key"},
                {"x-request-id": "request id with spaces"},
            )
        )
        self.assertIsNone(diagnostic.error_code)
        self.assertIsNone(diagnostic.request_id)

    def test_utc_audit_timestamp_is_explicit_iso_8601_z(self):
        value = self.runtime._utc_now()
        self.assertTrue(value.endswith("Z"))
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        self.assertEqual(parsed.tzinfo, timezone.utc)


class AuditedSdkVideoHeaderTests(unittest.TestCase):
    def test_video_url_enables_input_has_video_header(self):
        archive_path = Path(__file__).resolve().parents[3] / "pythonSDK-0515.zip"
        with zipfile.ZipFile(archive_path) as outer:
            wheel_bytes = outer.read(
                "pythonSDK-0515/maas_seedance_sdk-1.0.0-py3-none-any.whl"
            )
        with zipfile.ZipFile(io.BytesIO(wheel_bytes)) as wheel:
            source = wheel.read("maas_seedance/client.py").decode()
        self.assertIn('item.get("type") == "video_url"', source)
        self.assertIn('headers["Input-Has-Video"] = "true"', source)


if __name__ == "__main__":
    unittest.main()
