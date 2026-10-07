# socketio-playground

A small Socket.IO chat for learning events, rooms, and acknowledgements. It uses HTTP long-polling. Alice, Bob, and Carol are demo users, not logins.

## Run locally

Use Node.js 22.

```sh
npm install
npm start
```

Run `npm test` to check routing, history, and the HTTP endpoints.

Open `http://localhost:3000` as Alice and Bob in two tabs; add Carol to check private routing. Messages without mentions broadcast; `Hello @bob` reaches Bob and the sender. Multiple known mentions select recipients, case-insensitively. The server rejects unknown mentions.

Messages support Markdown, up to 280 characters. Raw HTML is disabled; images do not load automatically. Enter sends; Shift+Enter adds a newline. **Poke** privately notifies the selected user and echoes to the sender; self-pokes are rejected.

Incoming messages and pokes show a toast; click or press a key to enable the beep. Own sends and history never alert. Pages must stay open; this is not Web Push.

## Events and rooms

The app serves its browser client at `/socket.io/socket.io.js`. With that script loaded:

```js
const socket = io({
  transports: ["polling"],
  upgrade: false,
  auth: { userId: "alice" },
});

socket.on("chat:message", (item) => console.log(item));
socket.emit("chat:send", { message: "Hello @bob" }, (reply) => {
  if (reply.ok) console.log(reply.item);
  else console.error(reply.error);
});
```

`chat:send` names the event; `{ message }` is its payload. The callback reports server acceptance, not delivery or reading. `chat:message` carries new items; `chat:state` restores retained history on connection.

Rooms group sockets. Each socket joins `chat:all` and `user:<id>`. Public messages go to `chat:all`; private messages use the sender's and recipients' user rooms.

Socket.IO normally tries to upgrade polling to WebSocket. The server's `transports: ["polling"]` and `allowUpgrades: false` match the client's polling-only settings. Socket.IO uses its own protocol, not raw WebSocket.

One process holds up to 100 items per user; restart clears it. Multi-worker deployment is unsupported: polling needs per-session request affinity, but sticky sessions do not share history or events. Production needs real authentication, a database, and shared events.

## cPanel (optional)

If the host offers **Setup Node.js App** or **Application Manager** with Node.js/Passenger support:

1. Upload `app.js`, `server.js`, `package.json`, `package-lock.json`, and `public/` into the application root. Do not upload local `node_modules/`.
2. Choose supported Node.js 22 if offered. Set application root to the uploaded folder, startup file to `app.js`, and URL to `/` on the intended domain.
3. Install npm dependencies through the hosting UI, then restart. Let the environment manage `PORT`.

Polling avoids needing a WebSocket tunnel, but does not guarantee hosting compatibility.

License: [MIT](LICENSE).
