import express from "express";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
} from "discord.js";
import { readFile, stat } from "fs/promises";
import path from "path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  token: process.env.DISCORD_BRIDGE_TOKEN,
  host: "127.0.0.1",
  port: parseInt(process.env.DISCORD_BRIDGE_PORT || "13456", 10),
  defaultTimeout: 5 * 60 * 1000,
  maxTimeout: 30 * 60 * 1000,
  maxFileSize: 8 * 1024 * 1024,
  maxMessageHistory: 100,
  sseKeepAliveInterval: 30 * 1000,
};

const MAX_SSE = 3;

// Per-channel allowed user IDs (registered via POST /register-channel)
const channelAllowedUsers = new Map();
// Channel name <-> ID mapping (from .discord-bridge.json)
const channelNameMap = new Map();

function isAllowedUser(authorId, channelId) {
  const allowed = channelAllowedUsers.get(channelId);
  if (!allowed || allowed.length === 0) return false;
  return allowed.includes(authorId);
}

function resolveChannelByName(nameOrId) {
  if (!nameOrId) return null;
  return channelNameMap.get(nameOrId) || nameOrId;
}

function validateConfig() {
  if (!CONFIG.token) {
    throw new Error("Missing required environment variable: DISCORD_BRIDGE_TOKEN");
  }
}

// ---------------------------------------------------------------------------
// Discord Bot
// ---------------------------------------------------------------------------

let discordClient = null;

const channelCache = new Map();
const messageQueues = new Map();
const pendingQuestions = new Map();
const sseSubscribers = new Map();

function getMessageQueue(channelId) {
  if (!messageQueues.has(channelId)) {
    messageQueues.set(channelId, []);
  }
  return messageQueues.get(channelId);
}

function getSseSubscribers(channelId) {
  if (!sseSubscribers.has(channelId)) {
    sseSubscribers.set(channelId, new Set());
  }
  return sseSubscribers.get(channelId);
}

function broadcastSseEvent(channelId, event, data) {
  const subscribers = sseSubscribers.get(channelId);
  if (!subscribers || subscribers.size === 0) return false;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of subscribers) {
    res.write(payload);
  }
  return true;
}

async function fetchChannel(channelId) {
  if (channelCache.has(channelId)) {
    return channelCache.get(channelId);
  }
  const ch = await discordClient.channels.fetch(channelId);
  if (!ch || !ch.isTextBased()) {
    throw new Error(`Channel ${channelId} not found or is not a text channel`);
  }
  channelCache.set(channelId, ch);
  return ch;
}

async function initDiscord() {
  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  discordClient.on("messageCreate", (message) => {
    if (message.author.bot) return;

    const chId = message.channel.id;

    const isRegistered = channelAllowedUsers.has(chId);
    const hasSubscribers = sseSubscribers.has(chId) && sseSubscribers.get(chId).size > 0;
    const hasPending = pendingQuestions.has(chId);
    if (!isRegistered && !hasSubscribers && !hasPending) return;

    if (!isAllowedUser(message.author.id, chId)) return;

    const parsed = {
      content: message.content,
      attachments: message.attachments.map((a) => ({
        name: a.name,
        url: a.url,
        size: a.size,
        contentType: a.contentType,
      })),
      timestamp: message.createdAt.toISOString(),
      id: message.id,
      author: message.author.bot ? 'bot' : (message.author.username || 'user'),
    };

    const pending = pendingQuestions.get(chId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingQuestions.delete(chId);
      pending.resolve(parsed);
    } else {
      const queue = getMessageQueue(chId);
      queue.push(parsed);
      if (queue.length > CONFIG.maxMessageHistory) {
        queue.shift();
      }
      broadcastSseEvent(chId, "notify", {});
      sendDebugMessage(message.channel, `\u53d7\u4fe1: \u30ad\u30e5\u30fc${queue.length}`);
    }
  });

  await discordClient.login(CONFIG.token);

  await new Promise((resolve, reject) => {
    if (discordClient.isReady()) {
      resolve();
      return;
    }
    discordClient.once("clientReady", resolve);
    discordClient.once("error", reject);
  });

  console.log(`[discord-bridge] Bot connected as ${discordClient.user.tag}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEmbed({ title, description, color = 0x7c3aed, fields = [] }) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color);
  for (const field of fields) {
    embed.addFields(field);
  }
  return embed;
}

async function sendDebugMessage(channel, message) {
  const embed = new EmbedBuilder()
    .setDescription(`\ud83d\udce1 ${message}`)
    .setColor(0x95a5a6);
  return channel.send({ embeds: [embed] }).catch(() => {});
}

async function sendMessage(channelId, content, embeds = [], files = [], replyToId = null) {
  const ch = await fetchChannel(channelId);
  const opts = { content, embeds, files };
  if (replyToId) {
    opts.reply = { messageReference: replyToId, failIfNotExists: false };
  }
  return ch.send(opts);
}

function waitForReply(channelId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingQuestions.delete(channelId);
      reject(new Error(`No reply received within ${timeoutMs / 1000} seconds`));
    }, timeoutMs);
    pendingQuestions.set(channelId, { resolve, reject, timeoutId });
  });
}

function resolveChannelId(req) {
  const raw = req.body?.channelId || req.query?.channelId || null;
  return resolveChannelByName(raw);
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// ---- GET /health ----
app.get("/health", (_req, res) => {
  const botReady = discordClient?.isReady() ?? false;
  const channelId = resolveChannelByName(_req.query.channelId);
  const response = {
    status: botReady ? "ok" : "disconnected",
    bot: discordClient?.user?.tag ?? null,
  };
  if (channelId) {
    response.channel = channelId;
    response.queuedMessages = getMessageQueue(channelId).length;
    response.sseSubscribers = getSseSubscribers(channelId).size;
    response.allowedUserIds = channelAllowedUsers.get(channelId) ?? [];
  }
  res.json(response);
});

// ---- GET /channels ----
app.get("/channels", (_req, res) => {
  const channels = [];
  for (const [name, id] of channelNameMap.entries()) {
    channels.push({
      name,
      id,
      registered: channelAllowedUsers.has(id),
      queuedMessages: getMessageQueue(id).length,
      sseSubscribers: getSseSubscribers(id).size,
    });
  }
  res.json({ status: "ok", channels });
});

// ---- POST /register-channel ----
app.post("/register-channel", (req, res) => {
  const { channelId, allowedUserIds } = req.body;
  if (!channelId) {
    return res.status(400).json({ status: "error", error: "channelId is required" });
  }
  if (!Array.isArray(allowedUserIds)) {
    return res.status(400).json({ status: "error", error: "allowedUserIds must be an array" });
  }
  const ids = allowedUserIds.filter((id) => typeof id === "string");
  channelAllowedUsers.set(channelId, ids);
  res.json({ status: "ok", channelId, allowedUserIds: ids });
});

// ---- GET /events (SSE) ----
app.get("/events", (req, res) => {
  const channelId = resolveChannelId(req);
  if (!channelId) {
    return res.status(400).json({ status: "error", error: "channelId is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  res.write(`event: connected\ndata: ${JSON.stringify({ channelId })}\n\n`);

  fetchChannel(channelId).then((ch) => {
    sendDebugMessage(ch, "\u5f85\u6a5f\u4e2d");
  }).catch(() => {});

  const queue = getMessageQueue(channelId);
  if (queue.length > 0) {
    res.write(`event: notify\ndata: {}\n\n`);
  }

  const subscribers = getSseSubscribers(channelId);
  if (subscribers.size >= MAX_SSE) {
    const oldest = subscribers.values().next().value;
    oldest.end();
    subscribers.delete(oldest);
  }
  subscribers.add(res);

  const pingInterval = setInterval(() => {
    res.write(`event: ping\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
  }, CONFIG.sseKeepAliveInterval);

  req.on("close", () => {
    clearInterval(pingInterval);
    subscribers.delete(res);
    if (subscribers.size === 0) {
      sseSubscribers.delete(channelId);
    }
  });
});

// ---- POST /ask ----
app.post("/ask", async (req, res) => {
  const { question, context, timeout_seconds = 300, options } = req.body;
  const channelId = resolveChannelId(req);
  if (!channelId) {
    return res.status(400).json({ status: "error", error: "channelId is required" });
  }
  if (!question) {
    return res.status(400).json({ status: "error", error: "question is required" });
  }

  const timeoutMs = Math.min(timeout_seconds * 1000, CONFIG.maxTimeout);
  const fields = [];

  if (context) {
    fields.push({ name: "Context", value: context.slice(0, 1024) });
  }
  if (options && options.length > 0) {
    fields.push({
      name: "Suggested Replies",
      value: options.map((opt, i) => `**${i + 1}.** ${opt}`).join("\n"),
    });
  }
  fields.push({ name: "Timeout", value: `${timeout_seconds}s`, inline: true });

  const embed = createEmbed({
    title: "\u2753 Question",
    description: question,
    color: 0xe84393,
    fields,
  });

  const mentionUser = channelAllowedUsers.get(channelId)?.[0];
  await sendMessage(channelId, mentionUser ? `<@${mentionUser}>` : null, [embed]);

  try {
    const reply = await waitForReply(channelId, timeoutMs);
    res.json({
      status: "replied",
      reply: reply.content,
      attachments: reply.attachments,
      timestamp: reply.timestamp,
    });
  } catch (err) {
    res.status(408).json({ status: "timeout", error: err.message });
  }
});

// ---- POST /notify ----
app.post("/notify", async (req, res) => {
  const { message, level = "info", title } = req.body;
  const channelId = resolveChannelId(req);
  if (!channelId) {
    return res.status(400).json({ status: "error", error: "channelId is required" });
  }
  if (!message) {
    return res.status(400).json({ status: "error", error: "message is required" });
  }

  const colorMap = {
    info: 0x3498db, success: 0x2ecc71, warning: 0xf39c12,
    error: 0xe74c3c, debug: 0x95a5a6,
  };
  const iconMap = {
    info: "\u2139\ufe0f", success: "\u2705", warning: "\u26a0\ufe0f",
    error: "\u274c", debug: "\ud83d\udce1",
  };

  if (level === "info") {
    await sendMessage(channelId, message);
  } else if (level === "debug") {
    const ch = await fetchChannel(channelId);
    await sendDebugMessage(ch, message);
  } else {
    const defaultTitle = `${iconMap[level]} ${level.charAt(0).toUpperCase() + level.slice(1)}`;
    const embed = createEmbed({
      title: title || defaultTitle,
      description: message,
      color: colorMap[level] ?? colorMap.info,
    });
    await sendMessage(channelId, null, [embed]);
  }
  res.json({ status: "sent", level });
});

// ---- POST /delegate ----
app.post("/delegate", async (req, res) => {
  const { task, timeout_seconds = 600, notifySource = false } = req.body;
  const sourceChannelId = resolveChannelByName(req.body.sourceChannelId);
  const targetChannelId = resolveChannelByName(req.body.targetChannelId);

  if (!targetChannelId) {
    return res.status(400).json({ status: "error", error: "targetChannelId is required" });
  }
  if (!task) {
    return res.status(400).json({ status: "error", error: "task is required" });
  }

  const timeoutMs = Math.min(timeout_seconds * 1000, CONFIG.maxTimeout);

  const fields = [];
  if (sourceChannelId) {
    let sourceName = sourceChannelId;
    for (const [name, id] of channelNameMap.entries()) {
      if (id === sourceChannelId) { sourceName = name; break; }
    }
    fields.push({ name: "From", value: sourceName, inline: true });
  }
  fields.push({ name: "Timeout", value: `${timeout_seconds}s`, inline: true });

  const embed = createEmbed({
    title: "\ud83d\udccb Delegated Task",
    description: task.length > 4000 ? task.slice(0, 4000) + "..." : task,
    color: 0xff9800,
    fields,
  });

  await sendMessage(targetChannelId, null, [embed]);

  // Also enqueue the task so polling workers can pick it up
  const delegateQueue = getMessageQueue(targetChannelId);
  delegateQueue.push({
    content: task,
    attachments: [],
    timestamp: new Date().toISOString(),
    id: `delegate-${Date.now()}`,
  });
  broadcastSseEvent(targetChannelId, "notify", {});

  try {
    const reply = await waitForReply(targetChannelId, timeoutMs);

    if (notifySource && sourceChannelId) {
      const resultEmbed = createEmbed({
        title: "\ud83d\udcec Delegation Result",
        description: reply.content.length > 4000
          ? reply.content.slice(0, 4000) + "..."
          : reply.content,
        color: 0x2ecc71,
      });
      await sendMessage(sourceChannelId, null, [resultEmbed]);
    }

    res.json({
      status: "completed",
      reply: reply.content,
      attachments: reply.attachments,
      timestamp: reply.timestamp,
    });
  } catch (err) {
    if (notifySource && sourceChannelId) {
      const timeoutEmbed = createEmbed({
        title: "\u23f0 Delegation Timeout",
        description: `\u30bf\u30b9\u30af\u304c\u30bf\u30a4\u30e0\u30a2\u30a6\u30c8\u3057\u307e\u3057\u305f (${timeout_seconds}s)`,
        color: 0xe74c3c,
      });
      await sendMessage(sourceChannelId, null, [timeoutEmbed]).catch(() => {});
    }
    res.status(408).json({ status: "timeout", error: err.message });
  }
});

// ---- POST /send-file ----
app.post("/send-file", async (req, res) => {
  const { file_path, message } = req.body;
  const channelId = resolveChannelId(req);
  if (!channelId) {
    return res.status(400).json({ status: "error", error: "channelId is required" });
  }
  if (!file_path) {
    return res.status(400).json({ status: "error", error: "file_path is required" });
  }

  try {
    const stats = await stat(file_path);
    if (stats.size > CONFIG.maxFileSize) {
      return res.status(413).json({
        status: "error",
        error: `File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds 8MB limit`,
      });
    }
  } catch {
    return res.status(404).json({ status: "error", error: `File not found: ${file_path}` });
  }

  const fileBuffer = await readFile(file_path);
  const fileName = path.basename(file_path);
  const attachment = new AttachmentBuilder(fileBuffer, { name: fileName });
  const embed = createEmbed({
    title: "\ud83d\udcce File",
    description: message || `\`${fileName}\``,
    color: 0x9b59b6,
  });

  await sendMessage(channelId, null, [embed], [attachment]);
  res.json({ status: "sent", fileName });
});

// ---- GET /messages ----
app.get("/messages", async (req, res) => {
  const channelId = resolveChannelId(req);
  if (!channelId) {
    return res.status(400).json({ status: "error", error: "channelId is required" });
  }

  const count = Math.min(
    parseInt(req.query.count || "10", 10),
    CONFIG.maxMessageHistory
  );
  const includeHistory = req.query.include_history === "true";
  const messages = [];

  const queue = getMessageQueue(channelId);
  const queued = queue.splice(0, count);
  messages.push(...queued.map((m) => ({ ...m, source: "queued" })));

  if (queued.length > 0) {
    try {
      const ch = await fetchChannel(channelId);
      for (const msg of queued) {
        const text = msg.content.replace(/\n/g, " ");
        const preview = text.length > 5 ? text.slice(0, 5) + "......" : text;
        sendDebugMessage(ch, `\u4f1d\u9054: ${preview}`);
      }
    } catch { /* ignore */ }
  }

  if (includeHistory && messages.length < count) {
    const remaining = Math.min(count - messages.length, 100);
    const ch = await fetchChannel(channelId);
    const fetched = await ch.messages.fetch({ limit: remaining });
    const history = fetched
      .filter((m) => m.author.bot || isAllowedUser(m.author.id, channelId))
      .map((m) => ({
        content: m.content || (m.embeds && m.embeds.length > 0 ? m.embeds.map(e => e.description || e.title || "").filter(Boolean).join(" ") : ""),
        timestamp: m.createdAt.toISOString(),
        id: m.id,
        source: "history",
      }));
    messages.push(...history);
  }

  res.json({ status: "ok", count: messages.length, messages });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function loadDefaultChannel() {
  const configPath = path.resolve(
    process.env.HOME || process.env.USERPROFILE || ".",
    ".discord-bridge.json"
  );
  try {
    const raw = await readFile(configPath, "utf-8");
    const cfg = JSON.parse(raw);

    if (cfg.channelId && Array.isArray(cfg.allowedUserIds)) {
      channelAllowedUsers.set(cfg.channelId, cfg.allowedUserIds);
      console.log(`[discord-bridge] Auto-registered default channel ${cfg.channelId}`);
    }

    if (cfg.channels && typeof cfg.channels === "object") {
      const allowedIds = cfg.allowedUserIds || [];
      for (const [name, id] of Object.entries(cfg.channels)) {
        channelNameMap.set(name, id);
        if (!channelAllowedUsers.has(id)) {
          channelAllowedUsers.set(id, allowedIds);
        }
      }
      console.log(`[discord-bridge] Registered ${channelNameMap.size} channels from config`);
    }
  } catch {
    // skip
  }
}

async function main() {
  validateConfig();
  await initDiscord();
  await loadDefaultChannel();

  app.listen(CONFIG.port, CONFIG.host, () => {
    console.log(
      `[discord-bridge] HTTP server listening on http://${CONFIG.host}:${CONFIG.port}`
    );
  });
}

process.on("SIGINT", () => {
  if (discordClient) discordClient.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  if (discordClient) discordClient.destroy();
  process.exit(0);
});

main().catch((err) => {
  console.error(`[discord-bridge] Fatal: ${err.message}`);
  process.exit(1);
});
