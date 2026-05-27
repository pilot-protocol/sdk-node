/**
 * Smoke test for the package's public re-export surface (src/index.ts).
 *
 * These assertions exist so that renaming or removing a public export
 * shows up as a CI failure rather than a silent breaking change for SDK
 * consumers.
 */

import { describe, expect, it } from 'vitest';
import * as pub from '../src/index.js';

describe('public re-exports', () => {
  it('Driver / Conn / Listener / PilotError are exported', () => {
    expect(typeof pub.Driver).toBe('function');
    expect(typeof pub.Conn).toBe('function');
    expect(typeof pub.Listener).toBe('function');
    expect(typeof pub.PilotError).toBe('function');
  });

  it('exposes DEFAULT_SOCKET_PATH', () => {
    expect(pub.DEFAULT_SOCKET_PATH).toBe('/tmp/pilot.sock');
  });

  it('exposes findLibrary and loadLibrary helpers', () => {
    expect(typeof pub.findLibrary).toBe('function');
    expect(typeof pub.loadLibrary).toBe('function');
  });

  it('PilotError instances satisfy instanceof', () => {
    const e = new pub.PilotError('hi');
    expect(e).toBeInstanceOf(pub.PilotError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('PilotError');
    expect(e.message).toBe('hi');
  });
});
