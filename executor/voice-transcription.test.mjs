import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendAudioTranscriptsToPrompt,
  hermesHomeForTurn,
  safeHermesSessionDirName,
  transcribeAudioAttachments
} from "./run-turn.mjs";

test("hermesHomeForTurn isolates runtime-owned state by Hermes session id", () => {
  const env = {
    HERMES_HOME: "/workspace/.hermes",
    HERMES_STATE_OWNER: "runtime"
  };

  assert.equal(
    hermesHomeForTurn(env, "response/session:abc"),
    "/workspace/.hermes/sessions/response_session_abc"
  );
  assert.equal(safeHermesSessionDirName("../bad/session"), ".._bad_session");
});

test("hermesHomeForTurn preserves worker shared home", () => {
  assert.equal(
    hermesHomeForTurn({ HERMES_HOME: "/workspace/.hermes" }, "session-a"),
    "/workspace/.hermes"
  );
});

test("transcribeAudioAttachments skips audio when STT env is incomplete", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hermes-voice-test-"));
  try {
    const localPath = path.join(dir, "note.wav");
    await writeFile(localPath, Buffer.from("audio"));
    const result = await transcribeAudioAttachments({
      attachments: [{ filename: "note.wav", mime_type: "audio/wav", local_path: localPath }],
      env: {}
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].skipped, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("transcribeAudioAttachments calls the configured gateway transcription endpoint", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hermes-voice-test-"));
  try {
    const localPath = path.join(dir, "note.wav");
    await writeFile(localPath, Buffer.from("audio"));
    const calls = [];
    const result = await transcribeAudioAttachments({
      attachments: [{ filename: "note.wav", mime_type: "audio/wav", local_path: localPath }],
      env: {
        HERMES_STT_BASE_URL: "https://gateway.example/v1",
        HERMES_STT_API_KEY: "key",
        HERMES_STT_MODEL: "whisper"
      },
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ text: "hello from audio" })
        };
      }
    });
    assert.equal(calls[0].url, "https://gateway.example/v1/audio/transcriptions");
    assert.equal(calls[0].init.headers.authorization, "Bearer key");
    assert.equal(result[0].text, "hello from audio");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendAudioTranscriptsToPrompt includes transcripts and skipped entries", () => {
  const prompt = appendAudioTranscriptsToPrompt("Base", [
    { filename: "a.wav", local_path: "/tmp/a.wav", text: "hello" },
    { filename: "b.wav", local_path: "/tmp/b.wav", skipped: true, reason: "missing config" }
  ]);
  assert.match(prompt, /Audio transcripts/);
  assert.match(prompt, /hello/);
  assert.match(prompt, /transcription_skipped/);
});
