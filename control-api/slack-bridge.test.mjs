import { createHmac } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSlackAgentConfig, slackManifest, verifySlackSignature } from "./slack-bridge.mjs";

test("verifies Slack signatures", () => {
  const signingSecret = "test-secret";
  const rawBody = JSON.stringify({ type: "url_verification", challenge: "ok" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;

  assert.equal(verifySlackSignature({
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature
  }, rawBody, signingSecret), true);
  assert.equal(verifySlackSignature({
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": "v0=bad"
  }, rawBody, signingSecret), false);
});

test("normalizes Slack agent config", () => {
  assert.deepEqual(normalizeSlackAgentConfig({
    handles: ["@Hermes", " hermes "],
    channel_ids: ["c123"],
    response_mode: "all-channel"
  }), {
    handles: ["hermes"],
    channelIds: ["C123"],
    responseMode: "all-channel"
  });
});

test("generates Slack event manifest", () => {
  const manifest = slackManifest({ appName: "Hermes Agent" }, "https://control.example.com/");
  assert.equal(manifest.settings.event_subscriptions.request_url, "https://control.example.com/slack/events");
  assert.ok(manifest.settings.event_subscriptions.bot_events.includes("app_mention"));
  assert.ok(manifest.oauth_config.scopes.bot.includes("chat:write"));
});
