/**
 * Registry loader — reads the local manifest, exposes lookup + filter helpers.
 *
 * The local manifest at registry/manifest.json ships with the runtime
 * and covers the curated 80% of extensions (~15 entries today). v2 adds
 * a remote refresh from registry_url (claw.articul8.ai/registry.json)
 * that overlays / supplements local entries; tenant-scoped overrides
 * land on top of remote.
 *
 * Loader is sync because the manifest is a small static file shipped in
 * the repo. The result is cached for the lifetime of the process — call
 * `_resetForTests()` to invalidate during unit tests.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type { RegistryEntry, RegistryManifest } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Locate the manifest. `__dirname` is `dist/registry` after build,
 * `src/registry` in dev. The manifest itself lives at repo-root/registry/
 * regardless, so we walk up one to the package root.
 */
function defaultManifestPath(): string {
  return path.resolve(__dirname, '..', '..', 'registry', 'manifest.json');
}

let _cached: RegistryManifest | null = null;
let _cachedPath: string | null = null;

export function loadRegistry(manifestPath?: string): RegistryManifest {
  const resolved = manifestPath ?? defaultManifestPath();
  if (_cached && _cachedPath === resolved) return _cached;
  const raw = fs.readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(raw) as RegistryManifest;
  _cached = parsed;
  _cachedPath = resolved;
  return parsed;
}

export function _resetForTests(): void {
  _cached = null;
  _cachedPath = null;
}

export function findEntry(id: string, manifest?: RegistryManifest): RegistryEntry | undefined {
  const m = manifest ?? loadRegistry();
  return m.entries.find((e) => e.id === id);
}

export function findByName(query: string, manifest?: RegistryManifest): RegistryEntry[] {
  const m = manifest ?? loadRegistry();
  const q = query.toLowerCase();
  return m.entries.filter(
    (e) => e.id.toLowerCase().includes(q) || e.name.toLowerCase().includes(q) || (e.tags ?? []).some((t) => t.toLowerCase().includes(q)),
  );
}

export function entriesByCategory(manifest?: RegistryManifest): Map<string, RegistryEntry[]> {
  const m = manifest ?? loadRegistry();
  const out = new Map<string, RegistryEntry[]>();
  for (const e of m.entries) {
    const list = out.get(e.category) ?? [];
    list.push(e);
    out.set(e.category, list);
  }
  return out;
}

export function entriesByType(type: RegistryEntry['type'], manifest?: RegistryManifest): RegistryEntry[] {
  const m = manifest ?? loadRegistry();
  return m.entries.filter((e) => e.type === type);
}
