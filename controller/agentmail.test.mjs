import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  agentMailPrompt,
  extractAgentMailMessage,
  normalizeAgentEmail,
  replyAllPath,
  verifyAgentMailWebhook
} from "./agentmail.mjs";

test("normalizeAgentEmail accepts simple valid email addresses", () => {
  assert.equal(normalizeAgentEmail("DevRel@Agent.Email "), "devrel@agent.email");
  assert.equal(normalizeAgentEmail("not-an-email"), "");
});

test("verifyAgentMailWebhook validates Svix-style signatures", () => {
  const secret = `whsec_${Buffer.from("secret-key").toString("base64")}`;
  const body = JSON.stringify({ event_type: "message.received" });
  const id = "msg_123";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", Buffer.from("secret-key"))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  const req = {
    headers: {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`
    }
  };
  assert.equal(verifyAgentMailWebhook(req, body, secret), true);
  assert.equal(verifyAgentMailWebhook(req, `${body} `, secret), false);
});

test("extractAgentMailMessage handles message.received payloads", () => {
  const message = extractAgentMailMessage({
    event_type: "message.received",
    event_id: "evt_1",
    data: {
      message: {
        inbox_id: "inbox_1",
        inbox_email: "devrel@agent.email",
        message_id: "msg_1",
        thread_id: "thr_1",
        from: "Sai <sai@example.com>",
        to: ["devrel@agent.email"],
        subject: "Hello",
        extracted_text: "Can you help?"
      }
    }
  });
  assert.equal(message.eventType, "message.received");
  assert.equal(message.inboxId, "inbox_1");
  assert.equal(message.inboxEmail, "devrel@agent.email");
  assert.equal(message.text, "Can you help?");
});

test("agentMailPrompt and reply path are stable", () => {
  const message = {
    inboxEmail: "devrel@agent.email",
    inboxId: "inbox_1",
    messageId: "msg_1",
    threadId: "thr_1",
    from: "sai@example.com",
    subject: "Subject",
    text: "Body"
  };
  assert.match(agentMailPrompt({ message, agent: { handle: "devrel", name: "DevRel" } }), /Email context:/);
  assert.equal(replyAllPath({ inboxId: "inbox 1", messageId: "msg 1" }), "/inboxes/inbox%201/messages/msg%201/reply-all");
});
