import logging
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool

from app.gateway.auth_middleware import AuthMiddleware
from app.gateway.config import get_gateway_config
from app.gateway.csrf_middleware import CSRFMiddleware, get_configured_cors_origins
from app.gateway.deps import image_generation_runtime
from app.gateway.provider_file_cleanup import retry_provider_file_cleanup
from app.gateway.routers import image_generation, model_management, promptcard_runtime

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    async with image_generation_runtime(app):
        try:
            summary = await run_in_threadpool(retry_provider_file_cleanup)
            logger.info(
                "Provider file cleanup retry finished: attempted=%d succeeded=%d retry_scheduled=%d",
                summary.attempted,
                summary.succeeded,
                summary.retry_scheduled,
            )
        except Exception:
            logger.warning(
                "Provider file cleanup retry was unavailable: provider_cleanup_startup_failed"
            )
        logger.info("PromptCard gateway started")
        yield
    logger.info("PromptCard gateway stopped")


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
