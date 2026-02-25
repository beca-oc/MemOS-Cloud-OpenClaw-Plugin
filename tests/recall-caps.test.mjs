import test from "node:test";
import assert from "node:assert/strict";

import { truncatePromptBlock } from "../index.js";
import { formatPromptBlock, USER_QUERY_MARKER } from "../lib/memos-cloud-api.js";

test("formatPromptBlock applies per-item cap", () => {
  const longMemory = "A".repeat(120);
  const longPreference = "B".repeat(120);

  const block = formatPromptBlock(
    {
      data: {
        memory_detail_list: [{ memory_value: longMemory, create_time: "2026-02-19 12:00" }],
        preference_detail_list: [
          { preference: longPreference, preference_type: "explicit_preference", create_time: "2026-02-19 12:00" },
        ],
      },
    },
    { maxItemChars: 40, wrapTagBlocks: true },
  );

  assert.ok(block.includes(`${"A".repeat(40)}...`));
  assert.ok(block.includes(`${"B".repeat(40)}...`));
});

test("truncatePromptBlock hard-caps and preserves USER_QUERY_MARKER tail", () => {
  const tail = `${USER_QUERY_MARKER}what changed in this session?`;
  const promptBlock = `${"X".repeat(500)}\n${tail}`;

  const out = truncatePromptBlock(promptBlock, 180);
  assert.ok(out.length <= 180);
  assert.ok(out.endsWith(tail));
  assert.ok(out.includes("...[truncated]"));
});

test("truncatePromptBlock hard-caps when marker is missing", () => {
  const promptBlock = "Y".repeat(250);
  const out = truncatePromptBlock(promptBlock, 100);

  assert.equal(out.length, 100);
  assert.equal(out, "Y".repeat(100));
});

test("truncatePromptBlock keeps marker when tail alone exceeds cap", () => {
  const promptBlock = `prefix-${"Z".repeat(80)}${USER_QUERY_MARKER}${"Q".repeat(300)}`;
  const out = truncatePromptBlock(promptBlock, 90);

  assert.ok(out.length <= 90);
  assert.ok(out.startsWith(USER_QUERY_MARKER));
});
