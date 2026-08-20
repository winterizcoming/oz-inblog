const providerStorageKey = "oz-inblog-provider-status";

function saveProviderStatus(status, message) {
  localStorage.setItem(
    providerStorageKey,
    JSON.stringify({
      provider: "codex",
      status,
      message,
      lastCheckedAt: new Date().toISOString()
    })
  );
}

function loadProviderStatus() {
  try {
    return JSON.parse(localStorage.getItem(providerStorageKey) || "null");
  } catch {
    return null;
  }
}

export function createProviderStatusController(nodes, codexProvider) {
  function syncProviderActions(status) {
    const connected = status === "connected";

    if (nodes.connectCodex) {
      nodes.connectCodex.textContent = connected ? "다시 확인" : "연결하기";
    }

    if (nodes.disconnectCodex) {
      nodes.disconnectCodex.hidden = !connected;
    }
  }

  function setStatus(status, message, options = {}) {
    const connected = status === "connected";
    const checking = status === "checking";

    nodes.providerStatus?.classList.toggle("connected", connected);
    nodes.providerStatus?.classList.toggle("disconnected", !connected);
    nodes.providerStatus?.classList.toggle("checking", checking);

    const label = connected ? "Codex 연결됨" : checking ? "Codex 확인 중" : "Codex 연결 끊김";
    const stateText = connected ? "연결됨" : checking ? "확인 중" : "연결 끊김";

    const labelNode = nodes.providerStatus?.querySelector("span:last-child");
    if (labelNode) labelNode.textContent = label;
    if (nodes.providerStateText) nodes.providerStateText.textContent = stateText;
    if (nodes.providerMessage && message) nodes.providerMessage.textContent = message;

    syncProviderActions(status);

    if (!options.skipSave && !checking) {
      saveProviderStatus(status, message ?? "");
    }
  }

  async function connect() {
    const button = nodes.connectCodex;
    if (!button) return;

    button.disabled = true;
    button.textContent = "확인 중...";
    setStatus("checking", "Codex CLI 세션을 확인하고 있습니다.");

    try {
      const payload = await codexProvider.probe();
      setStatus("connected", payload.reason ?? "Codex CLI 연결을 확인했습니다.");
      button.textContent = "다시 확인";
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown Codex provider error";
      const isUsageLimit = reason.includes("usage limit") || reason.includes("try again");
      const message = isUsageLimit
        ? "Codex 사용량 한도에 도달했습니다. 초기화 이후 다시 연결해 주세요."
        : `Codex 연결을 사용할 수 없습니다: ${reason}`;
      setStatus("disconnected", message);
    } finally {
      button.disabled = false;
    }
  }

  function disconnect() {
    localStorage.removeItem(providerStorageKey);
    setStatus("disconnected", "Codex 연결을 해제했습니다.", { skipSave: true });
  }

  function togglePopover() {
    if (!nodes.providerPopover) return;
    nodes.providerPopover.hidden = !nodes.providerPopover.hidden;
  }

  function closePopoverOnOutsideClick(event) {
    if (!nodes.providerPopover || nodes.providerPopover.hidden) return;

    const target = event.target;
    const clickedInsidePopover = nodes.providerPopover.contains(target);
    const clickedStatusButton = nodes.providerStatus?.contains(target);

    if (!clickedInsidePopover && !clickedStatusButton) {
      nodes.providerPopover.hidden = true;
    }
  }

  function closePopoverOnEscape(event) {
    if (event.key === "Escape" && nodes.providerPopover) {
      nodes.providerPopover.hidden = true;
    }
  }

  function bind() {
    const savedProviderStatus = loadProviderStatus();
    if (savedProviderStatus?.provider === "codex") {
      setStatus(savedProviderStatus.status, savedProviderStatus.message, { skipSave: true });
    }

    nodes.providerStatus?.addEventListener("click", togglePopover);
    nodes.connectCodex?.addEventListener("click", connect);
    nodes.disconnectCodex?.addEventListener("click", disconnect);
    document.addEventListener("click", closePopoverOnOutsideClick);
    document.addEventListener("keydown", closePopoverOnEscape);
  }

  return {
    bind,
    isConnected: () => nodes.providerStatus?.classList.contains("connected") ?? false,
    setStatus
  };
}
