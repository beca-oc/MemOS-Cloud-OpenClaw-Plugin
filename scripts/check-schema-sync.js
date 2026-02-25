#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MANIFESTS = [
  "openclaw.plugin.json",
  "clawdbot.plugin.json",
  "moltbot.plugin.json",
];

function loadSchemaKeys(fileName) {
  const fullPath = path.join(ROOT, fileName);
  const json = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  const props = json?.configSchema?.properties;
  if (!props || typeof props !== "object") {
    throw new Error(`${fileName}: missing configSchema.properties`);
  }
  return Object.keys(props).sort();
}

function diffKeys(a, b) {
  const onlyInA = a.filter((x) => !b.includes(x));
  const onlyInB = b.filter((x) => !a.includes(x));
  return { onlyInA, onlyInB };
}

const keysets = new Map();
for (const manifest of MANIFESTS) {
  keysets.set(manifest, loadSchemaKeys(manifest));
}

const canonicalName = MANIFESTS[0];
const canonicalKeys = keysets.get(canonicalName);

let hasMismatch = false;
for (const manifest of MANIFESTS.slice(1)) {
  const keys = keysets.get(manifest);
  const { onlyInA, onlyInB } = diffKeys(canonicalKeys, keys);
  if (onlyInA.length === 0 && onlyInB.length === 0) {
    continue;
  }
  hasMismatch = true;
  console.error(`Schema mismatch: ${manifest} vs ${canonicalName}`);
  if (onlyInA.length) {
    console.error(`  Missing in ${manifest}: ${onlyInA.join(", ")}`);
  }
  if (onlyInB.length) {
    console.error(`  Extra in ${manifest}: ${onlyInB.join(", ")}`);
  }
}

if (hasMismatch) {
  process.exit(1);
}

console.log(
  `Schema keys are in sync across ${MANIFESTS.length} manifests (${canonicalKeys.length} keys).`,
);
