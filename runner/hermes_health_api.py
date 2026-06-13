from fastapi import FastAPI
from fastapi.responses import JSONResponse
import os

app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok", "platform": "hermes-agent"}


@app.get("/v1/models")
def models():
    model = os.getenv("HERMES_INFERENCE_MODEL", "openai-main/gpt-5.5")
    return JSONResponse({"object": "list", "data": [{"id": model, "object": "model"}]})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8642")))
