const controllerUrl = String(process.env.HERMES_CONTROLLER_URL || process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const prompt = String(process.env.HERMES_SCHEDULE_PROMPT || "").trim();
const apiKey = process.env.HERMES_SCHEDULE_API_KEY || process.env.TFY_API_KEY || "";
const model = process.env.HERMES_SCHEDULE_MODEL || process.env.HERMES_MODEL || "hermes";
const slackChannel = String(process.env.HERMES_SCHEDULE_SLACK_CHANNEL || "").trim();
const slackBotToken = process.env.SLACK_BOT_TOKEN || "";
const agentMailInboxId = String(process.env.HERMES_SCHEDULE_AGENTMAIL_INBOX_ID || "").trim();
const agentMailTo = String(process.env.HERMES_SCHEDULE_EMAIL_TO || "").trim();
const agentMailApiKey = process.env.AGENTMAIL_API_KEY || "";

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!controllerUrl) fail("HERMES_CONTROLLER_URL or PUBLIC_BASE_URL is required");
if (!prompt) fail("HERMES_SCHEDULE_PROMPT is required");
if (!apiKey) fail("HERMES_SCHEDULE_API_KEY or TFY_API_KEY is required");

try {
  const res = await fetch(`${controllerUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const text = await res.text();
  if (!res.ok) fail(`scheduled prompt failed ${res.status}: ${text.slice(0, 1000)}`);
  const payload = text ? JSON.parse(text) : {};
  const output = payload?.choices?.[0]?.message?.content || payload?.output_text || "";
  const finalOutput = output || JSON.stringify(payload);
  console.log(finalOutput);

  if (slackChannel) {
    if (!slackBotToken) fail("HERMES_SCHEDULE_SLACK_CHANNEL is set but SLACK_BOT_TOKEN is missing");
    const slackRes = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${slackBotToken}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({ channel: slackChannel, text: finalOutput.slice(0, 3500) })
    });
    const slackText = await slackRes.text();
    const slackPayload = slackText ? JSON.parse(slackText) : {};
    if (!slackRes.ok || !slackPayload.ok) fail(`scheduled Slack delivery failed: ${slackPayload.error || slackRes.status}`);
  }

  if (agentMailInboxId || agentMailTo) {
    if (!agentMailInboxId || !agentMailTo || !agentMailApiKey) {
      fail("AgentMail scheduled delivery requires HERMES_SCHEDULE_AGENTMAIL_INBOX_ID, HERMES_SCHEDULE_EMAIL_TO, and AGENTMAIL_API_KEY");
    }
    const mailRes = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(agentMailInboxId)}/messages/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${agentMailApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        to: agentMailTo,
        subject: process.env.HERMES_SCHEDULE_EMAIL_SUBJECT || "Hermes scheduled result",
        text: finalOutput
      })
    });
    const mailText = await mailRes.text();
    if (!mailRes.ok) fail(`scheduled AgentMail delivery failed ${mailRes.status}: ${mailText.slice(0, 500)}`);
  }
} catch (error) {
  fail(error instanceof Error ? error.stack || error.message : String(error));
}
