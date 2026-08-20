import { escapeHtml } from "./renderers.js";
import { copyCatalog } from "../copy-catalog.js";

function openDrawer(context, drawer) {
  context.nodes.backdrop.hidden = false;
  drawer.hidden = false;
  requestAnimationFrame(() => {
    drawer.classList.add("open");
    drawer.querySelector(".close-drawer")?.focus();
  });
}

export function createDrawerController(context) {
  let lastTrigger = null;
  const defaultCreateLabel = context.nodes.createWorkflow?.textContent ?? "";
  const drawerEyebrow = context.nodes.articleDrawer?.querySelector(".drawer-head .eyebrow");
  const drawerDescription = context.nodes.articleDrawer?.querySelector(".work-controls > p");
  const sessionFilterLabel = context.nodes.sessionFilter?.closest(".session-filter");
  const defaultDrawerEyebrow = drawerEyebrow?.textContent ?? "";
  const defaultDrawerDescription = drawerDescription?.textContent ?? "";

  function syncCreateLabel() {
    if (!context.nodes.createWorkflow) return;
    context.nodes.createWorkflow.textContent = context.state.mode === "brunch-chat"
      ? copyCatalog.brunchChat.newChat
      : defaultCreateLabel;
  }

  function syncDrawerCopy() {
    const isBrunchMode = context.state.mode === "brunch-chat";
    if (drawerEyebrow) drawerEyebrow.textContent = isBrunchMode ? copyCatalog.brunchChat.sessionListEyebrow : defaultDrawerEyebrow;
    if (drawerDescription) drawerDescription.textContent = isBrunchMode ? copyCatalog.brunchChat.sessionListDescription : defaultDrawerDescription;
    if (sessionFilterLabel) sessionFilterLabel.hidden = isBrunchMode;
  }

  function sessionLabel(session) {
    if (session.source === "brunch_chat") {
      const phase = session.current_step === "open_editing" ? "열린 편집" : session.current_step === "article" ? "본문 작성" : "작성 중";
      return `${copyCatalog.brand.chatVersion} Brunch · ${phase} · ${session.message_count ?? session.event_count ?? 0}개 메시지`;
    }
    const status = session.read_only ? "읽기 전용" : session.status === "recoverable" ? "복원 가능" : session.status;
    return `${status} · ${session.current_step ?? "기록 없음"} · ${session.event_count ?? 0} events`;
  }

  async function renderWorkItems() {
    const isBrunchMode = context.state.mode === "brunch-chat";
    context.nodes.articleList.innerHTML = `<p class="drawer-loading">${copyCatalog.workflow.sessionListLoading}</p>${isBrunchMode ? "" : `<button class="work-item" id="openFixtureSample" type="button">
      <div>
        <strong>${copyCatalog.workflow.fixtureTitle}</strong>
        <p>${copyCatalog.workflow.fixtureDescription}</p>
      </div>
      <span>${copyCatalog.workflow.open}</span>
    </button>`}`;
    context.nodes.articleList.querySelector("#openFixtureSample")?.addEventListener("click", async () => {
      await context.onOpenFixtureSample();
      closeDrawers();
    });
    try {
      const payload = isBrunchMode
        ? await context.listBrunchChatSessions({ limit: 50 })
        : await context.listWorkflowSessions({ filter: context.nodes.sessionFilter?.value ?? "all", limit: 50 });
      const sessions = payload.sessions ?? [];
      const cards = sessions.map((session) => {
        const sessionId = session.workflow_session_id ?? session.sessionId;
        const brunch = session.source === "brunch_chat";
        return `<button class="work-item session-work-item ${session.read_only ? "legacy" : ""}" type="button" ${brunch ? "data-brunch-session-id" : "data-session-id"}="${escapeHtml(sessionId)}">
        <div>
          <strong>${escapeHtml(session.title ?? sessionId)}</strong>
          <p>${escapeHtml(sessionLabel(session))}</p>
          <small>${session.target_track ? escapeHtml(session.target_track) : "트랙 미선택"}${session.content_purpose?.label ? ` · ${escapeHtml(session.content_purpose.label)}` : ""}${session.warnings?.length ? ` · 경고 ${session.warnings.length}건` : ""}</small>
        </div>
        <span>${brunch ? copyCatalog.workflow.open : session.read_only ? copyCatalog.workflow.readOnly : copyCatalog.workflow.resume}</span>
      </button>`;
      }).join("");
      const fixture = isBrunchMode ? "" : `<button class="work-item" id="openFixtureSample" type="button"><div><strong>${copyCatalog.workflow.fixtureTitle}</strong><p>${copyCatalog.workflow.fixtureShortDescription}</p></div><span>${copyCatalog.workflow.open}</span></button>`;
      context.nodes.articleList.innerHTML = `${cards || `<p class="drawer-empty">${isBrunchMode ? copyCatalog.brunchChat.sessionListEmpty : copyCatalog.workflow.sessionListEmpty}</p>`}${fixture}`;
      context.nodes.articleList.querySelector("#openFixtureSample")?.addEventListener("click", async () => {
        await context.onOpenFixtureSample();
        closeDrawers();
      });
      context.nodes.articleList.querySelectorAll("[data-session-id]").forEach((button) => {
        button.addEventListener("click", async () => {
          await context.onOpenWorkflowSession(button.dataset.sessionId);
          closeDrawers();
        });
      });
      context.nodes.articleList.querySelectorAll("[data-brunch-session-id]").forEach((button) => {
        button.addEventListener("click", async () => {
          try {
            await context.onOpenBrunchSession(button.dataset.brunchSessionId);
            closeDrawers();
          } catch (error) {
            context.nodes.articleList.insertAdjacentHTML("beforeend", `<p class="drawer-warning">${copyCatalog.workflow.sessionLoadError}: ${escapeHtml(error instanceof Error ? error.message : copyCatalog.workflow.unknownError)}</p>`);
          }
        });
      });
    } catch (error) {
      context.nodes.articleList.innerHTML += `<p class="drawer-warning">${copyCatalog.workflow.sessionListError}: ${escapeHtml(error instanceof Error ? error.message : copyCatalog.workflow.unknownError)}</p>`;
    }
  }

  function openArticleDrawer(event) {
    lastTrigger = event?.currentTarget ?? document.querySelector("#openArticles");
    syncCreateLabel();
    syncDrawerCopy();
    openDrawer(context, context.nodes.articleDrawer);
    renderWorkItems();
  }

  function closeDrawers() {
    for (const drawer of [context.nodes.articleDrawer, context.nodes.debugDrawer]) {
      drawer.classList.remove("open");
      drawer.hidden = true;
    }
    context.nodes.backdrop.hidden = true;
    const trigger = lastTrigger;
    lastTrigger = null;
    if (trigger?.isConnected && typeof trigger.focus === "function") trigger.focus();
  }

  function closeDrawersOnEscape(event) {
    if (event.key === "Escape" && !context.nodes.backdrop.hidden) closeDrawers();
  }

  function updateDebugDrawer() {
    context.nodes.debugJson.textContent = JSON.stringify(context.getSelectedResponse(), null, 2);
  }

  function openDebugDrawer(event) {
    lastTrigger = event?.currentTarget ?? document.querySelector("#openDebug");
    updateDebugDrawer();
    openDrawer(context, context.nodes.debugDrawer);
  }

  function bind() {
    document.querySelector("#openArticles").addEventListener("click", openArticleDrawer);
    document.querySelectorAll(".close-drawer").forEach((button) => button.addEventListener("click", closeDrawers));
    context.nodes.backdrop.addEventListener("click", closeDrawers);
    document.addEventListener("keydown", closeDrawersOnEscape);
    context.nodes.createWorkflow.addEventListener("click", () => {
      context.onNewWorkflow();
      closeDrawers();
    });
    context.nodes.sessionFilter?.addEventListener("change", renderWorkItems);
  }

  return { bind, closeDrawers, openArticleDrawer, openDebugDrawer, updateDebugDrawer };
}
