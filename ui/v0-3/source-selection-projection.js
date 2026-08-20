const KIND_FIELDS = Object.freeze({
  document: Object.freeze({ initial: "ai_initial_selected_document_ids", added: "user_added_document_ids", removed: "user_removed_ai_document_ids", effective: "selected_document_ids" }),
  evidence: Object.freeze({ initial: "ai_initial_selected_evidence_ids", added: "user_added_evidence_ids", removed: "user_removed_ai_evidence_ids", effective: "selected_evidence_ids" })
});

function uniqueIds(values = []) {
  return [...new Set((values ?? []).map(String).filter(Boolean))];
}

function legacyInitialIds(selection, kind) {
  const fields = KIND_FIELDS[kind];
  if (Array.isArray(selection?.[fields.initial])) return uniqueIds(selection[fields.initial]);
  if (selection?.auto_selected !== true) return [];
  const planned = uniqueIds(selection?.discovery_plan?.selected_source_ids);
  const selected = uniqueIds(selection?.[fields.effective]);
  return planned.length ? selected.filter((id) => planned.includes(id)) : selected;
}

function legacyUserAddedIds(selection, kind, initial) {
  const fields = KIND_FIELDS[kind];
  if (Array.isArray(selection?.[fields.added])) return uniqueIds(selection[fields.added]);
  return uniqueIds(selection?.[fields.effective]).filter((id) => !initial.includes(id));
}

function projectionForKind(selection, kind) {
  const fields = KIND_FIELDS[kind];
  const initial = legacyInitialIds(selection, kind);
  const added = legacyUserAddedIds(selection, kind, initial);
  const removed = uniqueIds(selection?.[fields.removed]).filter((id) => initial.includes(id));
  const effective = uniqueIds([
    ...initial.filter((id) => !removed.includes(id)),
    ...added
  ]);
  return { initial, added, removed, effective };
}

export function buildSourceSelectionProjection(selection = {}) {
  const documents = projectionForKind(selection, "document");
  const evidence = projectionForKind(selection, "evidence");
  return {
    ai_initial: { document_ids: documents.initial, evidence_ids: evidence.initial },
    user_added: { document_ids: documents.added, evidence_ids: evidence.added },
    user_removed: { document_ids: documents.removed, evidence_ids: evidence.removed },
    effective_selected: { document_ids: documents.effective, evidence_ids: evidence.effective },
    counts: {
      ai_initial: documents.initial.length + evidence.initial.length,
      user_added: documents.added.length + evidence.added.length,
      user_removed: documents.removed.length + evidence.removed.length,
      effective: documents.effective.length + evidence.effective.length
    }
  };
}

export function applySourceSelectionProjection(selection = {}) {
  const projection = buildSourceSelectionProjection(selection);
  return {
    ...selection,
    selected_document_ids: projection.effective_selected.document_ids,
    selected_evidence_ids: projection.effective_selected.evidence_ids
  };
}

export function applySourceSelectionChange(selection = {}, { kind, sourceId, selected }) {
  const fields = KIND_FIELDS[kind];
  if (!fields || !sourceId) return applySourceSelectionProjection(selection);
  const id = String(sourceId);
  const initial = legacyInitialIds(selection, kind);
  const added = uniqueIds(selection[fields.added]);
  const removed = uniqueIds(selection[fields.removed]);
  const next = { ...selection };
  if (selected) {
    next[fields.removed] = removed.filter((value) => value !== id);
    next[fields.added] = initial.includes(id) ? added : uniqueIds([...added, id]);
  } else if (initial.includes(id)) {
    next[fields.removed] = uniqueIds([...removed, id]);
    next[fields.added] = added.filter((value) => value !== id);
  } else {
    next[fields.added] = added.filter((value) => value !== id);
  }
  return applySourceSelectionProjection(next);
}

export function clearSourceSelection(selection = {}) {
  const projection = buildSourceSelectionProjection(selection);
  return applySourceSelectionProjection({
    ...selection,
    user_added_document_ids: [],
    user_added_evidence_ids: [],
    user_removed_ai_document_ids: projection.ai_initial.document_ids,
    user_removed_ai_evidence_ids: projection.ai_initial.evidence_ids,
    selected_research_source_ids: []
  });
}
