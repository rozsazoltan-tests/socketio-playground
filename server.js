const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { Server: SocketIOServer } = require("socket.io");
const MARKDOWN_IT_BROWSER_FILE = require.resolve("markdown-it/browser");

const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_MESSAGES_PER_USER = 100;
const MAX_MESSAGE_LENGTH = 280;
const USERS = Object.freeze([
  Object.freeze({ id: "alice", name: "Alice" }),
  Object.freeze({ id: "bob", name: "Bob" }),
  Object.freeze({ id: "carol", name: "Carol" }),
]);
const USERS_BY_ID = new Map(USERS.map((user) => [user.id, user]));
const STATIC_FILES = Object.freeze({
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/demo.js": ["demo.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
});

function userRoom(userId) {
  return `user:${userId}`;
}

function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === "null") return false;

  try {
    const originUrl = new URL(origin);
    const requestHost = req.headers.host;
    if (!requestHost || originUrl.host.toLowerCase() !== requestHost.toLowerCase()) {
      return false;
    }
    if (originUrl.username || originUrl.password || !["http:", "https:"].includes(originUrl.protocol)) {
      return false;
    }

    const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
      .split(",")[0]
      .trim()
      .toLowerCase();
    if (forwardedProto && originUrl.protocol !== `${forwardedProto}:`) return false;
    if (!forwardedProto && req.socket.encrypted && originUrl.protocol !== "https:") return false;
    return true;
  } catch {
    return false;
  }
}

function sendJson(res, statusCode, body, method = "GET") {
  const content = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(content),
    "cache-control": "no-store",
  });
  res.end(method === "HEAD" ? undefined : content);
}

function sendText(res, statusCode, text, method = "GET") {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(method === "HEAD" ? undefined : text);
}

function serveFile(res, filePath, contentType, method) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendText(res, 404, "Not found", method);
      return;
    }

    res.writeHead(200, {
      "content-type": contentType,
      "content-length": content.length,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    res.end(method === "HEAD" ? undefined : content);
  });
}

function validPayload(payload, allowedKeys) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  return Object.keys(payload).every((key) => allowedKeys.includes(key));
}

function createDemoServer() {
  const histories = new Map(USERS.map((user) => [user.id, []]));

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
    } catch {
      sendText(res, 400, "Bad request", req.method);
      return;
    }

    console.log("HTTP", req.method, pathname);
    const method = req.method;
    if (method !== "GET" && method !== "HEAD") {
      sendText(res, 405, "Method not allowed", method);
      return;
    }

    if (pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        transport: "polling",
        storage: "memory",
      }, method);
      return;
    }

    if (pathname === "/api/users") {
      sendJson(res, 200, { users: USERS }, method);
      return;
    }

    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === "/markdown-it.js") {
      serveFile(res, MARKDOWN_IT_BROWSER_FILE, "text/javascript; charset=utf-8", method);
      return;
    }

    const staticFile = STATIC_FILES[pathname];
    if (staticFile) {
      serveFile(res, path.join(PUBLIC_DIR, staticFile[0]), staticFile[1], method);
      return;
    }

    sendText(res, 404, "Not found", method);
  });

  const io = new SocketIOServer(server, {
    serveClient: true,
    // Polling avoids requiring WebSocket upgrades on shared hosts.
    transports: ["polling"],
    allowUpgrades: false,
    maxHttpBufferSize: 16 * 1024,
    cors: false,
    allowRequest: (req, callback) => {
      callback(null, isSameOriginRequest(req));
    },
  });

  io.use((socket, next) => {
    // Demo identities select a persona; they do not authenticate a real user.
    const userId = socket.handshake.auth && socket.handshake.auth.userId;
    if (typeof userId !== "string" || !USERS_BY_ID.has(userId)) {
      next(new Error("Invalid demo user."));
      return;
    }

    socket.data.userId = userId;
    next();
  });

  function historyFor(userId) {
    return histories.get(userId);
  }

  function snapshotFor(userId) {
    return {
      userId,
      users: USERS,
      messages: historyFor(userId).slice(),
    };
  }

  function findMentionedUsers(message) {
    const recipientIds = [];
    const seen = new Set();
    // Match complete Unicode handles so unknown mentions fail before routing can leak a message.
    const mentionPattern = /(?<![\p{L}\p{N}_@])@([\p{L}\p{N}_-]+)/gu;
    let match;

    while ((match = mentionPattern.exec(message)) !== null) {
      const userId = match[1].toLowerCase();
      if (!USERS_BY_ID.has(userId)) {
        return { ok: false, error: `Unknown user mention: @${match[1]}.` };
      }
      if (!seen.has(userId)) {
        seen.add(userId);
        recipientIds.push(userId);
      }
    }

    return { ok: true, recipientIds };
  }

  async function createChatItem({ senderId, kind, message, recipientIds, channel }) {
    // Private audiences include the sender so every sender tab receives the same item.
    const audienceIds = channel === "public"
      ? USERS.map((user) => user.id)
      : [...new Set([senderId, ...recipientIds])];
    const rooms = channel === "public"
      ? ["chat:all"]
      : audienceIds.map(userRoom);
    const matchedSockets = await io.in(rooms).fetchSockets();
    const matchedUserIds = new Set(matchedSockets.map((matchedSocket) => matchedSocket.data.userId));
    // Online fields describe send-time routing eligibility, not delivery or reading.
    const onlineUserIds = audienceIds.filter((userId) => matchedUserIds.has(userId));
    const item = {
      id: crypto.randomUUID(),
      kind,
      message,
      sender: USERS_BY_ID.get(senderId),
      recipientIds: channel === "public" ? null : recipientIds,
      createdAt: new Date().toISOString(),
      routing: {
        channel,
        rooms,
        audienceIds,
        onlineUserIds,
        onlineSocketCount: matchedSockets.length,
      },
    };

    for (const userId of audienceIds) {
      const history = historyFor(userId);
      history.push(item);
      if (history.length > MAX_MESSAGES_PER_USER) history.shift();
    }

    console.log("CHAT ROUTE", JSON.stringify({
      id: item.id,
      kind: item.kind,
      channel: item.routing.channel,
      rooms: item.routing.rooms,
      audienceIds: item.routing.audienceIds,
      onlineUserIds: item.routing.onlineUserIds,
      onlineSocketCount: item.routing.onlineSocketCount,
    }));
    // Socket.IO room arrays form a union, so each matching socket gets one event.
    io.to(rooms).emit("chat:message", item);
    return item;
  }

  function acknowledge(ack, result) {
    if (typeof ack !== "function") return;
    try {
      ack(result);
    } catch (error) {
      console.error("Socket.IO acknowledgement failed", error);
    }
  }

  async function handleAction(ack, action) {
    try {
      acknowledge(ack, await action());
    } catch (error) {
      console.error("Socket.IO action failed", error);
      acknowledge(ack, { ok: false, error: "Action failed." });
    }
  }

  io.on("connection", (socket) => {
    const userId = socket.data.userId;
    socket.join(["chat:all", userRoom(userId)]);
    console.log("Socket.IO connected", userId, socket.id);
    socket.emit("chat:state", snapshotFor(userId));

    socket.on("chat:send", (payload, ack) => {
      void handleAction(ack, async () => {
        if (!validPayload(payload, ["message"])) {
          return { ok: false, error: "Invalid chat payload." };
        }
        if (typeof payload.message !== "string") {
          return { ok: false, error: "Message must be a string." };
        }

        const message = payload.message.trim();
        if (message.length < 1 || message.length > MAX_MESSAGE_LENGTH) {
          return { ok: false, error: "Message must contain 1 to 280 characters." };
        }

        const mentions = findMentionedUsers(message);
        if (!mentions.ok) return mentions;

        const channel = mentions.recipientIds.length > 0 ? "private" : "public";
        const item = await createChatItem({
          senderId: socket.data.userId,
          kind: "message",
          message,
          recipientIds: mentions.recipientIds,
          channel,
        });
        return { ok: true, item };
      });
    });

    socket.on("chat:poke", (payload, ack) => {
      void handleAction(ack, async () => {
        if (!validPayload(payload, ["recipientId"]) || typeof payload.recipientId !== "string") {
          return { ok: false, error: "Invalid poke payload." };
        }
        if (!USERS_BY_ID.has(payload.recipientId)) {
          return { ok: false, error: "Unknown recipient." };
        }
        if (payload.recipientId === socket.data.userId) {
          return { ok: false, error: "Cannot poke yourself." };
        }

        const item = await createChatItem({
          senderId: socket.data.userId,
          kind: "poke",
          message: "",
          recipientIds: [payload.recipientId],
          channel: "private",
        });
        return { ok: true, item };
      });
    });

    socket.on("disconnect", (reason) => {
      console.log("Socket.IO disconnected", userId, reason);
    });
  });

  return { server, io };
}

module.exports = { createDemoServer };
