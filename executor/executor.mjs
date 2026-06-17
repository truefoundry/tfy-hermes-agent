import { executeTurn } from "./run-turn.mjs";

const errMsg = (e) => e instanceof Error ? e.message : String(e);

const workB64 = process.env.HARNESS_WORK_B64 || "";
const callbackToken = process.env.HARNESS_CALLBACK_TOKEN || "";

if (!workB64) {
  console.error("HARNESS_WORK_B64 is required");
  process.exit(2);
}

let payload;
try {
  payload = JSON.parse(Buffer.from(workB64, "base64").toString("utf8"));
} catch (error) {
  console.error(`HARNESS_WORK_B64 could not be decoded: ${errMsg(error)}`);
  process.exit(2);
}

if (!callbackToken) {
  console.error("HARNESS_CALLBACK_TOKEN is required");
  process.exit(2);
}

try {
  await executeTurn(payload, callbackToken);
} catch (error) {
  console.error(errMsg(error));
  process.exit(1);
}
