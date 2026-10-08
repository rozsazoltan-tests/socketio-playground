# socketio-playground

A small Socket.IO 4.8.4 chat for following a message from a browser to the server and back. The examples explain connections, events, rooms, acknowledgements, and temporary history. Alice, Bob, and Carol are selectable demo users, not logins.

## Run and try the chat

Use Node.js 24. `.node-version` records `24`; `package.json` requires Node.js `>=24`.

```sh
npm install
npm start
```

Open `http://localhost:3000` in two tabs as Alice and Bob. Add Carol in a third tab. Send `Hello everyone` as Alice: all three users see it. Send `Hello @bob`: only Alice and Bob see it. Try `@BOB @carol` to include both recipients, or select Bob beside **Poke** for a private poke with a sender echo. Self-pokes are rejected.

Private messages and pokes use a pale lavender bubble and a `Private · participants` label. Public messages keep the usual sender and recipient alignment.

Messages allow up to 280 characters and support Markdown. Raw HTML is disabled, and image syntax displays alt text instead of loading an image. Enter sends; Shift+Enter inserts a newline. Enter does not send while an IME is composing text.

New live messages and pokes from another user show a toast. Click or press a key to enable the short beep. Own sends and restored history stay quiet. The page must remain open; this is not Web Push.

Run `npm test` in another terminal to exercise routing, history, reset, validation, and HTTP endpoints. The tests live in `test/server.test.cjs`.

## Connect the browser and server

[`app.js`](app.js) starts the HTTP server built by [`server.js`](server.js). Socket.IO attaches to that same server, so the page, scripts, and polling requests share one origin. The annotated examples below are excerpts or short adaptations, not complete applications. Helpers and validation omitted from an example remain in the source files.

This shortened server setup leaves out the existing HTTP route handler and handshake options:

```js
const http = require("node:http");
const { Server: SocketIOServer } = require("socket.io");

// The real request handler also serves the page, scripts, and /health.
const server = http.createServer();
const io = new SocketIOServer(server, {
  serveClient: true,
  transports: ["polling"],
  allowUpgrades: false,
});
```

`public/index.html` loads the app's own `/socket.io/socket.io.js` before `public/demo.js`. Calling `io()` without a URL connects to the page's origin, not an external service:

```js
const socket = io({
  transports: ["polling"],
  upgrade: false,
  // This selects a demo persona. It is not proof of identity.
  auth: { userId: "alice" },
});

socket.on("connect", () => {
  // The connection ID can change after reconnecting.
  console.log(socket.id, socket.io.engine.transport.name);
});
```

The server runs `io.use()` before accepting a Socket.IO connection. Its middleware checks the whitelist and stores the selected user on the server-side socket:

```js
io.use((socket, next) => {
  const userId = socket.handshake.auth && socket.handshake.auth.userId;
  if (typeof userId !== "string" || !USERS_BY_ID.has(userId)) {
    return next(new Error("Invalid demo user."));
  }
  socket.data.userId = userId;
  next(); // Continue only after the demo user passes validation.
});

io.on("connection", (socket) => {
  const userId = socket.data.userId;
  socket.join(["chat:all", userRoom(userId)]);
  // Send this user's history only to the newly connected socket.
  socket.emit("chat:state", snapshotFor(userId));
});
```

The server's `connection` event supplies a new server-side socket; the browser's `connect` event reports that its connection is ready. A selected user is not `socket.id`: two Bob tabs have different connection IDs but the same demo user and room. The whitelist permits only `alice`, `bob`, and `carol`, yet anyone can choose any of them. Origin checks and room membership do not turn this into authentication.

Socket.IO normally tries to upgrade HTTP polling to WebSocket. This demo intentionally sets `transports: ["polling"]` on both sides, plus server `allowUpgrades: false` and client `upgrade: false`. Polling avoids needing a WebSocket tunnel through the hosting proxy. Socket.IO still speaks its own protocol; a raw WebSocket client is not a substitute.

## Send an event and choose its audience

`.on()` listens for an event name; `.emit()` sends that name with a payload. Here the browser sends `chat:send` with only `{ message }`. It does not choose a sender, room, or routing metadata. The server validates the payload, trims and checks the message, and parses mentions before constructing an item.

This excerpt belongs inside the validated `chat:send` action in `server.js`:

```js
const mentions = findMentionedUsers(message);
if (!mentions.ok) return mentions;

const item = await createChatItem({
  senderId: socket.data.userId, // Use the accepted connection's user.
  kind: "message",
  message,
  recipientIds: mentions.recipientIds,
  channel: mentions.recipientIds.length > 0 ? "private" : "public",
});
return { ok: true, item }; // The action wrapper sends this as the acknowledgement.
```

Handles are case-insensitive and matched in full. `@bobé` is an unknown Unicode handle, not a partial match for Bob. Any unknown mention rejects the whole message, including a message that also contains `@bob`; it never falls back to public delivery. Email-like text such as `name@bob` is not a standalone mention. Extra payload fields such as `senderId` or `routing` are rejected.

Rooms are server-side groups of sockets. Public messages use `io.to("chat:all")`; private messages use the sender's and recipients' `user:<id>` rooms. Inside `createChatItem()`, the routing decision is:

```js
// Include the sender once, even when mentions repeat.
const audienceIds = channel === "public"
  ? USERS.map((user) => user.id)
  : [...new Set([senderId, ...recipientIds])];
const rooms = channel === "public"
  ? ["chat:all"]
  : audienceIds.map(userRoom);

io.to(rooms).emit("chat:message", item);
```

A room array forms a union, not repeated sends: each matching socket gets one event. Every Bob tab receives Bob's private messages, and the sender's other tabs receive the echo. Carol receives neither the live private item nor its later history unless she is a recipient. This is routing isolation between demo personas, not a security boundary between authenticated people.

For comparison, server `socket.emit()` sends only to that socket, `io.emit()` sends to all connected sockets, and `socket.broadcast.emit()` excludes the originating socket. Room-targeted `io.to()` lets this demo include the sender while excluding unrelated users.

The browser requests an acknowledgement with an eight-second timeout. This adaptation logs the result instead of updating the UI:

```js
socket.timeout(8000).emit("chat:send", { message: "Hello @bob" }, (error, result) => {
  if (error) {
    // The write may have succeeded. Reconnect and inspect history before retrying.
    console.warn("Acknowledgement timed out; outcome unknown.");
  } else if (!result.ok) {
    console.error(result.error);
  } else {
    console.log(result.item); // Accepted by the server, not necessarily read or delivered.
  }
});
```

The server's action wrapper calls the supplied acknowledgement callback with `{ ok: true, item }` or `{ ok: false, error }`. A timeout means no acknowledgement arrived in time, not that the server rejected the action. Blind retries can create duplicate messages. `chat:poke` follows the same pattern with `{ recipientId: "bob" }`; the server rejects self-pokes and unknown recipients.

## Restore history, reconnect, and reset

`chat:message` carries a live item. `chat:state` carries a user's snapshot: `{ userId, users, messages }`. The server creates each item's UUID; the browser keeps items in a `Map` keyed by that ID. The sender can receive the same item through the room echo and the acknowledgement, so UUID deduplication prevents two transcript entries.

In `public/demo.js`, the live listener passes each item to the existing `addItem()` helper. That helper checks the current user's audience, updates the `Map`, and renders the transcript:

```js
socket.on("chat:message", (item) => {
  // "live" allows a new incoming item to alert; "ack" does not.
  addItem(item, "live");
});
```

On connection, the browser replaces its transcript with the snapshot and enables actions after synchronization. Restored items do not produce notifications. A temporary transport failure normally triggers automatic reconnection. Calling `socket.disconnect()` deliberately stops those retries; `socket.connect()` opens the connection again. A new snapshot restores only eligible retained items, not a durable archive.

In the demo, **Disconnect** pauses the current tab without deleting its transcript or draft. **Connect** creates a fresh socket for the selected user and waits for its snapshot. Changing users while paused does not reconnect. The status dot stays red until both the connection and snapshot are ready, then turns green; it describes only this tab's session. Your own `Connected as Alice.` and `Disconnected as Alice.` lines stay local. Other users' `Bob connected.` or `Bob disconnected.` lines arrive through server `chat:presence` events: `{ user: { id, name }, state, createdAt }`, where `state` is `"connected"` or `"disconnected"` and `createdAt` is an ISO timestamp. This shortened receiver belongs inside the existing `connectAs()` function:

```js
nextSocket.on("chat:presence", (presence) => {
  if (socket !== nextSocket || userId !== identityAtConnect) return;
  const personId = presence?.user?.id;
  const timestamp = typeof presence?.createdAt === "string" ? Date.parse(presence.createdAt) : NaN;
  if (personId === identityAtConnect || !users.has(personId)) return;
  if (presence.state !== "connected" && presence.state !== "disconnected") return;
  if (!Number.isFinite(timestamp)) return;
  // Use the known name; the existing helper renders plain text, not HTML.
  addConnectionNotice(`${users.get(personId)} ${presence.state}.`, timestamp);
});
```

The server announces a user's first connection after its initial snapshot and their departure only after it observes the last socket disconnect. Closing one of two Bob tabs does not announce Bob leaving; reconnecting after the last socket is lost announces a fresh arrival. The server derives these transitions from accepted connections, not client presence payloads. Presence shares the bounded 20-notice view with local connection lines, ordered by timestamp, without a toast or beep. It is live, not an online roster, chat history, or proof of attention or delivery; missed events are not replayed. Reset and identity changes clear the local notices. Reset leaves active connections and presence tracking intact, without fake departures or arrivals.

Clicking **Disconnect** calls [`socket.disconnect()`](https://socket.io/docs/v4/client-api/), which sends a Socket.IO namespace `DISCONNECT` packet and stops automatic reconnection. With polling, outgoing packets travel in HTTP POST requests. The local UI turns red without waiting for a server acknowledgement, so `Disconnected as Alice.` can appear before Bob sees `Alice disconnected.`. If the packet reaches the server and no other Alice sockets remain, departure is normally detected promptly; there is no mandatory heartbeat wait.

Closing a page, losing network access, or suspending a browser can lose or delay that packet. Both Alice tabs can look disconnected while the server still tracks an old Alice socket. This demo does not override Socket.IO 4.8.4's heartbeat defaults: [`pingInterval`](https://socket.io/docs/v4/server-options/#pinginterval) is 25,000 ms and [`pingTimeout`](https://socket.io/docs/v4/server-options/#pingtimeout) is 20,000 ms. The server sends a ping at the interval and waits up to the timeout for a pong. The client also treats a missing ping over the combined interval and timeout as a lost connection. For an undetected loss, that gives a 45-second heartbeat window, not a fixed departure delay or a maximum end-to-end delivery time. Network, proxy, and browser scheduling can affect when another tab displays the event.

HTTP long-polling does **not** check the chat every 25 seconds. A held polling request can return when the server has an event to deliver; the heartbeat checks connectivity, not notification cadence. To distinguish the paths, inspect the existing `server.js` disconnect log: `client namespace disconnect` normally follows an explicit disconnect, `ping timeout` means the heartbeat deadline expired, and `transport close` or `transport error` indicates transport shutdown or failure. That handler already logs the reason, so no extra listener is needed. These are the server's observations, not proof of a person's attention, and delay alone does not establish the cause.

**Reset chat clears all users' history, not just your tab.** Any connected demo user can send `chat:reset` with `{}`. Its acknowledgement is `{ ok: true }`, without an item. The server empties every history and broadcasts `chat:reset` with `{ by }`:

```js
// Inside the queued, validated reset action; keep connections and rooms intact.
for (const history of histories.values()) history.length = 0;
io.emit("chat:reset", { by: userId });
return { ok: true };
```

Each active browser clears its transcript and toast and stops any current beep, without a new alert. An offline user gets an empty history on reconnect if nobody has sent a new item since the reset. The server serializes actions: reset follows earlier queued writes, so an in-flight history lookup cannot append an old item after the reset. Later messages can still create new history.

**Clear log** only clears the current tab's diagnostic console. Reset does not erase those log lines, server stdout, screenshots, or notes elsewhere. It is neither an administrator permission nor secure deletion.

History holds at most 100 message or poke items per user in one process. Older items are discarded; restarting the server loses everything. Production needs real authentication and authorization, durable storage, and a shared event/state layer.

## Inspect connections and deploy to cPanel

The browser console shows the active client transport and each item's public/private channel, room names, eligible users, online users, and connected socket count at send time. Online counts describe routing connectivity, not delivery or reading. Compare two Bob tabs to see why user count and socket count differ. Opening `/health` returns `ok`, the process `pid`, `transport: "polling"`, and `storage: "memory"`; it does not prove that another browser received an item.

For cPanel, the host must support Node.js 24 or newer and expose **Setup Node.js App** or **Application Manager** with Node.js/Passenger support:

1. Upload `app.js`, `server.js`, `package.json`, `package-lock.json`, and `public/` into the application root. Do not upload local `node_modules/`.
2. Choose Node.js 24 if offered. Set the application root to that folder, startup file to `app.js`, and application URL to `/` on the intended domain.
3. Install npm dependencies through the host's application workflow, then restart. Let the environment supply `PORT`; do not hard-code a hosting port.

Polling removes the WebSocket-upgrade requirement, not other provider restrictions. Multi-worker deployment is unsupported even with sticky sessions: polling needs per-session request affinity, but affinity does not share each process's histories, rooms, or events. Hosting availability and proxy configuration still need verification.

License: [MIT](LICENSE).
