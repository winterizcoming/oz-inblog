import { renderCurrentStep } from "./renderers.js";

const REGION_SELECTORS = Object.freeze({
  modals: "[data-source-selection-modals]",
  controls: "[data-source-search-controls]",
  summary: "[data-source-selection-summary]",
  discovery: "[data-source-ai-discovery]",
  results: "[data-source-search-results]",
  selected: "[data-source-selected-list]"
});

const REGION_SCOPES = Object.freeze({
  all: Object.keys(REGION_SELECTORS),
  search: ["summary", "results", "selected"],
  results: ["summary", "results", "selected"],
  selection: ["summary", "discovery", "results", "selected"],
  detail: ["modals"],
  research: ["modals", "results"]
});

function renderNextRoot(viewModel) {
  const template = document.createElement("template");
  template.innerHTML = renderCurrentStep(viewModel).trim();
  return template.content.firstElementChild;
}

function captureTransientUiState(root) {
  const activeElement = document.activeElement;
  const focusedField = activeElement && root.contains(activeElement) && activeElement.matches("input, textarea, select")
    ? {
      name: activeElement.getAttribute("name") ?? "",
      type: activeElement.getAttribute("type") ?? "",
      selectionStart: typeof activeElement.selectionStart === "number" ? activeElement.selectionStart : null,
      selectionEnd: typeof activeElement.selectionEnd === "number" ? activeElement.selectionEnd : null
    }
    : null;
  const recommendation = root.querySelector(".source-selection-recommended");
  const selectedSources = root.querySelector(".source-selection-selected");
  const rightScroll = root.closest(".right-scroll");
  const modal = root.querySelector("[data-research-detail-modal] .research-detail-modal");
  return {
    focusedField,
    recommendationOpen: recommendation?.open ?? false,
    selectedSourcesOpen: selectedSources?.open ?? false,
    rightScrollTop: rightScroll?.scrollTop ?? 0,
    modalScrollTop: modal?.scrollTop ?? 0
  };
}

function restoreTransientUiState(root, snapshot) {
  if (!snapshot) return;
  const recommendation = root.querySelector(".source-selection-recommended");
  if (recommendation) recommendation.open = snapshot.recommendationOpen;
  const selectedSources = root.querySelector(".source-selection-selected");
  if (selectedSources) selectedSources.open = snapshot.selectedSourcesOpen;

  const rightScroll = root.closest(".right-scroll");
  if (rightScroll) rightScroll.scrollTop = snapshot.rightScrollTop;
  const modal = root.querySelector("[data-research-detail-modal] .research-detail-modal");
  if (modal) modal.scrollTop = snapshot.modalScrollTop;

  if (snapshot.focusedField?.name) {
    const field = [...root.querySelectorAll("input, textarea, select")]
      .find((candidate) => candidate.getAttribute("name") === snapshot.focusedField.name);
    if (field) {
      field.focus({ preventScroll: true });
      if (snapshot.focusedField.selectionStart !== null && typeof field.setSelectionRange === "function") {
        field.setSelectionRange(snapshot.focusedField.selectionStart, snapshot.focusedField.selectionEnd);
      }
    }
  }

  requestAnimationFrame(() => {
    const nextRightScroll = root.closest(".right-scroll");
    if (nextRightScroll) nextRightScroll.scrollTop = snapshot.rightScrollTop;
    const nextModal = root.querySelector("[data-research-detail-modal] .research-detail-modal");
    if (nextModal) nextModal.scrollTop = snapshot.modalScrollTop;
  });
}

function replaceRegion(root, nextRoot, key) {
  const selector = REGION_SELECTORS[key];
  const currentRegion = root.querySelector(selector);
  const nextRegion = nextRoot.querySelector(selector);
  if (!currentRegion || !nextRegion) return;
  currentRegion.replaceChildren(...[...nextRegion.childNodes].map((node) => node.cloneNode(true)));
}

export function createSourceSelectionViewController() {
  return {
    update(viewModel, { scope = "all" } = {}) {
      const root = document.querySelector("[data-source-selection-root]");
      if (!root) return false;
      const nextRoot = renderNextRoot(viewModel);
      if (!nextRoot?.matches("[data-source-selection-root]")) return false;
      const snapshot = captureTransientUiState(root);
      const regionKeys = REGION_SCOPES[scope] ?? REGION_SCOPES.all;
      regionKeys.forEach((key) => replaceRegion(root, nextRoot, key));
      restoreTransientUiState(root, snapshot);
      return true;
    }
  };
}
