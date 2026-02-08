import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "../infra/env.js";

// Resolve enabled/path lazily so that CLI flags (--raw-stream) which set the
// env var AFTER module import are respected.
let _resolved = false;
let _enabled = false;
let _path = "";

function resolve() {
  if (_resolved) return;
  _resolved = true;
  _enabled = isTruthyEnvValue(process.env.OPENCLAW_RAW_STREAM);
  _path =
    process.env.OPENCLAW_RAW_STREAM_PATH?.trim() ||
    path.join(resolveStateDir(), "logs", "raw-stream.jsonl");
}

let rawStreamReady = false;

export function appendRawStream(payload: Record<string, unknown>) {
  resolve();
  if (!_enabled) {
    return;
  }
  if (!rawStreamReady) {
    rawStreamReady = true;
    try {
      fs.mkdirSync(path.dirname(_path), { recursive: true });
    } catch {
      // ignore raw stream mkdir failures
    }
  }
  try {
    void fs.promises.appendFile(_path, `${JSON.stringify(payload)}\n`);
  } catch {
    // ignore raw stream write failures
  }
}
