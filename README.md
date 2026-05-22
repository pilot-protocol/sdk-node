# Pilot Protocol — Node.js SDK

[![ci](https://github.com/pilot-protocol/sdk-node/actions/workflows/ci.yml/badge.svg)](https://github.com/pilot-protocol/sdk-node/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/pilot-protocol/sdk-node/branch/main/graph/badge.svg)](https://codecov.io/gh/pilot-protocol/sdk-node)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

[![npm version](https://img.shields.io/npm/v/pilotprotocol)](https://www.npmjs.com/package/pilotprotocol)
[![Node](https://img.shields.io/node/v/pilotprotocol)](https://www.npmjs.com/package/pilotprotocol)

Node.js / TypeScript client for the [Pilot Protocol](https://pilotprotocol.network) overlay network. Gives AI agents and services permanent addresses, encrypted peer-to-peer channels, and a mutual-trust model.

The SDK talks to a local `pilot-daemon` over a Unix domain socket through a pre-built `libpilot` shared library (`.dylib` / `.so` / `.dll`) shipped in platform-specific optional dependencies.

## Install

```bash
npm install pilotprotocol
```

The matching native bundle (`pilotprotocol-darwin-arm64`, `pilotprotocol-linux-x64`, etc.) is pulled automatically via `optionalDependencies`. The `pilotctl`, `pilot-daemon`, `pilot-gateway`, and `pilot-updater` CLIs are exposed as `bin` entries.

Supported platforms: macOS (arm64, x64), Linux (arm64, x64). Windows support is experimental.

## Quick start

Make sure a daemon is running:

```bash
npx pilotctl daemon start --hostname my-agent
```

Then, from your code:

```ts
import { Driver } from 'pilotprotocol';

const driver = new Driver();
try {
  const info = driver.info();
  console.log(`address=${info.address}`);

  driver.setHostname('my-node-agent');

  const peer = driver.resolveHostname('other-agent');
  const conn = driver.dial(`${peer.address}:1000`);
  try {
    conn.write(Buffer.from('hello'));
    const data = conn.read(4096);
    console.log(data.toString());
  } finally {
    conn.close();
  }
} finally {
  driver.close();
}
```

More examples live in [`examples/`](examples/): basic info, echo service, stream client/server, datagrams, messaging.

## API surface

- `Driver` — connection to the local daemon. Methods: `info`, `setHostname`, `setVisibility`, `setTags`, `resolveHostname`, `handshake`, `approveHandshake`, `dial`, `listen`, `sendTo`, `recvFrom`.
- `Conn` — bidirectional stream returned by `dial`/`Listener.accept`. Methods: `read`, `write`, `close`.
- `Listener` — server-side stream listener returned by `listen`. Methods: `accept`, `close`.
- `PilotError` — thrown for any daemon-side error.

Full type definitions ship with the package (`dist/index.d.ts`).

## Native library

Each platform package ships a pre-built `libpilot` shared library. The SDK loads it through [`koffi`](https://github.com/Koromix/koffi) FFI. Override the lookup path with `PILOT_LIB_PATH=/abs/path/to/libpilot.dylib` if you bring your own build.

## Links

- Homepage: <https://pilotprotocol.network>
- Issues: <https://github.com/pilot-protocol/sdk-node/issues>
- Python SDK: [`pilotprotocol`](https://pypi.org/project/pilotprotocol/) on PyPI
- Swift SDK: [`sdk-swift`](https://github.com/pilot-protocol/sdk-swift)

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
