export const CURATED_DISCOVERY_RUNTIME_PROFILE = "v1.0a";

export function isCuratedBrunchRuntimeProfile(value) {
  return value === CURATED_DISCOVERY_RUNTIME_PROFILE;
}

export function supportedBrunchRuntimeProfiles() {
  return [CURATED_DISCOVERY_RUNTIME_PROFILE];
}
