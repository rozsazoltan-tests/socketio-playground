(() => {
  const $ = (selector) => document.querySelector(selector);
  const identitySelect = $("#identity");
  const form = $("#chat-form");
  const messageInput = $("#message");
  const sendButton = $("#send-button");
  const pokeRecipient = $("#poke-recipient");
  const pokeButton = $("#poke-button");
  const chat = $("#chat");
  const logElement = $("#log");
  const toast = $("#toast");
  const soundNote = $("#sound-note");
  const users = new Map();
  const messages = new Map();
  const loggedIds = new Set();
  const logLines = [];
  const activeSounds = new Set();
  let markdown = null;
  let markdownDiagnosticLogged = false;
  let socket = null;
  let userId = null;
  let ready = false;
  let sending = false;
  let poking = false;
  let hasSnapshot = false;
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
    return ready && Boolean(socket?.connected);
  }

  function updateControls() {
    const enabled = canAct();
    messageInput.disabled = !enabled;
    sendButton.disabled = !enabled || sending || !messageInput.value.trim();
    pokeRecipient.disabled = !enabled;
    pokeButton.disabled = !enabled || poking || !pokeRecipient.value || pokeRecipient.value === userId;
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
    if (routing?.channel === "public") return "public";
    if (routing?.channel === "private") return `private (${names(routing.audienceIds)})`;
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
    const items = [...messages.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    for (const item of items) {
      const row = document.createElement("li");
      row.className = item.sender?.id === userId ? "chat-row own" : "chat-row";
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

  function logItem(item) {
    if (!item?.id || loggedIds.has(item.id)) return;
    loggedIds.add(item.id);
    const route = item.routing || {};
    log(`ITEM id=${item.id} kind=${item.kind || "unknown"} transport=${transportName()} channel=${route.channel || "unknown"} rooms=${Array.isArray(route.rooms) ? route.rooms.join(",") : "unknown"} eligible=${names(route.audienceIds)} online=${names(route.onlineUserIds)} sockets=${Number.isInteger(route.onlineSocketCount) ? route.onlineSocketCount : "unknown"}`);
  }

  function addItem(item, source) {
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
    requestSocket.timeout(8000).emit(event, payload, (timeoutError, result) => {
      if (socket !== requestSocket || userId !== requestUser) return;
      if (timeoutError) {
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

  function connectAs(nextUserId) {
    userId = nextUserId;
    ready = false;
    sending = false;
    poking = false;
    hasSnapshot = false;
    clearChat();
    clearLog();
    updateControls();
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    setStatus("connecting...");
    const identityAtConnect = nextUserId;
    const nextSocket = window.io({
      transports: ["polling"],
      upgrade: false,
      auth: { userId: nextUserId },
    });
    socket = nextSocket;

    nextSocket.on("connect", () => {
      if (socket !== nextSocket || userId !== identityAtConnect) return;
      setStatus(ready ? "connected" : "connected; syncing chat...");
      log(`OPEN user=${userName(identityAtConnect)} transport=${transportName()}`);
    });
    nextSocket.on("disconnect", (reason) => {
      if (socket !== nextSocket || userId !== identityAtConnect) return;
      ready = false;
      sending = false;
      poking = false;
      setStatus("disconnected");
      updateControls();
      log(`CLOSE reason=${reason}`);
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
      // Restored history stays quiet; only new live events trigger a toast or beep.
      for (const item of snapshotItems) {
        messages.set(item.id, item);
        logItem(item);
      }
      ready = true;
      const initialSnapshot = !hasSnapshot;
      hasSnapshot = true;
      render(initialSnapshot);
      setStatus("connected");
      log(`CHAT STATE messages=${messages.size}`);
    });
    nextSocket.on("chat:message", (item) => {
      if (socket !== nextSocket || userId !== identityAtConnect) return;
      addItem(item, "live");
    });
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
    if (!canAct() || sending || !messageInput.value.trim()) return;
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
    if (!canAct() || poking || !pokeRecipient.value || pokeRecipient.value === userId) return;
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
