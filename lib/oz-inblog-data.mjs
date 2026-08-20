import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveOzDataPaths({ env = process.env, home = os.homedir() } = {}) {
  const root = path.resolve(env.OZ_DATA_DIR || path.join(home, "Library", "Application Support", "oz-inblog", "data"));
  return {
    root,
    sessions: path.join(root, "sessions"),
    debug: path.join(root, "debug")
  };
}

export function createSecureDataDirectories(paths) {
  for (const directory of [paths.root, paths.sessions, paths.debug]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  return paths;
}
