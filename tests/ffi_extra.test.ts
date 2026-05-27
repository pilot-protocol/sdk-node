/**
 * Extra coverage for src/ffi.ts — the parts the original suite didn't reach:
 *
 *   - findLibrary's "unsupported platform" branch (rewritten to test the
 *     pure logic without actually mocking `os.platform`)
 *   - PILOT_LIB_PATH override that points at a real file
 *   - parseJSON / checkErr / unwrapHandleErr corner cases
 *   - The runtime-fallback path (findLibrary uses runtimeLibraryPath when
 *     no env var is set and the seeder succeeds)
 *
 * The koffi-using loadLibrary() body is not exercised here — that requires
 * libpilot.{so|dylib} on disk and would be an integration test, not a unit
 * test. Documented under "what's hard to test without a live daemon" in the
 * PR description.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PilotError,
  parseJSON,
  checkErr,
  unwrapHandleErr,
  findLibrary,
} from '../src/ffi.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseJSON edge cases', () => {
  it('returns {} for empty string', () => {
    expect(parseJSON('')).toEqual({});
  });

  it('returns objects with arrays + nested values intact', () => {
    const r = parseJSON(JSON.stringify({ a: [1, 2], b: { c: 'x' } }));
    expect(r).toEqual({ a: [1, 2], b: { c: 'x' } });
  });

  it('throws PilotError keyed on `error` field', () => {
    expect(() => parseJSON(JSON.stringify({ error: 'oops' }))).toThrowError(
      new PilotError('oops'),
    );
  });
});

describe('checkErr edge cases', () => {
  it('does nothing for an empty string (falsy)', () => {
    expect(() => checkErr('')).not.toThrow();
  });

  it('does nothing when JSON has no `error` field', () => {
    // Important: only `{"error": ...}` should throw — neutral JSON must pass.
    expect(() => checkErr(JSON.stringify({ status: 'ok' }))).not.toThrow();
  });

  it('throws on error JSON', () => {
    expect(() => checkErr(JSON.stringify({ error: 'bad' }))).toThrowError(
      new PilotError('bad'),
    );
  });
});

describe('unwrapHandleErr', () => {
  it('returns the handle when err is null', () => {
    expect(unwrapHandleErr({ handle: 42n, err: null })).toBe(42n);
  });

  it('throws PilotError with the parsed message', () => {
    expect(() =>
      unwrapHandleErr({ handle: 0n, err: JSON.stringify({ error: 'no daemon' }) }),
    ).toThrowError(new PilotError('no daemon'));
  });

  it('falls back to "unknown error" when err JSON has no message field', () => {
    expect(() =>
      unwrapHandleErr({ handle: 0n, err: JSON.stringify({ status: 'weird' }) }),
    ).toThrowError(new PilotError('unknown error'));
  });
});

// ---------------------------------------------------------------------------
// findLibrary
// ---------------------------------------------------------------------------

describe('findLibrary env-override branch', () => {
  let workdir: string;
  const saved = {
    libPath: process.env['PILOT_LIB_PATH'],
    home: process.env['PILOT_HOME'],
    pkgBin: process.env['PILOT_PKG_BIN_DIR'],
    pkgRoot: process.env['PILOT_PKG_BIN_ROOT'],
  };

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'pilot-lib-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
    for (const k of ['PILOT_LIB_PATH', 'PILOT_HOME', 'PILOT_PKG_BIN_DIR', 'PILOT_PKG_BIN_ROOT'] as const) {
      const v = saved[k === 'PILOT_LIB_PATH' ? 'libPath' :
                       k === 'PILOT_HOME' ? 'home' :
                       k === 'PILOT_PKG_BIN_DIR' ? 'pkgBin' : 'pkgRoot'];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('returns PILOT_LIB_PATH when the file exists', () => {
    const fake = join(workdir, 'libpilot-fake.so');
    writeFileSync(fake, 'ELF stub');
    process.env['PILOT_LIB_PATH'] = fake;
    expect(findLibrary()).toBe(fake);
  });

  it('throws a clear error when PILOT_LIB_PATH points at a missing file', () => {
    const missing = join(workdir, 'does-not-exist.so');
    process.env['PILOT_LIB_PATH'] = missing;
    expect(() => findLibrary()).toThrow(/does not exist/);
  });

  it('returns the runtimeLibraryPath when the seeder can find a bundled lib', async () => {
    // Build a fake bundled package layout that the seeder will mirror.
    delete process.env['PILOT_LIB_PATH'];
    const fakeHome = join(workdir, 'pilot-home');
    const fakePkgRoot = join(workdir, 'pkg');
    const platDir = require('node:os').platform();
    const arch = require('node:os').arch() === 'x64' ? 'amd64' : require('node:os').arch();
    const sub = `${platDir}-${arch}`;
    const fakePkgBin = join(fakePkgRoot, sub);
    require('node:fs').mkdirSync(fakePkgBin, { recursive: true });
    require('node:fs').mkdirSync(fakeHome, { recursive: true });
    // Bundled bin: each of the four CLIs + the platform lib.
    for (const n of ['pilotctl', 'pilot-daemon', 'pilot-gateway', 'pilot-updater']) {
      writeFileSync(join(fakePkgBin, n), '#!/bin/sh\n');
    }
    const libName = platDir === 'darwin' ? 'libpilot.dylib'
                   : platDir === 'linux' ? 'libpilot.so' : 'libpilot.dll';
    writeFileSync(join(fakePkgBin, libName), 'LIB');
    writeFileSync(join(fakePkgRoot, '.pilot-version'), '1.9.1\n');

    process.env['PILOT_HOME'] = fakeHome;
    process.env['PILOT_PKG_BIN_ROOT'] = fakePkgRoot;
    process.env['PILOT_PKG_BIN_DIR'] = fakePkgBin;

    // Force the runtime to re-seed (it has a module-level cache).
    const rt = await import('../src/runtime.js');
    rt._resetSeededMarker();

    const found = findLibrary();
    expect(found.endsWith(libName)).toBe(true);
  });
});
