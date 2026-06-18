import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  discordAccess,
  discordCommandDefinition,
  discordPrompt,
  extractDiscordPrompt,
  verifyDiscordRequest
} from "./discord.mjs";

function rawEd25519PublicKey(keyObject) {
  const der = keyObject.export({ format: "der", type: "spki" });
  return der.subarray(-32).toString("hex");
}

test("verifyDiscordRequest validates Discord Ed25519 signatures", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const body = JSON.stringify({ type: 1 });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(`${timestamp}${body}`), privateKey).toString("hex");
  const req = {
    headers: {
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp
    }
  };
  assert.equal(verifyDiscordRequest(req, body, rawEd25519PublicKey(publicKey)), true);
  assert.equal(verifyDiscordRequest(req, `${body} `, rawEd25519PublicKey(publicKey)), false);
});

test("discordAccess enforces user, role, and channel allowlists", () => {
  const interaction = {
    channel_id: "333333333333333333",
    member: {
      user: { id: "111111111111111111" },
      roles: ["222222222222222222"]
    }
  };
  assert.equal(discordAccess({
    allowedUsers: ["111111111111111111"],
    allowedRoles: ["222222222222222222"],
    freeResponseChannels: ["333333333333333333"]
  }, interaction).allowed, true);
  assert.equal(discordAccess({
    allowedUsers: ["999999999999999999"],
    allowedRoles: [],
    freeResponseChannels: []
  }, interaction).reason, "user_not_allowed");
});

test("extractDiscordPrompt reads slash command option text", () => {
  const request = extractDiscordPrompt({
    application_id: "app_1",
    token: "tok_1",
    channel_id: "333333333333333333",
    guild_id: "444444444444444444",
    member: { user: { id: "111111111111111111", username: "sai" } },
    data: {
      name: "hermes",
      options: [{ name: "prompt", value: "ship it" }]
    }
  });
  assert.equal(request.content, "ship it");
  assert.match(discordPrompt({ request, agent: { handle: "devrel" } }), /Discord context:/);
});

test("discordCommandDefinition emits a slash command with prompt option", () => {
  const command = discordCommandDefinition({ name: "devrel-assistant", description: "Ask DevRel" });
  assert.equal(command.name, "devrel-assistant");
  assert.equal(command.type, 1);
  assert.equal(command.options[0].name, "prompt");
  assert.equal(command.options[0].required, true);
});
