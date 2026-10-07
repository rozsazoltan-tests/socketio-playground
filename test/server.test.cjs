const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const { io: createClient } = require("socket.io-client");
const { createDemoServer } = require("../server");

function waitForEvent(emitter, eventName, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(eventName, onEvent);
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);

    function onEvent(...args) {
      clearTimeout(timer);
      resolve(args.length > 1 ? args : args[0]);
    }

    emitter.once(eventName, onEvent);
  });
}

function emitAck(socket, eventName, payload) {
  return socket.timeout(5000).emitWithAck(eventName, payload);
}

function watchMessages(socket) {
  const messages = [];
  socket.on("chat:message", (item) => messages.push(item));
  return messages;
}

function assertCanonicalItem(item) {
  assert.deepEqual(Object.keys(item).sort(), [
    "createdAt",
    "id",
    "kind",
    "message",
    "recipientIds",
    "routing",
    "sender",
  ]);
  assert.match(item.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.ok(Number.isFinite(Date.parse(item.createdAt)));
  assert.deepEqual(Object.keys(item.sender).sort(), ["id", "name"]);
  assert.deepEqual(Object.keys(item.routing).sort(), [
    "audienceIds",
    "channel",
    "onlineSocketCount",
    "onlineUserIds",
    "rooms",
  ]);
}

async function startDemo() {
  const demo = createDemoServer();
  await new Promise((resolve, reject) => {
    demo.server.once("error", reject);
    demo.server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = demo.server.address();
  return { demo, url: `http://127.0.0.1:${port}` };
}

async function closeDemo(demo, sockets) {
  for (const socket of sockets) socket.disconnect();
  await new Promise((resolve) => demo.io.close(resolve));
  assert.equal(demo.server.listening, false);
}

async function withDemo(run) {
  const { demo, url } = await startDemo();
  const sockets = [];

  async function connect(userId) {
    const socket = createClient(url, {
      auth: { userId },
      transports: ["polling"],
      upgrade: false,
      reconnection: false,
      timeout: 4000,
    });
    sockets.push(socket);
    const statePromise = waitForEvent(socket, "chat:state");
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    return { socket, state: await statePromise };
  }

  try {
    return await run({ demo, url, connect, sockets });
  } finally {
    await closeDemo(demo, sockets);
  }
}

test("serves only the local Markdown browser bundle with GET and HEAD", async () => {
  await withDemo(async ({ url }) => {
    const bundlePath = require.resolve("markdown-it/browser");
    assert.match(bundlePath.replace(/\\/g, "/"), /\/node_modules\/markdown-it\/dist\/browser\/markdown-it\.umd\.min\.js$/);
    const bundle = fs.readFileSync(bundlePath);
    const browserWindow = {};
    browserWindow.window = browserWindow;
    browserWindow.self = browserWindow;
    browserWindow.global = browserWindow;
    browserWindow.atob = atob;
    vm.runInNewContext(bundle.toString("utf8"), browserWindow);
    assert.equal(typeof browserWindow.markdownit, "function");

    const response = await fetch(`${url}/markdown-it.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /^text\/javascript\b/i);
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bundle);

    const head = await fetch(`${url}/markdown-it.js`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.match(head.headers.get("content-type") || "", /^text\/javascript\b/i);
    assert.equal(head.headers.get("cache-control"), "no-cache");
    assert.equal(head.headers.get("x-content-type-options"), "nosniff");
    assert.equal(head.headers.get("content-length"), String(bundle.length));
    assert.equal(await head.text(), "");

    for (const pathname of [
      "/node_modules/markdown-it/dist/browser/markdown-it.umd.min.js",
      "/markdown-it.js/../../server.js",
      "/%2e%2e/node_modules/markdown-it/dist/browser/markdown-it.umd.min.js",
    ]) {
      const rejected = await fetch(`${url}${pathname}`);
      assert.equal(rejected.status, 404, pathname);
      await rejected.arrayBuffer();
    }
  });
});

function assertSuccess(result) {
  assert.equal(result.ok, true, result.error);
  assertCanonicalItem(result.item);
}

test("keeps HTTP and polling routes working while rejecting removed WebSocket routes", async () => {
  await withDemo(async ({ url }) => {
    const routes = [
      ["/", 200, /^text\/html\b/i],
      ["/index.html", 200, /^text\/html\b/i],
      ["/demo.js", 200, /javascript/i],
      ["/styles.css", 200, /^text\/css\b/i],
      ["/socket.io/socket.io.js", 200, /javascript/i],
    ];
    for (const [pathname, status, typePattern] of routes) {
      const response = await fetch(`${url}${pathname}`);
      assert.equal(response.status, status, pathname);
      assert.match(response.headers.get("content-type") || "", typePattern, pathname);
      await response.arrayBuffer();
    }
    for (const pathname of ["/ws", "/websocket-test"]) {
      const response = await fetch(`${url}${pathname}`);
      assert.equal(response.status, 404, pathname);
      await response.arrayBuffer();
    }

    const usersResponse = await fetch(`${url}/api/users`);
    assert.equal(usersResponse.status, 200);
    assert.deepEqual((await usersResponse.json()).users, [
      { id: "alice", name: "Alice" },
      { id: "bob", name: "Bob" },
      { id: "carol", name: "Carol" },
    ]);

    const healthResponse = await fetch(`${url}/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
      ok: true,
      pid: process.pid,
      transport: "polling",
      storage: "memory",
    });

    const favicon = await fetch(`${url}/favicon.ico`);
    assert.equal(favicon.status, 204);
    assert.equal(await favicon.text(), "");

    const handshakeResponse = await fetch(`${url}/socket.io/?EIO=4&transport=polling`);
    assert.equal(handshakeResponse.status, 200);
    const handshakeText = await handshakeResponse.text();
    assert.ok(handshakeText.startsWith("0"));
    const handshake = JSON.parse(handshakeText.slice(1));
    assert.deepEqual(handshake.upgrades, []);
    assert.ok(handshake.pingInterval > 0);
    assert.ok(handshake.pingTimeout > 0);
    const closeResponse = await fetch(`${url}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(handshake.sid)}`, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: "1",
    });
    assert.equal(closeResponse.status, 200);
    await closeResponse.text();
  });
});

test("broadcasts no-mention and email-address text publicly", async () => {
  await withDemo(async ({ connect }) => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const carol = await connect("carol");
    const received = [alice, bob, carol].map(({ socket }) => waitForEvent(socket, "chat:message"));

    const result = await emitAck(alice.socket, "chat:send", {
      message: "  Contact foo@bar.example or foo@carol; név@bob  ",
    });
    assertSuccess(result);
    const item = result.item;
    assert.equal(item.kind, "message");
    assert.equal(item.message, "Contact foo@bar.example or foo@carol; név@bob");
    assert.equal(item.sender.id, "alice");
    assert.equal(item.recipientIds, null);
    assert.deepEqual(item.routing, {
      channel: "public",
      rooms: ["chat:all"],
      audienceIds: ["alice", "bob", "carol"],
      onlineUserIds: ["alice", "bob", "carol"],
      onlineSocketCount: 3,
    });
    for (const event of await Promise.all(received)) assert.equal(event.id, item.id);
  });
});

test("routes a private mention to sender and recipient, including authorized snapshots only", async () => {
  await withDemo(async ({ connect }) => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const carol = await connect("carol");
    const aliceEvent = waitForEvent(alice.socket, "chat:message");
    const bobEvent = waitForEvent(bob.socket, "chat:message");
    const carolMessages = watchMessages(carol.socket);

    const result = await emitAck(alice.socket, "chat:send", { message: "Hi, (@BoB)!" });
    assertSuccess(result);
    assert.equal(result.item.routing.channel, "private");
    assert.deepEqual(result.item.recipientIds, ["bob"]);
    assert.deepEqual(result.item.routing.rooms, ["user:alice", "user:bob"]);
    assert.deepEqual(result.item.routing.audienceIds, ["alice", "bob"]);
    assert.deepEqual(result.item.routing.onlineUserIds, ["alice", "bob"]);
    assert.equal(result.item.routing.onlineSocketCount, 2);
    assert.equal((await aliceEvent).id, result.item.id);
    assert.equal((await bobEvent).id, result.item.id);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(carolMessages, []);

    const bobReconnect = await connect("bob");
    const carolReconnect = await connect("carol");
    assert.deepEqual(bobReconnect.state.messages.map((item) => item.id), [result.item.id]);
    assert.equal(carolReconnect.state.messages.some((item) => item.id === result.item.id), false);
  });
});

test("parses multiple case-insensitive punctuated mentions and deduplicates recipients", async () => {
  await withDemo(async ({ connect }) => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const carol = await connect("carol");
    const received = [alice, bob, carol].map(({ socket }) => waitForEvent(socket, "chat:message"));
    const result = await emitAck(alice.socket, "chat:send", {
      message: "(@BOB), check this; @carol! @bob?",
    });

    assertSuccess(result);
    assert.deepEqual(result.item.recipientIds, ["bob", "carol"]);
    assert.deepEqual(result.item.routing.rooms, ["user:alice", "user:bob", "user:carol"]);
    assert.deepEqual(result.item.routing.audienceIds, ["alice", "bob", "carol"]);
    assert.equal(result.item.routing.channel, "private");
    for (const event of await Promise.all(received)) assert.equal(event.id, result.item.id);
  });
});

test("rejects unknown full-handle mentions atomically and rejects spoofed routing fields", async () => {
  await withDemo(async ({ connect }) => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const carol = await connect("carol");
    const received = [alice, bob, carol].map(({ socket }) => watchMessages(socket));

    const unknown = await emitAck(alice.socket, "chat:send", { message: "Hello @bob and @unknown" });
    assert.deepEqual(unknown, { ok: false, error: "Unknown user mention: @unknown." });
    for (const mention of ["@bobby", "@álíce", "@bobé", "@bob-evil"]) {
      const unknownHandle = await emitAck(alice.socket, "chat:send", { message: `Hello ${mention}` });
      assert.equal(unknownHandle.ok, false, `${mention} must not match a shorter known handle`);
    }
    const spoofedSender = await emitAck(alice.socket, "chat:send", { message: "Hello @bob", senderId: "bob" });
    assert.equal(spoofedSender.ok, false);
    const spoofedRecipient = await emitAck(alice.socket, "chat:send", { message: "Hello @bob", recipientId: "carol" });
    assert.equal(spoofedRecipient.ok, false);
    const spoofedRecipients = await emitAck(alice.socket, "chat:send", { message: "Hello @bob", recipientIds: ["carol"] });
    assert.equal(spoofedRecipients.ok, false);
    const spoofedRouting = await emitAck(alice.socket, "chat:send", { message: "Hello", routing: { channel: "public" } });
    assert.equal(spoofedRouting.ok, false);
    const spoofedPoke = await emitAck(alice.socket, "chat:poke", { recipientId: "bob", senderId: "carol" });
    assert.equal(spoofedPoke.ok, false);
    const blank = await emitAck(alice.socket, "chat:send", { message: "   " });
    assert.equal(blank.ok, false);
    const tooLong = await emitAck(alice.socket, "chat:send", { message: "x".repeat(281) });
    assert.equal(tooLong.ok, false);

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(received.map((items) => items.length), [0, 0, 0]);
    const bobReconnect = await connect("bob");
    assert.deepEqual(bobReconnect.state.messages, []);
  });
});

test("sends private pokes only to recipient and sender; rejects self and unknown targets", async () => {
  await withDemo(async ({ connect }) => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const carol = await connect("carol");
    const aliceEvent = waitForEvent(alice.socket, "chat:message");
    const bobEvent = waitForEvent(bob.socket, "chat:message");
    const carolMessages = watchMessages(carol.socket);

    const result = await emitAck(alice.socket, "chat:poke", { recipientId: "bob" });
    assertSuccess(result);
    assert.deepEqual(Object.keys(result.item).sort(), [
      "createdAt", "id", "kind", "message", "recipientIds", "routing", "sender",
    ]);
    assert.equal(result.item.kind, "poke");
    assert.equal(result.item.message, "");
    assert.deepEqual(result.item.recipientIds, ["bob"]);
    assert.deepEqual(result.item.routing.rooms, ["user:alice", "user:bob"]);
    assert.deepEqual(result.item.routing.audienceIds, ["alice", "bob"]);
    assert.deepEqual(result.item.routing.onlineUserIds, ["alice", "bob"]);
    assert.equal(result.item.routing.onlineSocketCount, 2);
    assert.equal((await aliceEvent).id, result.item.id);
    assert.equal((await bobEvent).id, result.item.id);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(carolMessages, []);

    assert.equal((await emitAck(alice.socket, "chat:poke", { recipientId: "alice" })).ok, false);
    assert.equal((await emitAck(alice.socket, "chat:poke", { recipientId: "unknown" })).ok, false);
  });
});

test("delivers one private event to every same-user tab without duplicates", async () => {
  await withDemo(async ({ connect }) => {
    const aliceOne = await connect("alice");
    const aliceTwo = await connect("alice");
    const bobOne = await connect("bob");
    const bobTwo = await connect("bob");
    const carol = await connect("carol");
    const sockets = [aliceOne.socket, aliceTwo.socket, bobOne.socket, bobTwo.socket];
    const received = sockets.map((socket) => watchMessages(socket));
    const carolMessages = watchMessages(carol.socket);

    const result = await emitAck(aliceOne.socket, "chat:send", { message: "Private tab check @bob" });
    assertSuccess(result);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(received.map((items) => items.map((item) => item.id)), [
      [result.item.id], [result.item.id], [result.item.id], [result.item.id],
    ]);
    assert.deepEqual(carolMessages, []);
    assert.deepEqual(result.item.routing.onlineUserIds, ["alice", "bob"]);
    assert.equal(result.item.routing.onlineSocketCount, 4);
  });
});

test("restores offline private history, excludes unauthorized history, and caps each inbox at 100", async () => {
  await withDemo(async ({ connect }) => {
    const alice = await connect("alice");
    const offlineResult = await emitAck(alice.socket, "chat:send", { message: "While away @bob" });
    assertSuccess(offlineResult);
    assert.deepEqual(offlineResult.item.routing.onlineUserIds, ["alice"]);
    assert.equal(offlineResult.item.routing.onlineSocketCount, 1);

    const bob = await connect("bob");
    const carol = await connect("carol");
    assert.deepEqual(bob.state.messages.map((item) => item.id), [offlineResult.item.id]);
    assert.equal(carol.state.messages.some((item) => item.id === offlineResult.item.id), false);
    bob.socket.disconnect();
    carol.socket.disconnect();

    const sent = [];
    for (let index = 0; index < 101; index += 1) {
      const result = await emitAck(alice.socket, "chat:send", { message: `public ${index}` });
      assert.equal(result.ok, true, result.error);
      sent.push(result.item);
    }

    const bobCatchup = await connect("bob");
    const carolCatchup = await connect("carol");
    const aliceCatchup = await connect("alice");
    for (const [userId, state] of [
      ["alice", aliceCatchup.state],
      ["bob", bobCatchup.state],
      ["carol", carolCatchup.state],
    ]) {
      assert.equal(state.messages.length, 100, `${userId} history cap`);
      assert.equal(state.messages[0].id, sent[1].id, `${userId} oldest retained message`);
      assert.equal(state.messages[99].id, sent[100].id, `${userId} newest message`);
      assert.equal(state.messages[0].message, "public 1");
      assert.equal(state.messages[99].message, "public 100");
      assert.ok(state.messages.every((item) => item.routing.audienceIds.includes(userId)));
    }
  });
});

test("resets every user's history and broadcasts once without disconnecting sockets", async () => {
  await withDemo(async ({ demo, connect }) => {
    const aliceOne = await connect("alice");
    const aliceTwo = await connect("alice");
    const bob = await connect("bob");
    const carol = await connect("carol");

    const publicBeforeReset = await emitAck(aliceOne.socket, "chat:send", { message: "Before reset" });
    assertSuccess(publicBeforeReset);
    const offlinePrivate = await emitAck(aliceOne.socket, "chat:send", { message: "Offline history @carol" });
    assertSuccess(offlinePrivate);
    carol.socket.disconnect();

    const activeSockets = [aliceOne.socket, aliceTwo.socket, bob.socket];
    const connectionIds = activeSockets.map((socket) => socket.id);
    const roomSnapshots = activeSockets.map((socket) => {
      const serverSocket = demo.io.sockets.sockets.get(socket.id);
      assert.ok(serverSocket);
      return [...serverSocket.rooms].sort();
    });
    const resetEvents = activeSockets.map((socket) => {
      const events = [];
      socket.on("chat:reset", (event) => events.push(event));
      return events;
    });
    const resetWaiters = activeSockets.map((socket) => waitForEvent(socket, "chat:reset"));
    const reset = await emitAck(bob.socket, "chat:reset", {});

    assert.deepEqual(reset, { ok: true });
    assert.deepEqual(await Promise.all(resetWaiters), activeSockets.map(() => ({ by: "bob" })));
    assert.deepEqual(resetEvents, activeSockets.map(() => [{ by: "bob" }]));
    activeSockets.forEach((socket, index) => {
      assert.equal(socket.connected, true);
      assert.equal(socket.id, connectionIds[index]);
      const serverSocket = demo.io.sockets.sockets.get(socket.id);
      assert.deepEqual([...serverSocket.rooms].sort(), roomSnapshots[index]);
    });

    const afterReset = [];
    for (const userId of ["alice", "bob", "carol"]) {
      afterReset.push([userId, await connect(userId)]);
    }
    assert.deepEqual(afterReset.map(([, connection]) => connection.state.messages), [[], [], []]);

    const connectedByUser = [
      ["alice", aliceOne.socket],
      ["alice", aliceTwo.socket],
      ["bob", bob.socket],
      ...afterReset.map(([userId, connection]) => [userId, connection.socket]),
    ];
    const receivedBySocket = connectedByUser.map(([userId, socket]) => [userId, watchMessages(socket)]);

    const publicWaiters = connectedByUser.map(([, socket]) => waitForEvent(socket, "chat:message"));
    const publicResult = await emitAck(aliceOne.socket, "chat:send", { message: "Public after reset" });
    assertSuccess(publicResult);
    for (const event of await Promise.all(publicWaiters)) assert.equal(event.id, publicResult.item.id);

    const privateWaiters = connectedByUser
      .filter(([userId]) => userId === "alice" || userId === "bob")
      .map(([, socket]) => waitForEvent(socket, "chat:message"));
    const privateResult = await emitAck(aliceOne.socket, "chat:send", { message: "Private after reset @bob" });
    assertSuccess(privateResult);
    for (const event of await Promise.all(privateWaiters)) assert.equal(event.id, privateResult.item.id);

    const pokeWaiters = connectedByUser
      .filter(([userId]) => userId === "alice" || userId === "bob")
      .map(([, socket]) => waitForEvent(socket, "chat:message"));
    const pokeResult = await emitAck(aliceOne.socket, "chat:poke", { recipientId: "bob" });
    assertSuccess(pokeResult);
    for (const event of await Promise.all(pokeWaiters)) assert.equal(event.id, pokeResult.item.id);

    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const [userId, socketMessages] of receivedBySocket) {
      const expectedIds = userId === "carol"
        ? [publicResult.item.id]
        : [publicResult.item.id, privateResult.item.id, pokeResult.item.id];
      assert.deepEqual(socketMessages.map((item) => item.id), expectedIds);
    }

    for (const userId of ["alice", "bob", "carol"]) {
      const reconnect = await connect(userId);
      const expectedIds = userId === "carol"
        ? [publicResult.item.id]
        : [publicResult.item.id, privateResult.item.id, pokeResult.item.id];
      assert.deepEqual(reconnect.state.messages.map((item) => item.id), expectedIds);
      assert.ok(reconnect.state.messages.every((item) => item.id !== offlinePrivate.item.id));
      assert.ok(reconnect.state.messages.every((item) => item.kind !== "reset"));
    }
  });
});

test("rejects invalid reset payloads without clearing history or broadcasting", async () => {
  await withDemo(async ({ connect }) => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const existing = await emitAck(alice.socket, "chat:send", { message: "Keep this history" });
    assertSuccess(existing);

    const resetEvents = [alice.socket, bob.socket].map((socket) => {
      const events = [];
      socket.on("chat:reset", (event) => events.push(event));
      return events;
    });
    for (const payload of [null, [], { unexpected: true }]) {
      assert.deepEqual(await emitAck(alice.socket, "chat:reset", payload), {
        ok: false,
        error: "Invalid reset payload.",
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(resetEvents, [[], []]);
    for (const userId of ["alice", "bob", "carol"]) {
      const reconnect = await connect(userId);
      assert.deepEqual(reconnect.state.messages.map((item) => item.id), [existing.item.id]);
    }
  });
});

test("runs reset after an in-flight send and prevents stale history from returning", async () => {
  await withDemo(async ({ demo, connect }) => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const originalIn = demo.io.in;
    let resolveFetchStarted;
    let releaseFetch;
    const fetchStarted = new Promise((resolve) => { resolveFetchStarted = resolve; });
    const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
    let delayNextFetch = true;
    demo.io.in = (...rooms) => {
      const operator = originalIn.apply(demo.io, rooms);
      if (delayNextFetch) {
        delayNextFetch = false;
        const fetchSockets = operator.fetchSockets.bind(operator);
        operator.fetchSockets = async () => {
          resolveFetchStarted();
          await fetchGate;
          return fetchSockets();
        };
      }
      return operator;
    };

    const aliceEvents = [];
    const bobEvents = [];
    for (const [socket, events] of [[alice.socket, aliceEvents], [bob.socket, bobEvents]]) {
      socket.on("chat:message", (item) => events.push(["message", item.id]));
      socket.on("chat:reset", (event) => events.push(["reset", event.by]));
    }

    try {
      const serverAlice = demo.io.sockets.sockets.get(alice.socket.id);
      const resetReceived = waitForEvent(serverAlice, "chat:reset");
      const sendPromise = emitAck(alice.socket, "chat:send", { message: "Pending before reset" });
      await fetchStarted;
      const resetPromise = emitAck(alice.socket, "chat:reset", {});
      await resetReceived;
      releaseFetch();

      const [sendResult, resetResult] = await Promise.all([sendPromise, resetPromise]);
      assertSuccess(sendResult);
      assert.deepEqual(resetResult, { ok: true });
      assert.deepEqual(aliceEvents, [["message", sendResult.item.id], ["reset", "alice"]]);
      assert.deepEqual(bobEvents, [["message", sendResult.item.id], ["reset", "alice"]]);
      for (const userId of ["alice", "bob", "carol"]) {
        const reconnect = await connect(userId);
        assert.deepEqual(reconnect.state.messages, []);
      }
    } finally {
      releaseFetch();
      demo.io.in = originalIn;
    }
  });
});

test("continues queued actions after an action fails", async () => {
  await withDemo(async ({ demo, connect }) => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    const originalIn = demo.io.in;
    const originalError = console.error;
    const loggedErrors = [];
    let failNextFetch = true;
    demo.io.in = (...rooms) => {
      const operator = originalIn.apply(demo.io, rooms);
      if (failNextFetch) {
        failNextFetch = false;
        operator.fetchSockets = async () => { throw new Error("controlled fetch failure"); };
      }
      return operator;
    };
    console.error = (...args) => loggedErrors.push(args);

    try {
      const aliceMessages = watchMessages(alice.socket);
      const bobMessages = watchMessages(bob.socket);
      const resetEvent = waitForEvent(alice.socket, "chat:reset");
      const failedAction = emitAck(alice.socket, "chat:send", { message: "Must not persist" });
      const resetAction = emitAck(alice.socket, "chat:reset", {});
      const recoveredEvents = [alice.socket, bob.socket].map((socket) => waitForEvent(socket, "chat:message"));
      const recoveredAction = emitAck(alice.socket, "chat:send", { message: "After recovery" });

      assert.deepEqual(await failedAction, { ok: false, error: "Action failed." });
      assert.deepEqual(await resetAction, { ok: true });
      assert.deepEqual(await resetEvent, { by: "alice" });
      const recovered = await recoveredAction;
      assertSuccess(recovered);
      for (const event of await Promise.all(recoveredEvents)) assert.equal(event.id, recovered.item.id);
      assert.deepEqual(aliceMessages.map((item) => item.id), [recovered.item.id]);
      assert.deepEqual(bobMessages.map((item) => item.id), [recovered.item.id]);
      assert.equal(loggedErrors.filter(([message]) => message === "Socket.IO action failed").length, 1);

      for (const userId of ["alice", "bob", "carol"]) {
        const reconnect = await connect(userId);
        assert.deepEqual(reconnect.state.messages.map((item) => item.id), [recovered.item.id]);
      }
    } finally {
      demo.io.in = originalIn;
      console.error = originalError;
    }
  });
});

test("preserves demo identity validation and same-origin handshake checks", async () => {
  await withDemo(async ({ url, sockets }) => {
    const invalidUser = createClient(url, {
      auth: { userId: "mallory" },
      transports: ["polling"],
      upgrade: false,
      reconnection: false,
      timeout: 3000,
    });
    sockets.push(invalidUser);
    await waitForEvent(invalidUser, "connect_error");

    const crossOrigin = createClient(url, {
      auth: { userId: "alice" },
      transports: ["polling"],
      upgrade: false,
      reconnection: false,
      timeout: 3000,
      extraHeaders: { Origin: "https://attacker.invalid" },
    });
    sockets.push(crossOrigin);
    await waitForEvent(crossOrigin, "connect_error");
  });
});
