import time
import uuid
from typing import Callable

from fastapi import Request, Response


def gen_request_id() -> str:
    return f"req_{uuid.uuid4().hex[:16]}"


async def request_id_middleware(request: Request, call_next: Callable):
    request_id = request.headers.get("x-request-id") or gen_request_id()
    request.state.request_id = request_id

    start = time.perf_counter()
    response: Response = await call_next(request)
    cost_ms = (time.perf_counter() - start) * 1000

    response.headers["x-request-id"] = request_id
    response.headers["x-cost-ms"] = f"{cost_ms:.1f}"
    return response
