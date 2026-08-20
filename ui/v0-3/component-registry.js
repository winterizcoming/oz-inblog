export const supportedComponents = Object.freeze([
  "option_grid",
  "source_selection",
  "comparison_table",
  "checklist",
  "outline_viewer",
  "draft_viewer",
  "image_prompt_cards",
  "publish_package"
]);

export const componentRegistry = Object.freeze({
  option_grid: { renderer: "optionGrid", live: true },
  source_selection: { renderer: "sourceSelection", live: true },
  comparison_table: { renderer: "comparisonTable", live: true },
  checklist: { renderer: "checklist", live: true },
  outline_viewer: { renderer: "outlineViewer", live: true },
  draft_viewer: { renderer: "draftViewer", live: true },
  image_prompt_cards: { renderer: "imagePromptCards", live: false },
  publish_package: { renderer: "publishPackage", live: true }
});
