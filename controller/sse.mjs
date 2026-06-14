// Server-Sent Events plumbing shared by /v1/responses and /v1/chat/completions
// streamers. The keepalive interval is parameterized so the controller's
// HERMES_SSE_KEEPALIVE_MS env knob still drives behavior.

export function writeSse(res, data, event = null) {
  if (res.writableEnded || res.destroyed) return;
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

export function startSse(req, res, keepAliveMs) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  const ctx = { aborted: false, keepAliveTimer: null };
  const onClose = () => {
    ctx.aborted = true;
    if (ctx.keepAliveTimer) clearInterval(ctx.keepAliveTimer);
  };
  req.on("close", onClose);
  res.on("close", onClose);
  if (keepAliveMs > 0) {
    ctx.keepAliveTimer = setInterval(() => {
      if (ctx.aborted || res.writableEnded || res.destroyed) {
        if (ctx.keepAliveTimer) clearInterval(ctx.keepAliveTimer);
        return;
      }
      res.write(": ping\n\n");
    }, keepAliveMs);
    ctx.keepAliveTimer.unref?.();
  }
  return ctx;
}

export function endSse(res, ctx) {
  if (ctx?.keepAliveTimer) clearInterval(ctx.keepAliveTimer);
  if (!res.writableEnded) res.end();
}
