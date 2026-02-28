import {
  addMessage,
  buildConfig,
  extractText,
  formatPromptBlock,
  USER_QUERY_MARKER,
  searchMemory,
} from "./lib/memos-cloud-api.js";

let lastCaptureTime = 0;
const conversationCounters = new Map();
const API_KEY_HELP_URL = "https://memos-dashboard.openmem.net/cn/apikeys/";
const ENV_FILE_SEARCH_HINTS = ["~/.openclaw/.env", "~/.moltbot/.env", "~/.clawdbot/.env"];
const MEMOS_SOURCE = "openclaw";

function warnMissingApiKey(log, context) {
  const heading = "[memos-cloud] Missing MEMOS_API_KEY (Token auth)";
  const header = `${heading}${context ? `; ${context} skipped` : ""}. Configure it with:`;
  log.warn?.(
    [
      header,
      "echo 'export MEMOS_API_KEY=\"mpg-...\"' >> ~/.zshrc",
      "source ~/.zshrc",
      "or",
      "echo 'export MEMOS_API_KEY=\"mpg-...\"' >> ~/.bashrc",
      "source ~/.bashrc",
      "or",
      "[System.Environment]::SetEnvironmentVariable(\"MEMOS_API_KEY\", \"mpg-...\", \"User\")",
      `Get API key: ${API_KEY_HELP_URL}`,
    ].join("\n"),
  );
}

function stripPrependedPrompt(content) {
  if (!content) return content;
  const idx = content.lastIndexOf(USER_QUERY_MARKER);
  if (idx === -1) return content;
  return content.slice(idx + USER_QUERY_MARKER.length).trimStart();
}

const LOW_VALUE_PATTERNS = [
  /conversation info \(untrusted metadata\)/i,
  /^you there\??$/i,
  /\b(tdd[-_ ]?test|ksync-probe|memos-health-probe|health[_ -]?test)\b/i,
  /^on [a-z]+ \d{1,2}, \d{4}, (the assistant|the user)\b/i,
  /\bthe assistant (acknowledged|informed|provided|suggested|introduced|explained|confirmed)\b/i,
];

function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function extractCapturableFact(content, cfg) {
  let text = normalizeWhitespace(content);
  if (!text) return "";

  if (cfg.capturePolicy === "explicit") {
    const prefix = String(cfg.capturePrefix || "MEMORY:");
    if (!text.toUpperCase().startsWith(prefix.toUpperCase())) return "";
    text = normalizeWhitespace(text.slice(prefix.length));
  }

  if (!text) return "";
  if (cfg.enforceQualityGate) {
    if (text.length < cfg.minFactChars) return "";
    if (LOW_VALUE_PATTERNS.some((pattern) => pattern.test(text))) return "";
  }
  return truncate(text, Math.min(cfg.maxMessageChars, cfg.maxFactChars));
}

function getCounterSuffix(sessionKey) {
  if (!sessionKey) return "";
  const current = conversationCounters.get(sessionKey) ?? 0;
  return current > 0 ? `#${current}` : "";
}

function bumpConversationCounter(sessionKey) {
  if (!sessionKey) return;
  const current = conversationCounters.get(sessionKey) ?? 0;
  conversationCounters.set(sessionKey, current + 1);
}

function resolveConversationId(cfg, ctx) {
  if (cfg.conversationId) return cfg.conversationId;
  // TODO: consider binding conversation_id directly to OpenClaw sessionId (prefer ctx.sessionId).
  const base = ctx?.sessionKey || ctx?.sessionId || (ctx?.agentId ? `openclaw:${ctx.agentId}` : "");
  const dynamicSuffix = cfg.conversationSuffixMode === "counter" ? getCounterSuffix(ctx?.sessionKey) : "";
  const prefix = cfg.conversationIdPrefix || "";
  const suffix = cfg.conversationIdSuffix || "";
  if (base) return `${prefix}${base}${dynamicSuffix}${suffix}`;
  return `${prefix}openclaw-${Date.now()}${dynamicSuffix}${suffix}`;
}

function buildSearchPayload(cfg, prompt, ctx) {
  const queryRaw = `${cfg.queryPrefix || ""}${prompt}`;
  const query =
    Number.isFinite(cfg.maxQueryChars) && cfg.maxQueryChars > 0
      ? queryRaw.slice(0, cfg.maxQueryChars)
      : queryRaw;

  const payload = {
    user_id: cfg.userId,
    query,
    source: MEMOS_SOURCE,
  };

  // Local mode needs explicit cube targeting; use configured list or fall back to userId
  if (cfg.localMode) {
    payload.readable_cube_ids = cfg.readableCubeIds?.length ? cfg.readableCubeIds : [cfg.userId];
  }

  if (!cfg.recallGlobal) {
    const conversationId = resolveConversationId(cfg, ctx);
    if (conversationId) payload.conversation_id = conversationId;
  }

  if (cfg.filter) payload.filter = cfg.filter;
  if (cfg.knowledgebaseIds?.length) payload.knowledgebase_ids = cfg.knowledgebaseIds;

  payload.memory_limit_number = cfg.memoryLimitNumber;
  payload.include_preference = cfg.includePreference;
  payload.preference_limit_number = cfg.preferenceLimitNumber;
  payload.include_tool_memory = cfg.includeToolMemory;
  payload.tool_memory_limit_number = cfg.toolMemoryLimitNumber;

  return payload;
}

function resolveWritableCubes(cfg, ctx) {
  // Agent identity routing: map session/agent identity to the correct cube
  // Convention: if sessionKey or agentId contains an agent name, route to that cube
  const cubeRouting = cfg.cubeRouting ?? {};
  const sessionKey = ctx?.sessionKey ?? "";
  const agentId = ctx?.agentId ?? "";
  const label = ctx?.label ?? "";

  // Check explicit routing map first (config-driven)
  // e.g., cubeRouting: { "tycho": "tycho", "socrates": "socrates", ... }
  for (const [pattern, cubeId] of Object.entries(cubeRouting)) {
    if (sessionKey.includes(pattern) || agentId.includes(pattern) || label.includes(pattern)) {
      return [cubeId];
    }
  }

  // Convention-based routing: check if session/agent matches a known agent name
  // NOTE: beca must be listed first — it's the orchestrator and falls through without it
  const knownAgents = ["beca", "tycho", "socrates", "watts", "erdos", "diogenes"];
  const searchStr = `${sessionKey}:${agentId}:${label}`.toLowerCase();
  for (const agent of knownAgents) {
    if (searchStr.includes(agent)) {
      return [agent];
    }
  }

  // Default: use agentCubeIds only — never fall through to voc-* cubes
  // agentCubeIds is the safe fallback; vocCubeIds are only written via explicit stakeholder_memory.py calls
  const agentCubes = cfg.agentCubeIds?.length ? cfg.agentCubeIds : cfg.writableCubeIds?.filter(id => !id.startsWith("voc-"));
  return agentCubes?.length ? agentCubes : [cfg.userId];
}

function buildAddMessagePayload(cfg, messages, ctx) {
  const payload = {
    user_id: cfg.userId,
    conversation_id: resolveConversationId(cfg, ctx),
    messages,
    source: MEMOS_SOURCE,
  };

  // Local mode needs explicit cube targeting; route based on agent identity
  if (cfg.localMode) {
    payload.writable_cube_ids = resolveWritableCubes(cfg, ctx);
  }

  if (cfg.agentId) payload.agent_id = cfg.agentId;
  if (cfg.appId) payload.app_id = cfg.appId;
  if (cfg.tags?.length) payload.tags = cfg.tags;

  if (cfg.includeInfo === true) {
    const info = {
      source: "openclaw",
      sessionKey: ctx?.sessionKey,
      agentId: ctx?.agentId,
      ...(cfg.info || {}),
    };
    if (Object.keys(info).length > 0) payload.info = info;
  }

  payload.allow_public = cfg.allowPublic;
  if (cfg.allowKnowledgebaseIds?.length) payload.allow_knowledgebase_ids = cfg.allowKnowledgebaseIds;
  // MemOS API expects "sync" or "async" (string), OpenClaw config uses boolean
  payload.async_mode = cfg.asyncMode === false ? "sync" : cfg.asyncMode === true ? "async" : (cfg.asyncMode || "async");

  return payload;
}

function pickLastTurnMessages(messages, cfg) {
  const lastUserIndex = messages
    .map((m, idx) => ({ m, idx }))
    .filter(({ m }) => m?.role === "user")
    .map(({ idx }) => idx)
    .pop();

  if (lastUserIndex === undefined) return [];

  const slice = messages.slice(lastUserIndex);
  const results = [];

  for (const msg of slice) {
    if (!msg || !msg.role) continue;
    if (msg.role === "user") {
      const content = stripPrependedPrompt(extractText(msg.content));
      const fact = extractCapturableFact(content, cfg);
      if (fact) results.push({ role: "user", content: fact });
      continue;
    }
    if (msg.role === "assistant" && cfg.includeAssistant && cfg.capturePolicy === "legacy") {
      const content = extractText(msg.content);
      if (content) results.push({ role: "assistant", content: truncate(content, cfg.maxMessageChars) });
    }
  }

  return results;
}

function pickFullSessionMessages(messages, cfg) {
  const results = [];
  for (const msg of messages) {
    if (!msg || !msg.role) continue;
    if (msg.role === "user") {
      const content = stripPrependedPrompt(extractText(msg.content));
      const fact = extractCapturableFact(content, cfg);
      if (fact) results.push({ role: "user", content: fact });
    }
    if (msg.role === "assistant" && cfg.includeAssistant && cfg.capturePolicy === "legacy") {
      const content = extractText(msg.content);
      if (content) results.push({ role: "assistant", content: truncate(content, cfg.maxMessageChars) });
    }
  }
  return results;
}

function truncate(text, maxLen) {
  if (!text) return "";
  if (!maxLen) return text;
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function hardCap(text, maxChars) {
  if (!text) return "";
  if (!Number.isFinite(maxChars) || maxChars <= 0) return text;
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

export function truncatePromptBlock(promptBlock, maxChars) {
  if (!promptBlock) return "";
  if (!Number.isFinite(maxChars) || maxChars <= 0 || promptBlock.length <= maxChars) return promptBlock;

  const marker = USER_QUERY_MARKER;
  const idx = promptBlock.lastIndexOf(marker);
  if (idx === -1) return hardCap(promptBlock, maxChars);

  const head = promptBlock.slice(0, idx);
  const tail = promptBlock.slice(idx);
  if (tail.length >= maxChars) return hardCap(tail, maxChars);

  const availableForHead = maxChars - tail.length;
  if (head.length <= availableForHead) return `${head}${tail}`;

  const notice = "\n...[truncated]\n";
  if (notice.length >= availableForHead) return `${head.slice(0, availableForHead)}${tail}`;

  const headBudget = availableForHead - notice.length;
  return `${head.slice(0, headBudget)}${notice}${tail}`;
}

export default {
  id: "memos-cloud-openclaw-plugin",
  name: "MemOS Cloud OpenClaw Plugin",
  description: "MemOS Cloud recall + add memory via lifecycle hooks",
  kind: "lifecycle",

  register(api) {
    const cfg = buildConfig(api.pluginConfig);
    const log = api.logger ?? console;

    if (!cfg.envFileStatus?.found) {
      const searchPaths = cfg.envFileStatus?.searchPaths?.join(", ") ?? ENV_FILE_SEARCH_HINTS.join(", ");
      log.warn?.(`[memos-cloud] No .env found in ${searchPaths}; falling back to process env or plugin config.`);
    }

    if (cfg.conversationSuffixMode === "counter" && cfg.resetOnNew) {
      if (api.config?.hooks?.internal?.enabled !== true) {
        log.warn?.("[memos-cloud] command:new hook requires hooks.internal.enabled = true");
      }
      api.registerHook(
        ["command:new"],
        (event) => {
          if (event?.type === "command" && event?.action === "new") {
            bumpConversationCounter(event.sessionKey);
          }
        },
        {
          name: "memos-cloud-conversation-new",
          description: "Increment MemOS conversation suffix on /new",
        },
      );
    }

    // Recall dedup: skip if same prompt was just recalled within 5 seconds
    let lastRecallPrompt = "";
    let lastRecallTime = 0;
    const RECALL_DEDUP_MS = 5000;

    api.on("before_agent_start", async (event, ctx) => {
      if (!cfg.recallEnabled) return;
      if (!event?.prompt || event.prompt.length < 3) return;
      if (!cfg.apiKey && !cfg.localMode) {
        warnMissingApiKey(log, "recall");
        return;
      }

      // Dedup: skip if identical prompt was recalled recently
      const now = Date.now();
      const promptKey = event.prompt.slice(0, 200);
      if (promptKey === lastRecallPrompt && now - lastRecallTime < RECALL_DEDUP_MS) {
        log.info?.("[memos-cloud] recall skipped (dedup: same prompt within 5s)");
        return;
      }
      lastRecallPrompt = promptKey;
      lastRecallTime = now;

      try {
        const payload = buildSearchPayload(cfg, event.prompt, ctx);
        const result = await searchMemory(cfg, payload);
        const promptBlock = formatPromptBlock(result, {
          wrapTagBlocks: true,
          maxItemChars: cfg.maxRecallItemChars,
        });
        if (!promptBlock) return;

        const boundedPromptBlock = truncatePromptBlock(promptBlock, cfg.maxPromptChars);
        if (!boundedPromptBlock) return;

        return {
          prependContext: boundedPromptBlock,
        };
      } catch (err) {
        log.warn?.(`[memos-cloud] recall failed: ${String(err)}`);
      }
    });

    api.on("agent_end", async (event, ctx) => {
      if (!cfg.addEnabled) return;
      if (cfg.capturePolicy === "disabled") return;
      if (!event?.success || !event?.messages?.length) return;
      if (!cfg.apiKey && !cfg.localMode) {
        warnMissingApiKey(log, "add");
        return;
      }

      const now = Date.now();
      if (cfg.throttleMs && now - lastCaptureTime < cfg.throttleMs) {
        return;
      }
      lastCaptureTime = now;

      try {
        const messages =
          cfg.captureStrategy === "full_session"
            ? pickFullSessionMessages(event.messages, cfg)
            : pickLastTurnMessages(event.messages, cfg);

        if (!messages.length) return;

        const payload = buildAddMessagePayload(cfg, messages, ctx);
        // Sync writes take ~30s (MemReader). Async with Redis: ~300ms. Adjust timeout accordingly.
        const addCfg = payload.async_mode === "sync"
          ? { ...cfg, timeoutMs: Math.max(cfg.timeoutMs, 60000) }
          : { ...cfg, timeoutMs: Math.max(cfg.timeoutMs, 5000) };
        await addMessage(addCfg, payload);
      } catch (err) {
        log.warn?.(`[memos-cloud] add failed: ${String(err)}`);
      }
    });
  },
};
