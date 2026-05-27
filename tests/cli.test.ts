/**
 * Tests for src/cli.ts — the four shim entry points wired up to
 * `bin-stubs/*.js`. Each shim:
 *   1. Seeds ~/.pilot/bin/ (via runtime).
 *   2. Resolves the seeded binary path.
 *   3. spawnSync's it with stdio: 'inherit' and process.exit's with the
 *      child's status.
 *
 * We mock node:child_process at module level (vi.mock hoists), substitute a
 * controllable spawnSync, and replace process.exit with a thrower so the
 * runner doesn't actually exit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { platform as osPlatform, arch as osArch } from 'node:os';
import { join } from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

// vi.mock is hoisted above all imports; the mocked module is what the cli
// shim sees when it does `import { spawnSync } from 'node:child_process'`.
// vi.hoisted is the canonical way to share a variable with a hoisted mock.
const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

import * as cli from '../src/cli.js';
import * as runtime from '../src/runtime.js';

const PLAT = osPlatform();
const ARCH = osArch() === 'x64' ? 'amd64' : osArch();
const PLAT_DIR = `${PLAT}-${ARCH}`;
const LIB_NAME = PLAT === 'darwin' ? 'libpilot.dylib'
                : PLAT === 'linux' ? 'libpilot.so'
                : 'libpilot.dll';

let tmpRoot: string;
let fakeHome: string;
let pkgRoot: string;
let pkgBin: string;
const savedEnv = {
  home: process.env['PILOT_HOME'],
  pkgRoot: process.env['PILOT_PKG_BIN_ROOT'],
  pkgBin: process.env['PILOT_PKG_BIN_DIR'],
};
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = mkdtempSync('/tmp/pilot-cli-');
  fakeHome = join(tmpRoot, '.pilot');
  pkgRoot = join(tmpRoot, 'pkg');
  pkgBin = join(pkgRoot, PLAT_DIR);
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(pkgBin, { recursive: true });
  for (const n of ['pilotctl', 'pilot-daemon', 'pilot-gateway', 'pilot-updater']) {
    writeFileSync(join(pkgBin, n), '#!/bin/sh\necho ' + n + '\n');
    chmodSync(join(pkgBin, n), 0o755);
  }
  writeFileSync(join(pkgBin, LIB_NAME), 'LIB');
  writeFileSync(join(pkgRoot, '.pilot-version'), '1.9.1\n');
  process.env['PILOT_HOME'] = fakeHome;
  process.env['PILOT_PKG_BIN_ROOT'] = pkgRoot;
  process.env['PILOT_PKG_BIN_DIR'] = pkgBin;
  runtime._resetSeededMarker();
  spawnSyncMock.mockReset();

  // Intercept process.exit so the runner doesn't die.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__exit__:${code ?? 0}`);
  }) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
  if (savedEnv.home === undefined) delete process.env['PILOT_HOME'];
  else process.env['PILOT_HOME'] = savedEnv.home;
  if (savedEnv.pkgRoot === undefined) delete process.env['PILOT_PKG_BIN_ROOT'];
  else process.env['PILOT_PKG_BIN_ROOT'] = savedEnv.pkgRoot;
  if (savedEnv.pkgBin === undefined) delete process.env['PILOT_PKG_BIN_DIR'];
  else process.env['PILOT_PKG_BIN_DIR'] = savedEnv.pkgBin;
  rmSync(tmpRoot, { recursive: true, force: true });
  runtime._resetSeededMarker();
});

function fakeOk(): SpawnSyncReturns<Buffer> {
  return {
    status: 0,
    error: undefined as unknown as Error,
    pid: 0,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    signal: null,
  };
}

function fakeNonzero(code: number): SpawnSyncReturns<Buffer> {
  return { ...fakeOk(), status: code };
}

function fakeErr(): SpawnSyncReturns<Buffer> {
  return { ...fakeOk(), status: null, error: new Error('ENOENT') };
}

describe('cli shims', () => {
  for (const [fn, name] of [
    [cli.runPilotctl, 'pilotctl'],
    [cli.runDaemon, 'pilot-daemon'],
    [cli.runGateway, 'pilot-gateway'],
    [cli.runUpdater, 'pilot-updater'],
  ] as const) {
    it(`runs ${name} via the seeded binary and exits with status 0`, () => {
      spawnSyncMock.mockImplementation((binary: string, _args: string[], opts: { stdio: unknown }) => {
        expect(binary.endsWith(name)).toBe(true);
        expect(opts.stdio).toBe('inherit');
        return fakeOk();
      });
      expect(() => fn()).toThrow(/__exit__:0/);
      expect(spawnSyncMock).toHaveBeenCalled();
    });

    it(`propagates a non-zero status from ${name}`, () => {
      spawnSyncMock.mockImplementation(() => fakeNonzero(2));
      expect(() => fn()).toThrow(/__exit__:2/);
    });

    it(`defaults to exit code 1 when status is null and no error`, () => {
      spawnSyncMock.mockImplementation(() => ({ ...fakeOk(), status: null }));
      expect(() => fn()).toThrow(/__exit__:1/);
    });

    it(`exits 1 when spawnSync fails to launch ${name}`, () => {
      spawnSyncMock.mockImplementation(() => fakeErr());
      const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        expect(() => fn()).toThrow(/__exit__:1/);
        const msg = String(writeSpy.mock.calls[0]?.[0] ?? '');
        expect(msg).toContain(name);
        expect(msg).toContain('failed to launch');
      } finally {
        writeSpy.mockRestore();
      }
    });
  }
});
