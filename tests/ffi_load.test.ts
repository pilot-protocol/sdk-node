/**
 * Unit coverage for the loadLibrary() body — the part of src/ffi.ts the other
 * suites skip because it needs koffi and a real .so/.dylib on disk.
 *
 * koffi is mocked, so the assertions here are about the wrapper layer:
 * which symbols get declared, and whether every pointer handed back by the
 * library is released.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// koffi mock
// ---------------------------------------------------------------------------

/** Names passed to lib.func(), in declaration order. */
const declared: string[] = [];
/** Pointers passed to the FreeString stub. */
const freed: unknown[] = [];
/** Return value the PilotConnRead stub hands back on the next call. */
let connReadResult: { n: number; data: unknown; err: unknown } = {
  n: 0,
  data: null,
  err: null,
};

vi.mock('koffi', () => {
  const struct = (name: string) => name;
  const decode = (ptr: unknown, type: string, len: number) => {
    if (type === 'uint8') return Array.from({ length: len }, (_, i) => i + 1);
    return String(ptr);
  };
  const load = () => ({
    func(name: string) {
      declared.push(name);
      if (name === 'FreeString') {
        return (ptr: unknown) => {
          freed.push(ptr);
        };
      }
      if (name === 'PilotConnRead') return () => connReadResult;
      return () => null;
    },
  });
  return { default: { struct, decode, load }, struct, decode, load };
});

const { loadLibrary } = await import('../src/ffi.js');

beforeEach(() => {
  declared.length = 0;
  freed.length = 0;
  connReadResult = { n: 0, data: null, err: null };
});

// ---------------------------------------------------------------------------
// Symbol declarations
// ---------------------------------------------------------------------------

describe('loadLibrary symbol declarations', () => {
  it('declares FreeString and the lifecycle entry points', () => {
    loadLibrary('/does/not/matter.so');
    expect(declared).toContain('FreeString');
    expect(declared).toContain('PilotConnect');
    expect(declared).toContain('PilotConnRead');
  });

  it('declares no symbol twice', () => {
    loadLibrary('/does/not/matter.so');
    expect(new Set(declared).size).toBe(declared.length);
  });
});

// ---------------------------------------------------------------------------
// PilotConnRead pointer ownership
// ---------------------------------------------------------------------------

describe('PilotConnRead pointer handling', () => {
  it('decodes and frees a non-empty read', () => {
    const ptr = { tag: 'data' };
    connReadResult = { n: 3, data: ptr, err: null };
    const lib = loadLibrary('/does/not/matter.so');
    const res = lib.PilotConnRead(1n, 4096);
    expect(res.n).toBe(3);
    expect(res.data).toEqual(Buffer.from([1, 2, 3]));
    expect(freed).toContain(ptr);
  });

  it('frees the buffer of a zero-length read', () => {
    // The library allocates its return buffer unconditionally, so a
    // zero-length read still hands back a pointer we own.
    const ptr = { tag: 'empty' };
    connReadResult = { n: 0, data: ptr, err: null };
    const lib = loadLibrary('/does/not/matter.so');
    const res = lib.PilotConnRead(1n, 4096);
    expect(res.n).toBe(0);
    expect(res.data).toBeNull();
    expect(freed).toContain(ptr);
  });

  it('frees nothing when the library returns a null pointer', () => {
    connReadResult = { n: 0, data: null, err: null };
    const lib = loadLibrary('/does/not/matter.so');
    const res = lib.PilotConnRead(1n, 4096);
    expect(res.data).toBeNull();
    expect(freed).toHaveLength(0);
  });

  it('frees the error string alongside the data buffer', () => {
    const dataPtr = { tag: 'data' };
    const errPtr = { tag: 'err' };
    connReadResult = { n: 0, data: dataPtr, err: errPtr };
    const lib = loadLibrary('/does/not/matter.so');
    lib.PilotConnRead(1n, 4096);
    expect(freed).toContain(errPtr);
    expect(freed).toContain(dataPtr);
  });
});
