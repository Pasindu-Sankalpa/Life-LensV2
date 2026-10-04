"""Serve the LifeLens V2 page and pass reading and explanations to local Qwen.

The coverage math stays in the page. The model only reads words and explains.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
LLM_URL = "http://127.0.0.1:8000/v1/chat/completions"
MODEL = "Qwen/Qwen3.5-9B"

app = FastAPI(title="LifeLens V2")


class CompleteIn(BaseModel):
    prompt: str | None = None
    messages: list[dict] = Field(default_factory=list)
    json: bool = False


def _extract_json(text: str) -> dict | list | None:
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.I)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, flags=re.S)
        if not match:
            return None
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            return None


@app.get("/")
def index() -> FileResponse:
    return FileResponse(DIST / "index.html")


@app.get("/{asset_path:path}")
def asset(asset_path: str) -> FileResponse:
    target = (DIST / asset_path).resolve()
    if not str(target).startswith(str(DIST.resolve())) or not target.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(target)


@app.post("/api/complete")
def complete(body: CompleteIn) -> dict:
    messages = body.messages or [{"role": "user", "content": body.prompt or ""}]
    if body.json:
        messages = [
            {"role": "system", "content": "Reply with one JSON object only. No markdown and no explanation."},
            *messages,
        ]
    try:
        response = httpx.post(
            LLM_URL,
            json={"model": MODEL, "messages": messages, "temperature": 0.2, "max_tokens": 1200},
            timeout=90,
        )
        response.raise_for_status()
        text = response.json()["choices"][0]["message"]["content"].strip()
        text = re.sub(r"<think>[\s\S]*?</think>", "", text).strip()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    payload = {"ok": True, "text": text}
    if body.json:
        payload["json"] = _extract_json(text) or {}
    return payload


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=3020, log_level="info")
