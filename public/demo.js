(() => {
  const $ = (selector) => document.querySelector(selector);
  const identitySelect = $("#identity");
  const connectionToggle = $("#connection-toggle");
  const connectionDot = $("#connection-dot");
  const form = $("#chat-form");
  const messageInput = $("#message");
  const sendButton = $("#send-button");
  const pokeRecipient = $("#poke-recipient");
  const pokeButton = $("#poke-button");
  const resetButton = $("#reset-chat");
  const chat = $("#chat");
  const logElement = $("#log");
  const toast = $("#toast");
  const soundNote = $("#sound-note");
  const users = new Map();
  const messages = new Map();
  const connectionNotices = [];
  const loggedIds = new Set();
  const logLines = [];
  const activeSounds = new Set();
  let markdown = null;
  let markdownDiagnosticLogged = false;
  let socket = null;
  let userId = null;
  let ready = false;
  let manuallyDisconnected = false;
  let sending = false;
  let poking = false;
  let resetting = false;
  let hasSnapshot = false;
  let connectionNoticePending = false;
  let toastTimer = null;
  let audioContext = null;
  let audioUnlocking = false;

  function log(text) {
    logLines.push(`${new Date().toISOString()}  ${text}`);
    if (logLines.length > 120) logLines.shift();
    logElement.textContent = logLines.join("\n");
    logElement.scrollTop = logElement.scrollHeight;
  }

  function clearLog() {
    logLines.length = 0;
    loggedIds.clear();
    logElement.textContent = "";
  }

  function transportName() {
    return socket?.connected ? socket.io.engine?.transport?.name || "polling" : "—";
  }

  function canAct() {
    // A live transport is not usable until the server's authorized history snapshot has arrived.
    return !manuallyDisconnected && ready && Boolean(socket?.connected);
  }

  function updateControls() {
    const enabled = canAct();
    connectionToggle.textContent = manuallyDisconnected ? "Connect" : "Disconnect";
    connectionToggle.disabled = !userId;
    connectionDot.classList.toggle("connected", enabled);
    messageInput.disabled = !enabled;
    sendButton.disabled = !enabled || sending || resetting || !messageInput.value.trim();
    pokeRecipient.disabled = !enabled || resetting;
    pokeButton.disabled = !enabled || poking || resetting || !pokeRecipient.value || pokeRecipient.value === userId;
    resetButton.disabled = !enabled || resetting;
    for (const option of pokeRecipient.options) option.disabled = option.value === userId;
  }

  function setStatus(text) {
    $("#status").textContent = text;
    $("#transport").textContent = transportName();
    updateControls();
  }

  function userName(id) {
    return users.get(id) || id || "unknown";
  }

  function names(ids) {
    return Array.isArray(ids) ? ids.map(userName).join(",") : "unknown";
  }

  function clearToast() {
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    toast.hidden = true;
    toast.textContent = "";
  }

  function stopSounds() {
    for (const sound of activeSounds) {
      sound.oscillator.onended = null;
      try { sound.oscillator.stop(); } catch {}
      try { sound.oscillator.disconnect(); } catch {}
      try { sound.gain.disconnect(); } catch {}
    }
    activeSounds.clear();
  }

  function clearChat() {
    messages.clear();
    connectionNotices.length = 0;
    loggedIds.clear();
    chat.replaceChildren();
    clearToast();
    stopSounds();
  }

  function unlockSound() {
    if (audioUnlocking || audioContext?.state === "running") return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      soundNote.textContent = "Notification sound is unavailable in this browser.";
      document.removeEventListener("pointerdown", unlockSound);
      document.removeEventListener("keydown", unlockSound);
      return;
    }
    audioUnlocking = true;
    try {
      audioContext ||= new AudioContextClass();
      audioContext.resume().then(() => {
        audioUnlocking = false;
        if (audioContext.state === "running") {
          soundNote.textContent = "Notification sound enabled.";
          document.removeEventListener("pointerdown", unlockSound);
          document.removeEventListener("keydown", unlockSound);
        }
      }).catch(() => { audioUnlocking = false; });
    } catch {
      audioUnlocking = false;
    }
  }

  function playBeep() {
    if (audioContext?.state !== "running") return;
    try {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const now = audioContext.currentTime;
      oscillator.frequency.value = 660;
      gain.gain.setValueAtTime(0.025, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      const sound = { oscillator, gain };
      activeSounds.add(sound);
      oscillator.onended = () => {
        activeSounds.delete(sound);
        try { oscillator.disconnect(); } catch {}
        try { gain.disconnect(); } catch {}
      };
      oscillator.start(now);
      oscillator.stop(now + 0.09);
    } catch {
      // Audio is optional; toast still reports the incoming item.
    }
  }

  function showToast(item) {
    const sender = item.sender?.name || userName(item.sender?.id);
    toast.textContent = item.kind === "poke" ? `${sender} poked you.` : `${sender}: ${item.message}`;
    toast.hidden = false;
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(clearToast, 3000);
    playBeep();
  }

  function audienceText(item) {
    const routing = item.routing;
    if (routing?.channel === "public") return "Public";
    if (routing?.channel === "private") return `Private · ${names(routing.audienceIds)}`;
    return "audience unknown";
  }

  function escapeHtml(value) {
    const replacements = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(value).replace(/[&<>"']/g, (character) => replacements[character]);
  }

  function renderMessage(body, item) {
    if (item.kind === "poke") {
      body.textContent = "poked";
      return;
    }
    const text = typeof item.message === "string" ? item.message : "";
    if (!markdown) {
      body.classList.add("plain-text");
      body.textContent = text;
      if (!markdownDiagnosticLogged) {
        markdownDiagnosticLogged = true;
        log("MARKDOWN renderer unavailable; showing plain text.");
      }
      return;
    }
    try {
      // Raw HTML stays disabled, and image syntax becomes escaped text instead of a remote request.
      body.innerHTML = markdown.render(text);
    } catch (error) {
      body.classList.add("plain-text");
      body.textContent = text;
      if (!markdownDiagnosticLogged) {
        markdownDiagnosticLogged = true;
        log(`MARKDOWN render failed; showing plain text: ${error.message}`);
      }
    }
  }

  function render(forceBottom = false) {
    const wasAtBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight <= 4;
    chat.replaceChildren();
    const entries = [
      ...[...messages.values()].map((item) => ({ time: Date.parse(item.createdAt), item })),
      ...connectionNotices.map((notice) => ({ time: notice.time, notice })),
    ].sort((left, right) => left.time - right.time);
    for (const entry of entries) {
      if (entry.notice) {
        const row = document.createElement("li");
        row.className = "chat-system";
        row.textContent = entry.notice.text;
        chat.append(row);
        continue;
      }
      const item = entry.item;
      const row = document.createElement("li");
      const alignment = item.sender?.id === userId ? " own" : "";
      const privacy = item.routing?.channel === "private" ? " private" : "";
      row.className = `chat-row${alignment}${privacy}`;
      const time = new Date(item.createdAt);
      const stamp = Number.isNaN(time.getTime()) ? "time unknown" : time.toLocaleTimeString();
      const sender = item.sender?.name || userName(item.sender?.id);
      const bubble = document.createElement("div");
      bubble.className = "chat-bubble";
      const metadata = document.createElement("div");
      metadata.className = "chat-meta";
      metadata.textContent = `${sender} · ${stamp} · ${audienceText(item)}`;
      const body = document.createElement("div");
      body.className = "chat-body";
      renderMessage(body, item);
      bubble.append(metadata, body);
      row.append(bubble);
      chat.append(row);
    }
    if (forceBottom || wasAtBottom) chat.scrollTop = chat.scrollHeight;
  }

  // Local notices and live presence share this bounded display list; neither becomes chat history.
  function addConnectionNotice(text, time = Date.now()) {
    connectionNotices.push({ time, text });
    if (connectionNotices.length > 20) connectionNotices.shift();
    render();
  }

  function logItem(item) {
    if (!item?.id || loggedIds.has(item.id)) return;
    loggedIds.add(item.id);
    const route = item.routing || {};
    log(`ITEM id=${item.id} kind=${item.kind || "unknown"} transport=${transportName()} channel=${route.channel || "unknown"} rooms=${Array.isArray(route.rooms) ? route.rooms.join(",") : "unknown"} eligible=${names(route.audienceIds)} online=${names(route.onlineUserIds)} sockets=${Number.isInteger(route.onlineSocketCount) ? route.onlineSocketCount : "unknown"}`);
  }

  function addItem(item, source) {
    // Rooms are selected on the server; audienceIds only filter this display and are not authorization.
    const authorized = Array.isArray(item?.routing?.audienceIds) && item.routing.audienceIds.includes(userId);
    if (!item?.id || !item.sender?.id || !item.routing || !authorized || !["message", "poke"].includes(item.kind)) return false;
    // The acknowledgement and room echo can carry the same UUID.
    const isNew = !messages.has(item.id);
    messages.set(item.id, item);
    if (isNew) {
      const ordered = [...messages.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      while (ordered.length > 100) {
        const evicted = ordered.shift();
        messages.delete(evicted.id);
        loggedIds.delete(evicted.id);
      }
      logItem(item);
      render(item.sender.id === userId);
      if (source === "live" && ready && item.sender.id !== userId) showToast(item);
    } else {
      messages.set(item.id, item);
      render(item.sender.id === userId);
    }
    return isNew;
  }

  function emit(event, payload, onSuccess, onFailure) {
    if (!canAct()) return;
    const requestSocket = socket;
    const requestUser = userId;
    // Client .emit sends the event and payload; the server calls this callback to acknowledge it.
    requestSocket.timeout(8000).emit(event, payload, (timeoutError, result) => {
      if (socket !== requestSocket || userId !== requestUser) return;
      if (timeoutError) {
        // A missing acknowledgement does not prove the server skipped the action; never retry automatically.
        const error = "Acknowledgement timed out; outcome unknown. Check chat after reconnect before retrying.";
        log(`${event}: ${error}`);
        onFailure(error);
      } else if (!result?.ok) {
        const error = result?.error || "Request failed.";
        log(`${event}: ${error}`);
        onFailure(error);
      } else {
        onSuccess(result.item);
      }
    });
  }

  function connectAs(nextUserId, preserveHistory = false) {
    const identityChanged = userId !== nextUserId;
    userId = nextUserId;
    ready = false;
    sending = false;
    poking = false;
    resetting = false;
    hasSnapshot = false;
    connectionNoticePending = false;
    if (!preserveHistory || identityChanged) {
      clearChat();
      clearLog();
    }
    updateControls();
    if (socket) {
      const previousSocket = socket;
      socket = null;
      previousSocket.removeAllListeners();
      previousSocket.disconnect();
    }
    if (manuallyDisconnected) {
      setStatus("disconnected (manual)");
      return;
    }
    setStatus("connecting...");
    const identityAtConnect = nextUserId;
    // Event and acknowledgement handlers below capture this socket and identity, so replaced sessions cannot update the new one.
    // This identity is a public demo selector, not authentication. Polling is the only transport.
    const nextSocket = window.io({
      transports: ["polling"],
      upgrade: false,
      auth: { userId: nextUserId },
    });
    socket = nextSocket;

    nextSocket.on("connect", () => {
      if (socket !== nextSocket || userId !== identityAtConnect) return;
      // Client connect confirms transport only; server connection also sends the chat snapshot.
      ready = false;
      connectionNoticePending = true;
      setStatus("connected; syncing chat...");
      log(`OPEN user=${userName(identityAtConnect)} transport=${transportName()}`);
    });
    nextSocket.on("disconnect", (reason) => {
      if (socket !== nextSocket || userId !== identityAtConnect) return;
      ready = false;
      sending = false;
      poking = false;
      resetting = false;
      connectionNoticePending = false;
      if (reason === "io server disconnect") {
        manuallyDisconnected = true;
        setStatus("disconnected by server");
      } else {
        setStatus(`disconnected (${reason}); reconnecting...`);
      }
      updateControls();
      log(`CLOSE reason=${reason}`);
      addConnectionNotice(`Disconnected as ${userName(identityAtConnect)}.`);
    });
    nextSocket.on("connect_error", (error) => {
      if (socket !== nextSocket || userId !== identityAtConnect) return;
      ready = false;
      setStatus("connection error; retrying...");
      log(`ERROR connect=${error.message}`);
    });
    nextSocket.io.on("reconnect_attempt", (attempt) => {
      if (socket === nextSocket && userId === identityAtConnect) log(`RECONNECT ATTEMPT ${attempt}`);
    });
    nextSocket.io.on("reconnect", () => {
      if (socket === nextSocket && userId === identityAtConnect) log("RECONNECTED; waiting for chat state");
    });
    nextSocket.on("chat:state", (state) => {
      if (socket !== nextSocket || userId !== identityAtConnect || state?.userId !== identityAtConnect || !Array.isArray(state.users) || !Array.isArray(state.messages)) return;
      const stateUsers = state.users.filter((user) => user?.id && user?.name);
      if (!stateUsers.some((user) => user.id === identityAtConnect)) return;
      users.clear();
      for (const user of stateUsers) users.set(user.id, user.name);
      messages.clear();
      const snapshotItems = state.messages.slice(-100).filter((item) => item?.id && Array.isArray(item?.routing?.audienceIds) && item.routing.audienceIds.includes(identityAtConnect));
      const snapshotIds = new Set(snapshotItems.map((item) => item.id));
      for (const id of loggedIds) if (!snapshotIds.has(id)) loggedIds.delete(id);
      // The server sends only this user's retained history (up to 100); restoring it stays quiet.
      // Routing audiences filter the transcript, but server-side room selection remains the access boundary.
      for (const item of snapshotItems) {
        messages.set(item.id, item);
        logItem(item);
      }
      // Only a valid state snapshot enables actions; a transport-level connect is not enough.
      ready = true;
      const initialSnapshot = !hasSnapshot;
      hasSnapshot = true;
      render(initialSnapshot);
      setStatus("connected");
      log(`CHAT STATE messages=${messages.size}`);
      if (connectionNoticePending) {
        connectionNoticePending = false;
        addConnectionNotice(`Connected as ${userName(identityAtConnect)}.`);
      }
    });
    nextSocket.on("chat:message", (item) => {
      // Socket .on handles server broadcasts; emit below sends actions from this client.
      if (socket !== nextSocket || userId !== identityAtConnect) return;
      addItem(item, "live");
    });
    nextSocket.on("chat:reset", (event) => {
      if (socket !== nextSocket || userId !== identityAtConnect) return;
      // Reset is a server-wide broadcast; only this event clears history, not the local acknowledgement.
      clearChat();
      log(`RESET by=${userName(event?.by)}`);
    });
    nextSocket.on("chat:presence", (presence) => {
      if (socket !== nextSocket || userId !== identityAtConnect) return;
      const personId = presence?.user?.id;
      const timestamp = typeof presence?.createdAt === "string" ? Date.parse(presence.createdAt) : NaN;
      if (personId === identityAtConnect || !users.has(personId)) return;
      if (presence.state !== "connected" && presence.state !== "disconnected") return;
      if (!Number.isFinite(timestamp)) return;
      // Ignore this identity: its local socket notices already describe its own connection lifecycle.
      const name = userName(personId);
      addConnectionNotice(`${name} ${presence.state}.`, timestamp);
      log(`PRESENCE user=${personId} state=${presence.state}`);
    });
  }

  function disconnectManually() {
    if (!socket || manuallyDisconnected) return;
    // Socket.disconnect stops this client's automatic reconnect until the user connects again.
    manuallyDisconnected = true;
    ready = false;
    sending = false;
    poking = false;
    resetting = false;
    connectionNoticePending = false;
    const previousSocket = socket;
    // Null first so late acknowledgements and manager events from this socket fail their identity guard.
    socket = null;
    previousSocket.removeAllListeners();
    previousSocket.disconnect();
    clearToast();
    stopSounds();
    setStatus("disconnected (manual)");
    log(`MANUAL DISCONNECT user=${userName(userId)}`);
    addConnectionNotice(`Disconnected as ${userName(userId)}.`);
  }

  function populateUsers(userList) {
    identitySelect.replaceChildren();
    pokeRecipient.replaceChildren();
    for (const user of userList) {
      if (!user?.id || !user?.name) continue;
      users.set(user.id, user.name);
      for (const select of [identitySelect, pokeRecipient]) {
        const option = document.createElement("option");
        option.value = user.id;
        option.textContent = user.name;
        select.append(option);
      }
    }
    if (!users.has("alice") || !users.has("bob") || !users.has("carol")) throw new Error("Expected demo users were not returned.");
    identitySelect.value = "alice";
    pokeRecipient.value = "bob";
    identitySelect.disabled = false;
    connectAs(identitySelect.value);
  }

  identitySelect.addEventListener("change", () => {
    pokeRecipient.value = [...users.keys()].find((id) => id !== identitySelect.value) || "";
    connectAs(identitySelect.value);
  });
  connectionToggle.addEventListener("click", () => {
    if (!userId) return;
    if (manuallyDisconnected) {
      manuallyDisconnected = false;
      connectAs(userId, true);
    } else {
      disconnectManually();
    }
  });
  messageInput.addEventListener("input", updateControls);
  messageInput.addEventListener("keydown", (event) => {
    // Enter can finish IME composition, so do not send while composition is active.
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!sendButton.disabled) form.requestSubmit(sendButton);
  });
  pokeRecipient.addEventListener("change", updateControls);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!canAct() || sending || resetting || !messageInput.value.trim()) return;
    const payload = { message: messageInput.value.trim() };
    sending = true;
    updateControls();
    emit("chat:send", payload, (item) => {
      addItem(item, "ack");
      messageInput.value = "";
      sending = false;
      updateControls();
    }, () => {
      sending = false;
      updateControls();
    });
  });
  pokeButton.addEventListener("click", () => {
    if (!canAct() || poking || resetting || !pokeRecipient.value || pokeRecipient.value === userId) return;
    const payload = { recipientId: pokeRecipient.value };
    poking = true;
    updateControls();
    emit("chat:poke", payload, (item) => {
      addItem(item, "ack");
      poking = false;
      updateControls();
    }, () => {
      poking = false;
      updateControls();
    });
  });
  resetButton.addEventListener("click", () => {
    if (!canAct() || resetting) return;
    if (!window.confirm("Clear chat history for all demo users? This cannot be undone.")) return;
    if (!canAct()) return;
    resetting = true;
    updateControls();
    // The broadcast event clears chat; the acknowledgement only releases this tab's controls.
    emit("chat:reset", {}, () => {
      resetting = false;
      updateControls();
    }, () => {
      resetting = false;
      updateControls();
    });
  });
  $("#clear-log").addEventListener("click", clearLog);
  document.addEventListener("pointerdown", unlockSound);
  document.addEventListener("keydown", unlockSound);

  try {
    if (typeof window.markdownit !== "function") throw new Error("markdown-it browser client did not load.");
    markdown = window.markdownit({ html: false, breaks: true });
    markdown.renderer.rules.image = (tokens, index) => {
      const image = tokens[index];
      return escapeHtml(image.attrGet("alt") || image.content || "");
    };
  } catch (error) {
    markdown = null;
    markdownDiagnosticLogged = true;
    log(`MARKDOWN setup unavailable; showing plain text: ${error.message}`);
  }

  fetch("./api/users", { headers: { Accept: "application/json" } })
    .then((response) => {
      if (!response.ok) throw new Error(`Users request failed: ${response.status}`);
      return response.json();
    })
    .then((data) => populateUsers(data.users))
    .catch((error) => {
      setStatus("setup error");
      log(`ERROR setup=${error.message}`);
    });
})();
