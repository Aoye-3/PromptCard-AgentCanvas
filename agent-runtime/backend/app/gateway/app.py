import asyncio
import logging
import os
import threading
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, suppress
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.gateway.auth_middleware import AuthMiddleware
from app.gateway.config import get_gateway_config
from app.gateway.csrf_middleware import CSRFMiddleware, get_configured_cors_origins
from app.gateway.deps import image_generation_runtime
from app.gateway.provider_file_cleanup import (
    DEFAULT_CLEANUP_BATCH_BUDGET_SECONDS,
    retry_provider_file_cleanup,
)
from app.gateway.routers import image_generation, model_management, promptcard_runtime

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)
for noisy_client_logger in ("httpx", "httpcore", "volcenginesdkarkruntime"):
    logging.getLogger(noisy_client_logger).setLevel(logging.WARNING)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    async with image_generation_runtime(app):
        cleanup_task = asyncio.create_task(_retry_provider_cleanup_after_startup())
        logger.info("PromptCard gateway started")
        try:
            yield
        finally:
            cleanup_task.cancel()
            with suppress(asyncio.CancelledError):
                await cleanup_task
    logger.info("PromptCard gateway stopped")


async def _retry_provider_cleanup_after_startup() -> None:
    try:
        summary = await asyncio.wait_for(
            _run_provider_cleanup_in_daemon_thread(),
            timeout=DEFAULT_CLEANUP_BATCH_BUDGET_SECONDS,
        )
        logger.info(
            "Provider file cleanup retry finished: attempted=%d succeeded=%d retry_scheduled=%d",
            summary.attempted,
            summary.succeeded,
            summary.retry_scheduled,
        )
    except TimeoutError:
        logger.warning(
            "Provider file cleanup retry exceeded its budget: provider_cleanup_budget_exceeded"
        )
    except Exception:
        logger.warning(
            "Provider file cleanup retry was unavailable: provider_cleanup_startup_failed"
        )


async def _run_provider_cleanup_in_daemon_thread() -> Any:
    loop = asyncio.get_running_loop()
    result: asyncio.Future[Any] = loop.create_future()

    def deliver(value: Any = None, error: BaseException | None = None) -> None:
        if result.done():
            return
        if error is not None:
            result.set_exception(error)
        else:
            result.set_result(value)

    def run() -> None:
        try:
            value = retry_provider_file_cleanup()
        except BaseException as exc:
            try:
                loop.call_soon_threadsafe(deliver, None, exc)
            except RuntimeError:
                pass
        else:
            try:
                loop.call_soon_threadsafe(deliver, value, None)
            except RuntimeError:
                pass

    threading.Thread(
        target=run,
        name="provider-file-cleanup",
        daemon=True,
    ).start()
    return await result


def create_app() -> FastAPI:
    config = get_gateway_config()
    app = FastAPI(
        title="PromptCard Runtime Gateway",
        description=(
            "PromptCard-owned local gateway for pi text-agent orchestration, "
            "Volcengine Ark model access, model management, and image generation."
        ),
        version="1.0.0",
        lifespan=lifespan,
        docs_url="/docs" if config.enable_docs else None,
        redoc_url="/redoc" if config.enable_docs else None,
        openapi_url="/openapi.json" if config.enable_docs else None,
    )
    app.add_middleware(AuthMiddleware)
    app.add_middleware(CSRFMiddleware)
    cors_origins = sorted(get_configured_cors_origins())
    if cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    app.include_router(promptcard_runtime.router)
    app.include_router(model_management.router)
    app.include_router(image_generation.router)

    @app.get("/health", tags=["health"])
    async def health_check() -> dict[str, str]:
        return {
            "status": "healthy",
            "service": "promptcard-runtime",
            "runtimeStateDir": os.environ.get(
                "PROMPTCARD_RUNTIME_STATE_DIR",
                "",
            ),
        }

    return app


app = create_app()
