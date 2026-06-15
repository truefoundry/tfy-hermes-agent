// Per-run HMAC token utility. Per-run, not shared.
// Format: "v1.<runId>.<exp>.<hexSig>" where hexSig = HMAC-SHA256(secret, runId + "|" + exp).

import { createHmac, timingSafeEqual } from 'node:crypto';

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function computeSig(secret, runId, exp) {
  return createHmac('sha256', secret).update(`${runId}|${exp}`).digest('hex');
}

function safeEqualStr(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function signRunToken({ runId, expSeconds = 3600, secret }) {
  if (!runId || !secret) throw new Error('signRunToken: runId and secret required');
  const exp = nowSeconds() + expSeconds;
  const sig = computeSig(secret, runId, exp);
  return `v1.${runId}.${exp}.${sig}`;
}

function parse(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [v, runId, expStr, sig] = parts;
  if (v !== 'v1' || !runId || !expStr || !sig) return null;
  const exp = Number(expStr);
  if (!Number.isInteger(exp) || exp <= 0) return null;
  return { runId, exp, sig };
}

export function verifyRunToken({ token, expectedRunId, secret }) {
  if (!secret || !expectedRunId) return false;
  const parsed = parse(token);
  if (!parsed) return false;
  if (!safeEqualStr(parsed.runId, expectedRunId)) return false;
  if (parsed.exp <= nowSeconds()) return false;
  const expected = computeSig(secret, parsed.runId, parsed.exp);
  if (expected.length !== parsed.sig.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parsed.sig, 'hex'));
}

export function verifyAndExtract({ token, secret }) {
  if (!secret) return { ok: false, reason: 'invalid' };
  const parsed = parse(token);
  if (!parsed) return { ok: false, reason: 'malformed' };
  if (parsed.exp <= nowSeconds()) return { ok: false, reason: 'expired' };
  const expected = computeSig(secret, parsed.runId, parsed.exp);
  if (expected.length !== parsed.sig.length) return { ok: false, reason: 'invalid' };
  const match = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parsed.sig, 'hex'));
  if (!match) return { ok: false, reason: 'invalid' };
  return { ok: true, runId: parsed.runId, exp: parsed.exp };
}
