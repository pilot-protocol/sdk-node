/**
 * Non-mocked FFI smoke test.
 *
 * Every other suite substitutes a fake library object, so a binding that
 * names a symbol libpilot no longer exports still passes. This file calls
 * the real `loadLibrary()` against a real libpilot build, which is what
 * catches drift between the two repos: koffi's `lib.func()` throws as soon
 * as a declared symbol is missing, so a single successful load proves every
 * binding resolves.
 *
 * Library discovery order:
 *   1. PILOT_LIB_PATH
 *   2. a sibling libpilot/ checkout next to this repo
 *   3. ~/.pilot/bin/
 *
 * Skips when no library is found, unless PILOT_REQUIRE_LIB=1 (CI sets it
 * after building libpilot from source, so a missing build fails there).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadLibrary } from '../src/ffi.js';

const LIB_NAMES: Record<string, string> = {
  darwin: 'libpilot.dylib',
  linux: 'libpilot.so',
  win32: 'libpilot.dll',
};

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

function locateLibrary(): string | null {
  const envPath = process.env['PILOT_LIB_PATH'];
  if (envPath) return existsSync(envPath) ? envPath : null;

  const libName = LIB_NAMES[platform()];
  if (!libName) return null;

  const candidates = [
    resolve(repoRoot, '..', 'libpilot', libName),
    join(homedir(), '.pilot', 'bin', libName),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const libPath = locateLibrary();
const required = process.env['PILOT_REQUIRE_LIB'] === '1';

if (!libPath && required) {
  throw new Error(
    'PILOT_REQUIRE_LIB=1 but no libpilot found; set PILOT_LIB_PATH or build ' +
      'it in a sibling libpilot/ checkout',
  );
}

describe.skipIf(!libPath)('loadLibrary against a real libpilot', () => {
  it('resolves every declared symbol', () => {
    // koffi throws on the first symbol it cannot find, so reaching the end
    // of loadLibrary() means the whole binding list is live.
    const lib = loadLibrary(libPath as string);
    expect(lib).toBeTruthy();
    expect(typeof lib.PilotConnect).toBe('function');
    expect(typeof lib.PilotConnRead).toBe('function');
  });

  it('declares no symbol that is absent from src/ffi.ts', () => {
    // Guards the inverse direction: a wrapper key with no matching
    // lib.func() declaration would be undefined at call time.
    const lib = loadLibrary(libPath as string);
    const src = readFileSync(join(repoRoot, 'src', 'ffi.ts'), 'utf8');
    const declaredSymbols = new Set(
      [...src.matchAll(/lib\.func\('([A-Za-z0-9_]+)'/g)].map((m) => m[1] as string),
    );
    expect(declaredSymbols.size).toBeGreaterThan(0);

    const missing = Object.keys(lib).filter(
      (key) => typeof (lib as Record<string, unknown>)[key] !== 'function',
    );
    expect(missing).toEqual([]);
  });
});
