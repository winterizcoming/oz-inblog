import fs from "node:fs";
import path from "node:path";

export function loadReleaseManifest(root = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.join(root, "release-manifest.json"), "utf8"));
}

export function releaseMetadata(manifest, { buildSha = process.env.OZ_BUILD_SHA || "development" } = {}) {
  return {
    displayVersion: manifest.displayVersion,
    packageVersion: manifest.packageVersion,
    tag: manifest.gitTag,
    buildSha
  };
}
