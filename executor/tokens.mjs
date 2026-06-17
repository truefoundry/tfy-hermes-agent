import { createHmac, timingSafeEqual } from "node:crypto";

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function computeSig(secret, runId, exp) {
  return createHmac("sha256", secret).update(`${runId}|${exp}`).digest("hex");
}

function parse(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [v, runId, expStr, sig] = parts;
  if (v !== "v1" || !runId || !expStr || !sig) return null;
  const exp = Number(expStr);
  if (!Number.isInteger(exp) || exp <= 0) return null;
  return { runId, exp, sig };
}

export function verifyRunToken({ token, expectedRunId, secret }) {
  if (!secret || !expectedRunId) return false;
  const parsed = parse(token);
  if (!parsed) return false;
  if (parsed.runId !== expectedRunId) return false;
  if (parsed.exp <= nowSeconds()) return false;
  const expected = computeSig(secret, parsed.runId, parsed.exp);
  if (expected.length !== parsed.sig.length) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(parsed.sig, "hex"));
}
