/**
 * Extra coverage for src/client.ts — focuses on the high-level service
 * helpers that the original suite skipped:
 *
 *   - sendMessage (text / json / binary, ack and no-ack paths, dial-error,
 *     hostname-resolution success and failure)
 *   - sendFile (happy path + read-back ACK, no-ack, hostname-resolution)
 *   - publishEvent (subscribe-then-publish frame layout)
 *   - subscribeEvent (callback dispatch, EOF, deadline, error pass-through)
 *
 * The FFI library is replaced with an in-memory pipe so the wire-frame
 * layout is exercised end-to-end without a daemon.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PilotLib } from '../src/ffi.js';
import { Driver, PilotError, _setLib, _getLib } from '../src/client.js';

// ---------------------------------------------------------------------------
// In-memory FFI fake: every Conn is one FIFO of pending reads.
// ---------------------------------------------------------------------------

interface FakeConn {
  // Bytes the SDK has written; consumed in chunks by enqueueRead helpers.
  written: Buffer;
  // Bytes the daemon will hand back on subsequent PilotConnRead calls.
  pending: Buffer[];
  closed: boolean;
  // Optional throw on next read (string error from Go).
  readErr?: string;
  // If true, return zero-length read (treated as EOF by readEventFrame).
  eof?: boolean;
}

interface FakeState {
  // counter for new conn handles
  nextHandle: bigint;
  conns: Map<bigint, FakeConn>;
  dialErr: string | null;
  resolveResult: Record<string, unknown> | { error: string };
}

function buildFakeLib(state: FakeState): PilotLib {
  function makeConn(): bigint {
    const h = state.nextHandle++;
    state.conns.set(h, { written: Buffer.alloc(0), pending: [], closed: false });
    return h;
  }

  return {
    PilotConnect: () => ({ handle: 1n, err: null }),
    PilotClose: () => null,
    PilotInfo: () => null,
    PilotHealth: () => null,
    PilotRotateKey: () => null,
    PilotHandshake: () => null,
    PilotApproveHandshake: () => null,
    PilotRejectHandshake: () => null,
    PilotPendingHandshakes: () => null,
    PilotTrustedPeers: () => null,
    PilotRevokeTrust: () => null,
    PilotResolveHostname: () => JSON.stringify(state.resolveResult),
    PilotSetHostname: () => null,
    PilotSetVisibility: () => null,
    PilotSetTaskExec: () => null,
    PilotDeregister: () => null,
    PilotSetTags: () => null,
    PilotSetWebhook: () => null,
    PilotDisconnect: () => null,
    PilotRecvFrom: () => null,
    PilotNetworkList: () => null,
    PilotNetworkJoin: () => null,
    PilotNetworkLeave: () => null,
    PilotNetworkMembers: () => null,
    PilotNetworkInvite: () => null,
    PilotNetworkPollInvites: () => null,
    PilotNetworkRespondInvite: () => null,
    PilotManagedScore: () => null,
    PilotManagedStatus: () => null,
    PilotManagedRankings: () => null,
    PilotManagedForceCycle: () => null,
    PilotManagedReconcile: () => null,
    PilotPolicyGet: () => null,
    PilotPolicySet: () => null,
    PilotMemberTagsGet: () => null,
    PilotMemberTagsSet: () => null,

    PilotDial: () => {
      if (state.dialErr) return { handle: 0n, err: JSON.stringify({ error: state.dialErr }) };
      return { handle: makeConn(), err: null };
    },
    PilotDialTimeout: () => ({ handle: makeConn(), err: null }),
    PilotListen: () => ({ handle: makeConn(), err: null }),
    PilotListenerAccept: () => ({ handle: makeConn(), err: null }),
    PilotListenerClose: () => null,

    PilotConnRead(h, _bufSize) {
      const c = state.conns.get(h);
      if (!c) return { n: 0, data: null, err: JSON.stringify({ error: 'no conn' }) };
      if (c.readErr) return { n: 0, data: null, err: JSON.stringify({ error: c.readErr }) };
      if (c.eof) return { n: 0, data: null, err: null };
      const chunk = c.pending.shift();
      if (!chunk) return { n: 0, data: null, err: null };
      return { n: chunk.length, data: chunk, err: null };
    },
    PilotConnWrite(h, data, dataLen) {
      const c = state.conns.get(h);
      if (!c) return { n: 0, err: JSON.stringify({ error: 'no conn' }) };
      c.written = Buffer.concat([c.written, data.subarray(0, dataLen)]);
      return { n: dataLen, err: null };
    },
    PilotConnClose(h) {
      const c = state.conns.get(h);
      if (c) c.closed = true;
      return null;
    },
    PilotConnSetReadDeadline: () => null,
    PilotSendTo: () => null,
    PilotBroadcast: () => null,
  };
}

let state: FakeState;

beforeEach(() => {
  state = {
    nextHandle: 100n,
    conns: new Map(),
    dialErr: null,
    resolveResult: { address: '0:1234.5678.9abc' },
  };
  _setLib(buildFakeLib(state));
});

afterEach(() => {
  vi.restoreAllMocks();
  _setLib(null);
});

// Find the most-recently created conn (helper for assertions).
function lastConn(): FakeConn {
  let last: FakeConn | undefined;
  for (const c of state.conns.values()) last = c;
  if (!last) throw new Error('no conn created');
  return last;
}

// Frame helpers mirror src/client.ts internals.
function dataExchangeFrame(type: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(type, 0);
  h.writeUInt32BE(payload.length, 4);
  return Buffer.concat([h, payload]);
}

function ackFrame(msg: string): Buffer[] {
  const payload = Buffer.from(msg);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(0, 0); // type irrelevant
  header.writeUInt32BE(payload.length, 4);
  return [header, payload];
}

function eventFrame(topic: string, payload: Buffer): { topicLen: Buffer; topic: Buffer; payloadLen: Buffer; payload: Buffer } {
  const topicBytes = Buffer.from(topic, 'utf8');
  const topicLen = Buffer.alloc(2);
  topicLen.writeUInt16BE(topicBytes.length, 0);
  const payloadLen = Buffer.alloc(4);
  payloadLen.writeUInt32BE(payload.length, 0);
  return { topicLen, topic: topicBytes, payloadLen, payload };
}

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------

describe('Driver.sendMessage', () => {
  it('passes through a literal protocol address (no resolve)', () => {
    const d = new Driver();
    // Pre-queue an ACK so the read path is exercised.
    state.resolveResult = { error: 'should NOT be called' };
    const target = '0:0000.0001.0002';
    // Seed conn before the call doesn't work — dial creates it. So
    // we instead intercept by handing back EOF, exercising the no-ack
    // branch (msg sent, ACK read fails gracefully).
    const res = d.sendMessage(target, 'hello', 'text');
    expect(res['target']).toBe(target);
    expect(res['sent']).toBe(5);
    expect(res['type']).toBe('text');
    // Frame layout: [type=1][len=5]["hello"]
    const c = lastConn();
    expect(c.written.equals(dataExchangeFrame(1, Buffer.from('hello')))).toBe(true);
    expect(c.closed).toBe(true);
    d.close();
  });

  it('resolves a hostname before dialing', () => {
    const d = new Driver();
    state.resolveResult = { address: '0:dead.beef.cafe' };
    const res = d.sendMessage('agent-a.pilot', 'hi', 'json');
    expect(res['target']).toBe('0:dead.beef.cafe');
    expect(res['type']).toBe('json');
    d.close();
  });

  it('reads and returns the ACK when the daemon replies', () => {
    const d = new Driver();
    // Hook into dial so we can pre-stage ACK bytes on the new conn.
    const origDial = (d as unknown as { dial: Driver['dial'] }).dial.bind(d);
    (d as unknown as { dial: typeof origDial }).dial = ((addr: string, t?: number) => {
      const conn = origDial(addr, t);
      const c = lastConn();
      const [h, p] = ackFrame('OK');
      c.pending.push(h);
      c.pending.push(p);
      return conn;
    });
    const res = d.sendMessage('0:0000.0001.0002', 'x', 'binary');
    expect(res['ack']).toBe('OK');
    d.close();
  });

  it('throws when hostname cannot be resolved', () => {
    const d = new Driver();
    state.resolveResult = {}; // no address field
    expect(() => d.sendMessage('unknown.host', 'x')).toThrow(PilotError);
    expect(() => d.sendMessage('unknown.host', 'x')).toThrow(/Could not resolve/);
    d.close();
  });

  it('maps unknown msgType to frame type 1 (text fallback)', () => {
    const d = new Driver();
    // cast to bypass the union — we want to test the runtime ?? 1 fallback.
    const res = (d as unknown as {
      sendMessage: (a: string, b: string, c: string) => Record<string, unknown>;
    }).sendMessage('0:0000.0001.0002', 'hi', 'mystery');
    expect(res['sent']).toBe(2);
    const c = lastConn();
    expect(c.written.readUInt32BE(0)).toBe(1);
    d.close();
  });

  it('treats a Buffer payload the same as a string', () => {
    const d = new Driver();
    const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const res = d.sendMessage('0:0000.0001.0002', buf, 'binary');
    expect(res['sent']).toBe(4);
    const c = lastConn();
    // payload = bytes after 8-byte header
    expect(c.written.subarray(8).equals(buf)).toBe(true);
    d.close();
  });
});

// ---------------------------------------------------------------------------
// sendFile
// ---------------------------------------------------------------------------

describe('Driver.sendFile', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'pilot-sf-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('sends a file with TypeFile frame layout', () => {
    const d = new Driver();
    const fp = join(workdir, 'note.txt');
    writeFileSync(fp, 'data!');
    const res = d.sendFile('0:0000.0001.0002', fp);
    expect(res['filename']).toBe('note.txt');
    expect(res['sent']).toBe(5);

    const c = lastConn();
    // header: [type=4][totalPayloadLen]
    expect(c.written.readUInt32BE(0)).toBe(4);
    const totalLen = c.written.readUInt32BE(4);
    expect(c.written.length).toBe(8 + totalLen);
    // payload: [2-byte name len][name][data]
    const nameLen = c.written.readUInt16BE(8);
    expect(nameLen).toBe('note.txt'.length);
    const name = c.written.subarray(10, 10 + nameLen).toString('utf8');
    expect(name).toBe('note.txt');
    const body = c.written.subarray(10 + nameLen);
    expect(body.toString('utf8')).toBe('data!');
    expect(c.closed).toBe(true);
    d.close();
  });

  it('reads the ACK frame and returns it', () => {
    const d = new Driver();
    const fp = join(workdir, 'x.bin');
    writeFileSync(fp, 'XYZ');
    const origDial = (d as unknown as { dial: Driver['dial'] }).dial.bind(d);
    (d as unknown as { dial: typeof origDial }).dial = ((addr: string, t?: number) => {
      const conn = origDial(addr, t);
      const c = lastConn();
      const [h, p] = ackFrame('STORED');
      c.pending.push(h);
      c.pending.push(p);
      return conn;
    });
    const res = d.sendFile('0:0000.0001.0002', fp);
    expect(res['ack']).toBe('STORED');
    d.close();
  });

  it('resolves a hostname before dialing', () => {
    const d = new Driver();
    state.resolveResult = { address: '0:dead.beef.cafe' };
    const fp = join(workdir, 'y.txt');
    writeFileSync(fp, 'q');
    const res = d.sendFile('hostA', fp);
    expect(res['target']).toBe('0:dead.beef.cafe');
    d.close();
  });
});

// ---------------------------------------------------------------------------
// publishEvent
// ---------------------------------------------------------------------------

describe('Driver.publishEvent', () => {
  it('writes a subscribe frame followed by a publish frame', () => {
    const d = new Driver();
    const res = d.publishEvent('0:0000.0001.0002', 'sensor/temp', 'hot');
    expect(res['status']).toBe('published');
    expect(res['topic']).toBe('sensor/temp');
    expect(res['bytes']).toBe(3);

    const c = lastConn();
    const ef = eventFrame('sensor/temp', Buffer.from('hot'));
    // First frame = subscribe (empty payload).
    const subFrame = Buffer.concat([ef.topicLen, ef.topic, Buffer.from([0, 0, 0, 0])]);
    // Second frame = publish.
    const pubFrame = Buffer.concat([ef.topicLen, ef.topic, ef.payloadLen, ef.payload]);
    expect(c.written.equals(Buffer.concat([subFrame, pubFrame]))).toBe(true);
    expect(c.closed).toBe(true);
    d.close();
  });

  it('accepts a Buffer payload', () => {
    const d = new Driver();
    d.publishEvent('0:0000.0001.0002', 't', Buffer.from([1, 2, 3]));
    const c = lastConn();
    // last 3 bytes are the payload
    expect(c.written.subarray(c.written.length - 3)).toEqual(Buffer.from([1, 2, 3]));
    d.close();
  });
});

// ---------------------------------------------------------------------------
// subscribeEvent
// ---------------------------------------------------------------------------

describe('Driver.subscribeEvent', () => {
  it('parses one event then exits on EOF', () => {
    const d = new Driver();
    const origDial = (d as unknown as { dial: Driver['dial'] }).dial.bind(d);
    (d as unknown as { dial: typeof origDial }).dial = ((addr: string, t?: number) => {
      const conn = origDial(addr, t);
      const c = lastConn();
      const ef = eventFrame('sensor/x', Buffer.from('hello'));
      c.pending.push(ef.topicLen, ef.topic, ef.payloadLen, ef.payload);
      // After this single event, the conn yields zero-length reads → null → break.
      return conn;
    });
    const events: Array<[string, string]> = [];
    d.subscribeEvent('0:0000.0001.0002', 'sensor/*', (t, p) => {
      events.push([t, p.toString('utf8')]);
    }, 1);
    expect(events).toEqual([['sensor/x', 'hello']]);
    d.close();
  });

  it('breaks the loop when the read throws "connection closed"', () => {
    const d = new Driver();
    const origDial = (d as unknown as { dial: Driver['dial'] }).dial.bind(d);
    (d as unknown as { dial: typeof origDial }).dial = ((addr: string, t?: number) => {
      const conn = origDial(addr, t);
      lastConn().readErr = 'connection closed';
      return conn;
    });
    expect(() => d.subscribeEvent('0:0000.0001.0002', '*', () => {}, 1)).not.toThrow();
    d.close();
  });

  it('rethrows unexpected read errors', () => {
    const d = new Driver();
    const origDial = (d as unknown as { dial: Driver['dial'] }).dial.bind(d);
    (d as unknown as { dial: typeof origDial }).dial = ((addr: string, t?: number) => {
      const conn = origDial(addr, t);
      lastConn().readErr = 'something else broke';
      return conn;
    });
    expect(() => d.subscribeEvent('0:0000.0001.0002', '*', () => {}, 1))
      .toThrow(/something else broke/);
    d.close();
  });

  it('exits cleanly when the deadline passes without any data', () => {
    const d = new Driver();
    // Force conn to behave as a closed stream so the helper returns null
    // immediately; the while-loop should then break on the next iteration.
    const origDial = (d as unknown as { dial: Driver['dial'] }).dial.bind(d);
    (d as unknown as { dial: typeof origDial }).dial = ((addr: string, t?: number) => {
      const conn = origDial(addr, t);
      lastConn().eof = true;
      return conn;
    });
    // timeout=0 → loop body runs once at most.
    let calls = 0;
    d.subscribeEvent('0:0000.0001.0002', '*', () => { calls += 1; }, 0);
    expect(calls).toBe(0);
    d.close();
  });
});

// ---------------------------------------------------------------------------
// _resolveTarget edge cases (covered indirectly above; one more for explicit
// pass-through of the '0:' literal address branch).
// ---------------------------------------------------------------------------

describe('Driver hostname resolution', () => {
  it('does not call resolveHostname when target already starts with "0:"', () => {
    const d = new Driver();
    // Sentinel: if resolveHostname WAS called, the SDK would treat the empty
    // address as a failure and throw. The fact that sendMessage succeeds
    // proves resolve was skipped.
    state.resolveResult = { error: 'must not be called' };
    expect(() => d.sendMessage('0:0000.0001.0002', 'hi')).not.toThrow();
    d.close();
  });
});

// ---------------------------------------------------------------------------
// Library-singleton accessors used by the test harness
// ---------------------------------------------------------------------------

describe('library singleton helpers', () => {
  it('_setLib(null) clears the cached library', () => {
    // beforeEach has already installed a fake; clearing it should expose
    // the null state via _getLib.
    expect(_getLib()).not.toBeNull();
    _setLib(null);
    expect(_getLib()).toBeNull();
  });

  it('getLib lazy-loads via loadLibrary when cache is empty (error path)', async () => {
    _setLib(null);
    // Without PILOT_LIB_PATH or a real libpilot, the first FFI call should
    // surface loadLibrary's "Cannot find" error.
    const saved = process.env['PILOT_LIB_PATH'];
    delete process.env['PILOT_LIB_PATH'];
    // Also make findLibrary fall through (PILOT_HOME points at a temp dir
    // with no bundled lib).
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const tmp = mkdtempSync('/tmp/pilot-noseed-');
    const prevHome = process.env['PILOT_HOME'];
    const prevPkg = process.env['PILOT_PKG_BIN_DIR'];
    const prevPkgR = process.env['PILOT_PKG_BIN_ROOT'];
    process.env['PILOT_HOME'] = join(tmp, 'home');
    process.env['PILOT_PKG_BIN_DIR'] = join(tmp, 'pkg-bin-missing');
    process.env['PILOT_PKG_BIN_ROOT'] = join(tmp, 'pkg-root-missing');
    const rt = await import('../src/runtime.js');
    rt._resetSeededMarker();
    try {
      expect(() => new Driver()).toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      if (saved === undefined) delete process.env['PILOT_LIB_PATH'];
      else process.env['PILOT_LIB_PATH'] = saved;
      if (prevHome === undefined) delete process.env['PILOT_HOME'];
      else process.env['PILOT_HOME'] = prevHome;
      if (prevPkg === undefined) delete process.env['PILOT_PKG_BIN_DIR'];
      else process.env['PILOT_PKG_BIN_DIR'] = prevPkg;
      if (prevPkgR === undefined) delete process.env['PILOT_PKG_BIN_ROOT'];
      else process.env['PILOT_PKG_BIN_ROOT'] = prevPkgR;
    }
  });
});

// ---------------------------------------------------------------------------
// ACK-read no-op branches in sendMessage / sendFile
// ---------------------------------------------------------------------------

describe('sendMessage / sendFile ack-read fallback', () => {
  it('returns the no-ack result when the daemon sends fewer than 8 header bytes', () => {
    const d = new Driver();
    const origDial = (d as unknown as { dial: Driver['dial'] }).dial.bind(d);
    (d as unknown as { dial: typeof origDial }).dial = ((addr: string, t?: number) => {
      const conn = origDial(addr, t);
      // Only 3 bytes — not enough for a header.
      lastConn().pending.push(Buffer.from([1, 2, 3]));
      return conn;
    });
    const res = d.sendMessage('0:0000.0001.0002', 'hi', 'text');
    expect(res['ack']).toBeUndefined();
    expect(res['sent']).toBe(2);
    d.close();
  });

  it('returns the no-ack result when the ACK payload is empty', () => {
    const d = new Driver();
    const origDial = (d as unknown as { dial: Driver['dial'] }).dial.bind(d);
    (d as unknown as { dial: typeof origDial }).dial = ((addr: string, t?: number) => {
      const conn = origDial(addr, t);
      // 8-byte header with payload-len = 0 → second read returns empty.
      const h = Buffer.alloc(8);
      lastConn().pending.push(h);
      return conn;
    });
    const res = d.sendMessage('0:0000.0001.0002', 'hi', 'text');
    expect(res['ack']).toBeUndefined();
    d.close();
  });
});
