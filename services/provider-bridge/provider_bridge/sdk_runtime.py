from __future__ import annotations

import contextlib
import hashlib
import ipaddress
import logging
import os
import socket
import threading
from datetime import datetime, timezone
from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile
from types import MethodType
from urllib.parse import urljoin, urlparse

import requests
import httpx

from .config import BridgeConfig


class DownloadLimitError(Exception):
    pass


class DownloadTargetError(Exception):
    pass


@dataclass(frozen=True)
class ProviderCreateDiagnostic:
    http_status: int | None = None
    error_code: str | None = None
    request_id: str | None = None
    trace_id: str | None = None
    request_started_at: str | None = None
    request_ended_at: str | None = None
    failure_stage: str | None = None
    exception_type: str | None = None
    request_body_sent: bool | None = None
    stack_fingerprint: str | None = None


class ProviderCreateError(RuntimeError):
    code = "PROVIDER_CREATE_OUTCOME_UNKNOWN"

    def __init__(self, diagnostic: ProviderCreateDiagnostic):
        super().__init__("Provider create failed")
        self.diagnostic = diagnostic


class ProviderCreateHttpError(ProviderCreateError):
    code = "PROVIDER_CREATE_HTTP_ERROR"


class ProviderCreateNotSentError(ProviderCreateError):
    code = "PROVIDER_CREATE_NOT_SENT"


class ProviderCreateResponseMissingIdError(ProviderCreateError):
    code = "PROVIDER_CREATE_RESPONSE_MISSING_ID"


class _LimitedResponse:
    def __init__(self, response: requests.Response, max_bytes: int):
        self._response = response
        self.headers = response.headers
        self._max_bytes = max_bytes

    def iter_content(self, chunk_size: int = 8192):
        total = 0
        for chunk in self._response.iter_content(chunk_size=chunk_size):
            total += len(chunk)
            if total > self._max_bytes:
                self._response.close()
                raise DownloadLimitError("Provider output exceeded size limit")
            yield chunk


class AiccRuntime:
    def __init__(self, config: BridgeConfig):
        self._config = config
        self._lock = threading.Lock()
        self.last_create_diagnostic: ProviderCreateDiagnostic | None = None
        config.public_key_path.parent.mkdir(
            parents=True, exist_ok=True, mode=0o700
        )
        config.private_key_path.parent.mkdir(
            parents=True, exist_ok=True, mode=0o700
        )
        config.temporary_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self._silent_sdk():
            from maas_seedance import MaasSeedanceClient

            self._disable_sdk_file_logging()
            self._client = MaasSeedanceClient(
                maas_base_url=config.base_url,
                maas_api_key=config.api_key,
                maas_model=config.model_id,
                enable_video_encrypt=True,
            )
            self._client.volc_client.timeout = config.request_timeout_seconds
            self._client.set_video_file_encrypt_key(
                public_key_path=str(config.public_key_path),
                private_key_path=str(config.private_key_path),
            )
        if config.private_key_path.exists():
            config.private_key_path.chmod(0o600)

    def create_task(self, request: dict) -> str:
        started_at = self._utc_now()
        self.last_create_diagnostic = None
        diagnostic: ProviderCreateDiagnostic | None = None
        secure_client = self._client.volc_client.secure_http_client
        original_send = secure_client.send

        def capture_send(_secure_client, http_request, *args, **kwargs):
            nonlocal diagnostic
            try:
                response = original_send(http_request, *args, **kwargs)
            except Exception as error:
                diagnostic = self._exception_diagnostic(started_at, error)
                raise
            diagnostic = self._create_diagnostic(response, started_at)
            return response

        with self._lock, self._silent_sdk():
            secure_client.send = MethodType(capture_send, secure_client)
            try:
                task_id = self._client.create_video_generation_task(request)
            except Exception as error:
                self._raise_create_error(diagnostic, error, started_at)
            finally:
                secure_client.send = original_send
        if diagnostic is not None and diagnostic.http_status != 200:
            if diagnostic.http_status is not None and diagnostic.http_status < 500:
                raise ProviderCreateHttpError(diagnostic)
            raise ProviderCreateError(diagnostic)
        if not isinstance(task_id, str) or not task_id.strip():
            if diagnostic is not None and diagnostic.http_status == 200:
                raise ProviderCreateResponseMissingIdError(
                    self._with_failure(
                        diagnostic,
                        failure_stage="PARSE_RESPONSE",
                        exception_type="ProviderTaskIdMissing",
                        request_body_sent=True,
                    )
                )
            raise ProviderCreateError(diagnostic or ProviderCreateDiagnostic())
        self.last_create_diagnostic = diagnostic
        return task_id.strip()

    @staticmethod
    def _raise_create_error(
        diagnostic: ProviderCreateDiagnostic | None,
        error: Exception,
        started_at: str,
    ) -> None:
        if diagnostic is None:
            diagnostic = AiccRuntime._exception_diagnostic(started_at, error)
        if diagnostic.request_body_sent is False:
            raise ProviderCreateNotSentError(diagnostic) from error
        if diagnostic.http_status == 200:
            raise ProviderCreateResponseMissingIdError(
                AiccRuntime._with_failure(
                    diagnostic,
                    failure_stage="PARSE_RESPONSE",
                    exception_type=type(error).__name__,
                    request_body_sent=True,
                )
            ) from error
        if diagnostic.http_status is not None and diagnostic.http_status < 500:
            raise ProviderCreateHttpError(diagnostic) from error
        raise ProviderCreateError(diagnostic) from error

    @classmethod
    def _create_diagnostic(
        cls, response, started_at: str | None = None
    ) -> ProviderCreateDiagnostic:
        status = getattr(response, "status_code", None)
        http_status = status if isinstance(status, int) else None
        headers = getattr(response, "headers", {})
        request_id = None
        for name in ("x-request-id", "request-id", "x-tt-logid"):
            candidate = headers.get(name) if hasattr(headers, "get") else None
            request_id = cls._safe_diagnostic_value(candidate)
            if request_id is not None:
                break

        trace_id = None
        for name in ("trace-id", "x-trace-id", "traceparent"):
            candidate = headers.get(name) if hasattr(headers, "get") else None
            trace_id = cls._safe_diagnostic_value(candidate)
            if trace_id is not None:
                break

        error_code = None
        try:
            payload = response.json()
            if isinstance(payload, dict):
                error = payload.get("error")
                candidate = (
                    error.get("code")
                    if isinstance(error, dict)
                    else payload.get("code")
                )
                error_code = cls._safe_diagnostic_value(candidate)
        except Exception:
            pass
        return ProviderCreateDiagnostic(
            http_status=http_status,
            error_code=error_code,
            request_id=request_id,
            trace_id=trace_id,
            request_started_at=started_at or cls._utc_now(),
            request_ended_at=cls._utc_now(),
            request_body_sent=True,
        )

    @classmethod
    def _exception_diagnostic(
        cls, started_at: str, error: Exception
    ) -> ProviderCreateDiagnostic:
        chain = cls._exception_chain(error)
        root = chain[-1]
        if any(
            isinstance(item, (httpx.ConnectError, httpx.ConnectTimeout))
            for item in chain
        ):
            stage, body_sent = "CONNECT", False
        elif any(
            isinstance(item, (httpx.WriteError, httpx.WriteTimeout))
            for item in chain
        ):
            stage, body_sent = "WRITE_REQUEST", None
        elif any(
            isinstance(
                item,
                (httpx.ReadError, httpx.ReadTimeout, httpx.RemoteProtocolError),
            )
            for item in chain
        ):
            stage, body_sent = "READ_RESPONSE", True
        elif any(isinstance(item, (ValueError, TypeError)) for item in chain):
            stage, body_sent = "PARSE_RESPONSE", True
        else:
            stage, body_sent = "UNKNOWN", None
        frames = []
        traceback = root.__traceback__
        while traceback is not None:
            code = traceback.tb_frame.f_code
            frames.append(
                f"{Path(code.co_filename).name}:{traceback.tb_lineno}:{code.co_name}"
            )
            traceback = traceback.tb_next
        fingerprint = (
            hashlib.sha256("|".join(frames).encode()).hexdigest()
            if frames
            else None
        )
        return ProviderCreateDiagnostic(
            request_started_at=started_at,
            request_ended_at=cls._utc_now(),
            failure_stage=stage,
            exception_type=type(error).__name__[:128],
            request_body_sent=body_sent,
            stack_fingerprint=fingerprint,
        )

    @staticmethod
    def _exception_chain(error: Exception) -> list[Exception]:
        current = error
        chain = [current]
        seen: set[int] = set()
        while id(current) not in seen:
            seen.add(id(current))
            next_error = current.__cause__ or current.__context__
            if not isinstance(next_error, Exception):
                break
            current = next_error
            chain.append(current)
        return chain

    @staticmethod
    def _with_failure(
        diagnostic: ProviderCreateDiagnostic,
        *,
        failure_stage: str,
        exception_type: str,
        request_body_sent: bool | None,
    ) -> ProviderCreateDiagnostic:
        return ProviderCreateDiagnostic(
            http_status=diagnostic.http_status,
            error_code=diagnostic.error_code,
            request_id=diagnostic.request_id,
            trace_id=diagnostic.trace_id,
            request_started_at=diagnostic.request_started_at,
            request_ended_at=diagnostic.request_ended_at,
            failure_stage=failure_stage,
            exception_type=exception_type,
            request_body_sent=request_body_sent,
            stack_fingerprint=diagnostic.stack_fingerprint,
        )

    @staticmethod
    def _utc_now() -> str:
        return (
            datetime.now(timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )

    @staticmethod
    def _safe_diagnostic_value(value: object) -> str | None:
        if not isinstance(value, str) or not 1 <= len(value) <= 128:
            return None
        if not all(
            character.isalnum() or character in "-_.:"
            for character in value
        ):
            return None
        return value

    def query_task(self, provider_task_id: str) -> dict:
        with self._lock, self._silent_sdk():
            result = self._client.query_video_generation_task(
                provider_task_id
            )
        if not isinstance(result, dict):
            raise RuntimeError("Provider query returned an invalid response")
        return result

    def download_output(self, provider_task_id: str) -> Path:
        snapshot = self.query_task(provider_task_id)
        if snapshot.get("status") != "succeeded":
            raise RuntimeError("Provider output is not ready")
        content = snapshot.get("content")
        video_url = content.get("video_url") if isinstance(content, dict) else None
        if not isinstance(video_url, str) or not video_url:
            raise RuntimeError("Provider output URL is missing")
        self._validate_target(video_url)

        with NamedTemporaryFile(
            dir=self._config.temporary_root,
            prefix="output-",
            suffix=".mp4",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
        temporary_path.unlink(missing_ok=True)

        original_get = requests.get

        def safe_get(url: str, **kwargs):
            del kwargs
            return self._download_response(original_get, url)

        try:
            with self._lock, self._silent_sdk():
                requests.get = safe_get
                try:
                    success = (
                        self._client.volc_client.video_file_download_by_url(
                            video_url, str(temporary_path)
                        )
                    )
                finally:
                    requests.get = original_get
            if (
                not success
                or not temporary_path.exists()
                or temporary_path.stat().st_size == 0
            ):
                raise RuntimeError("Provider output download failed")
            return temporary_path
        except Exception:
            temporary_path.unlink(missing_ok=True)
            Path(f"{temporary_path}.tmp").unlink(missing_ok=True)
            raise

    def _download_response(self, request_get, initial_url: str):
        current = initial_url
        for _redirect in range(4):
            self._validate_target(current)
            response = request_get(
                current,
                stream=True,
                timeout=(5, self._config.download_timeout_seconds),
                allow_redirects=False,
            )
            if response.status_code in {301, 302, 303, 307, 308}:
                location = response.headers.get("location")
                response.close()
                if not location:
                    raise DownloadTargetError("Redirect has no target")
                current = urljoin(current, location)
                continue
            response.raise_for_status()
            content_length = response.headers.get("content-length")
            if content_length and int(content_length) > self._config.max_download_bytes:
                response.close()
                raise DownloadLimitError("Provider output exceeded size limit")
            return _LimitedResponse(response, self._config.max_download_bytes)
        raise DownloadTargetError("Provider output redirected too many times")

    def _validate_target(self, value: str) -> None:
        parsed = urlparse(value)
        hostname = (parsed.hostname or "").lower()
        if parsed.scheme != "https" or not hostname:
            raise DownloadTargetError("Provider output target is not HTTPS")
        if not any(
            hostname == allowed.lstrip(".")
            or (allowed.startswith(".") and hostname.endswith(allowed))
            for allowed in self._config.output_host_allowlist
        ):
            raise DownloadTargetError("Provider output host is not allowed")
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(
                hostname, parsed.port or 443, type=socket.SOCK_STREAM
            )
        }
        if not addresses:
            raise DownloadTargetError("Provider output host did not resolve")
        for address in addresses:
            ip = ipaddress.ip_address(address)
            if (
                not ip.is_global
                or ip.is_loopback
                or ip.is_link_local
                or ip.is_private
                or ip.is_reserved
                or ip.is_multicast
                or ip.is_unspecified
            ):
                raise DownloadTargetError(
                    "Provider output resolved to a forbidden address"
                )

    @contextlib.contextmanager
    def _silent_sdk(self):
        previous_disable_level = logging.root.manager.disable
        logging.disable(logging.CRITICAL)
        try:
            with open(os.devnull, "w") as sink:
                with contextlib.redirect_stdout(
                    sink
                ), contextlib.redirect_stderr(sink):
                    yield
        finally:
            logging.disable(previous_disable_level)

    @staticmethod
    def _disable_sdk_file_logging() -> None:
        try:
            from loguru import logger

            logger.remove()
            logger.add = lambda *args, **kwargs: 0
            sdk_log_directory = Path("jsc_log")
            for sdk_log in sdk_log_directory.glob("jsc.log*"):
                sdk_log.unlink(missing_ok=True)
            sdk_log_directory.rmdir()
        except (ImportError, ValueError):
            pass
        except OSError:
            # Logging is already disabled; an empty directory is harmless.
            pass
