const BLOCKED_SOURCE_STATUSES = new Set(["rejected", "blocked", "archived", "stale", "expired", "failed"]);

function hasCanonicalUrl(item) {
  return typeof item?.canonical_url === "string" && item.canonical_url.trim().length > 0;
}

function hasEvidenceText(item) {
  return Boolean(String(item?.claim ?? "").trim() || String(item?.excerpt ?? "").trim());
}

function isExpired(item, now = Date.now()) {
  if (!item?.valid_until) return false;
  const timestamp = Date.parse(item.valid_until);
  return Number.isFinite(timestamp) && timestamp < now;
}

export function isSourceContextUsable(item = {}, now = Date.now()) {
  const evidenceStatus = item.evidence_status ?? item.status;
  const sourceStatus = item.source_review_status ?? item.review_status;
  const snapshotStatus = item.snapshot_fetch_status ?? item.snapshot_status ?? item.fetch_status;
  return ["pending", "approved"].includes(evidenceStatus)
    && !BLOCKED_SOURCE_STATUSES.has(sourceStatus)
    && snapshotStatus === "succeeded"
    && hasCanonicalUrl(item)
    && hasEvidenceText(item)
    && !isExpired(item, now);
}

export function isResearchSourceSelectable(item = {}, now = Date.now()) {
  const sourceStatus = item.source_review_status ?? item.review_status;
  if (BLOCKED_SOURCE_STATUSES.has(String(sourceStatus ?? "").toLowerCase())) return false;
  if (!hasCanonicalUrl(item)) return false;
  return !isExpired(item, now);
}

export function canSupportFactualClaim(item = {}, now = Date.now()) {
  return isSourceContextUsable(item, now) && (item.evidence_status ?? item.status) === "approved";
}

export function canPassFinalApproval(item = {}, now = Date.now()) {
  return canSupportFactualClaim(item, now);
}

export function sourceUsagePolicy(item = {}, now = Date.now()) {
  if (!isSourceContextUsable(item, now)) return "excluded";
  return (item.evidence_status ?? item.status) === "approved" ? "claim_support" : "context_only";
}
