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
  // Each demo user owns a capped in-memory inbox; this state is not durable storage.
  const histories = new Map(USERS.map((user) => [user.id, []]));
  let actionQueue = Promise.resolve();

  // This HTTP server serves pages and APIs. Socket.IO attaches below on the same port.
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

  // Socket.IO adds handshakes and custom events; the HTTP routes above remain active.
  const io = new SocketIOServer(server, {
    // Serve the browser client at /socket.io/socket.io.js.
    serveClient: true,
    // Force polling on client and server to avoid WebSocket-upgrade setup in shared-host proxies.
    transports: ["polling"],
    allowUpgrades: false,
    maxHttpBufferSize: 16 * 1024,
    cors: false,
    allowRequest: (req, callback) => {
      // Same-origin checks limit browser origins, not user identity; io.use validates demo personas below.
      callback(null, isSameOriginRequest(req));
    },
  });

  // Middleware runs on each handshake, before Socket.IO emits the connection event.
  io.use((socket, next) => {
    // This accepts a demo persona, not a real account or authenticated identity.
    const userId = socket.handshake.auth && socket.handshake.auth.userId;
    if (typeof userId !== "string" || !USERS_BY_ID.has(userId)) {
      next(new Error("Invalid demo user."));
      return;
    }

    // Store the validated persona per socket. Ignore sender identity in event payloads.
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
      // Copy this persona's capped inbox to the new socket. History exists only in process memory.
      messages: historyFor(userId).slice(),
    };
  }

  function findMentionedUsers(message) {
    const recipientIds = [];
    const seen = new Set();
    // Match complete Unicode handles. Unknown handles reject the whole send; they never become public broadcasts.
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
    // Store items in each audience user's inbox. Include sender so all their tabs stay in sync.
    const audienceIds = channel === "public"
      ? USERS.map((user) => user.id)
      : [...new Set([senderId, ...recipientIds])];
    const rooms = channel === "public"
      ? ["chat:all"]
      : audienceIds.map(userRoom);
    // Count matching sockets for send-time metadata; this is not proof of delivery or reading.
    const matchedSockets = await io.in(rooms).fetchSockets();
    const matchedUserIds = new Set(matchedSockets.map((matchedSocket) => matchedSocket.data.userId));
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
    // Room arrays form a union, so overlapping rooms still emit once per socket.
    // Private routes include sender's room so their other tabs receive the item.
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

  // Acknowledgements are optional. Success means server acceptance, not client receipt or reading.
  // Catch action failures here so they do not escape as unhandled promise rejections.
  async function handleAction(ack, action) {
    try {
      acknowledge(ack, await action());
    } catch (error) {
      console.error("Socket.IO action failed", error);
      acknowledge(ack, { ok: false, error: "Action failed." });
    }
  }

  // Serialize sends, pokes, and resets. Pending history lookups must finish before reset clears memory.
  function enqueueAction(ack, action) {
    actionQueue = actionQueue.then(() => handleAction(ack, action)).catch((error) => {
      console.error("Socket.IO action queue failed", error);
      acknowledge(ack, { ok: false, error: "Action failed." });
    });
  }

  // socket.id is transient per connection; one selected demo userId can span tabs and reconnects.
  io.on("connection", (socket) => {
    const userId = socket.data.userId;
    // Assign rooms server-side. Each socket joins the public room and its persona's private room.
    socket.join(["chat:all", userRoom(userId)]);
    console.log("Socket.IO connected", userId, socket.id);
    // socket.emit sends only to this connection. Reconnects rerun middleware and receive a fresh snapshot.
    socket.emit("chat:state", snapshotFor(userId));

    // socket.on registers a custom client event. Derive sender from socket.data.userId, not payload.
    socket.on("chat:send", (payload, ack) => {
      enqueueAction(ack, async () => {
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

        // Known mentions select private rooms; a message without mentions uses the public room.
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

    // This event names a recipient only; sender still comes from socket.data.userId.
    socket.on("chat:poke", (payload, ack) => {
      enqueueAction(ack, async () => {
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

    // Any connected demo persona can reset all inboxes, including offline users. This is not an admin feature.
    socket.on("chat:reset", (payload, ack) => {
      enqueueAction(ack, async () => {
        if (!validPayload(payload, [])) {
          return { ok: false, error: "Invalid reset payload." };
        }

        // Reset is a control event, not a chat item. Never add it to history.
        // io.emit notifies every connected socket. Reconnects show only post-reset messages.
        for (const history of histories.values()) history.length = 0;
        console.log("CHAT RESET", JSON.stringify({ by: userId }));
        io.emit("chat:reset", { by: userId });
        return { ok: true };
      });
    });

    // Disconnect removes the socket, not history. Reconnects validate, rejoin rooms, and get a current snapshot.
    socket.on("disconnect", (reason) => {
      console.log("Socket.IO disconnected", userId, reason);
    });
  });

  return { server, io };
}

module.exports = { createDemoServer };
