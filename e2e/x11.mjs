// Just enough of the X11 core protocol for e2e/linux.mjs to close the app's window the way a user does,
// and to see whether that window is showing. Node's own `net` only, no dependencies.
//
// Why not WebDriver: WebKitWebDriver's "close window" never reaches the app's window (the Tauri app keeps
// running and gets no close request), and under xvfb-run there is no window manager to click a close
// button on, nor one for `wmctrl -c` or `xdotool windowquit` to ask. What a window manager does when the
// close button is clicked is simple, though: it sends the window a WM_PROTOCOLS client message carrying
// WM_DELETE_WINDOW (ICCCM 4.2.8.1). GTK turns that into the window's delete-event, which is exactly the
// close request Tauri reports as CloseRequested. Any X client may send it, so this file does.
//
// The encoding follows "X Window System Protocol, X Version 11" (the core protocol spec): the connection
// setup, and the requests InternAtom (16), QueryTree (15), GetProperty (20), GetWindowAttributes (3),
// SendEvent (25) and GetInputFocus (43, only as a round trip that flushes any error from SendEvent). The
// client says it is little-endian, so the server answers little-endian too.

import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const pad4 = (n) => (4 - (n % 4)) % 4;
const padded = (buf) => Buffer.concat([buf, Buffer.alloc(pad4(buf.length))]);

/** Map states from GetWindowAttributes. */
export const MAP_STATE = ["unmapped", "unviewable", "viewable"];

/**
 * The MIT-MAGIC-COOKIE-1 for display `number` from the Xauthority file (xvfb-run writes one and points
 * XAUTHORITY at it), or null when there is none. The file is a list of entries, every field big-endian:
 * family (2 bytes), then address, display number, auth name and auth data, each a 2-byte length and bytes.
 */
export function xauthCookie(number, file = process.env.XAUTHORITY || join(homedir(), ".Xauthority")) {
  let data;
  try {
    data = readFileSync(file);
  } catch {
    return null;
  }
  const entries = [];
  let at = 0;
  const field = () => {
    const length = data.readUInt16BE(at);
    const value = data.subarray(at + 2, at + 2 + length);
    at += 2 + length;
    return value;
  };
  while (at + 2 <= data.length) {
    at += 2; // family
    field(); // address
    const display = field().toString("latin1");
    const name = field().toString("latin1");
    const cookie = Buffer.from(field());
    if (name === "MIT-MAGIC-COOKIE-1") entries.push({ display, cookie });
  }
  // An entry for this display, else one for any display (an empty number is a wildcard).
  return (entries.find((e) => e.display === number) ?? entries.find((e) => e.display === "") ?? null)?.cookie ?? null;
}

/** Connect to the X server named by DISPLAY (a local one, `:N` or `:N.S`). */
export async function connectX11(display = process.env.DISPLAY ?? "", socketPath = null) {
  const m = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(display);
  if (!m) throw new Error(`DISPLAY is ${JSON.stringify(display)}, not a local X display`);
  const socket = createConnection(socketPath ?? `/tmp/.X11-unix/X${m[1]}`);
  const read = byteReader(socket);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const cookie = xauthCookie(m[1]);
  const authName = cookie ? Buffer.from("MIT-MAGIC-COOKIE-1", "latin1") : Buffer.alloc(0);
  const authData = cookie ?? Buffer.alloc(0);
  const setup = Buffer.alloc(12);
  setup[0] = 0x6c; // "l": least significant byte first
  setup.writeUInt16LE(11, 2); // protocol major version
  setup.writeUInt16LE(0, 4); // protocol minor version
  setup.writeUInt16LE(authName.length, 6);
  setup.writeUInt16LE(authData.length, 8);
  socket.write(Buffer.concat([setup, padded(authName), padded(authData)]));

  // The answer: status (0 failed, 1 success, 2 authenticate), then 8 bytes of header in all three cases,
  // the last two of which give the length of the rest in 4-byte units.
  const head = await read(8);
  const rest = await read(head.readUInt16LE(6) * 4);
  if (head[0] !== 1) {
    socket.destroy();
    const reason = head[0] === 0 ? rest.subarray(0, head[1]).toString("latin1") : rest.toString("latin1").replace(/\0+$/, "");
    throw new Error(`the X server refused the connection: ${reason}`);
  }
  // After the fixed 32 bytes come the vendor string (padded), the pixmap formats (8 bytes each), and then
  // the screens, each starting with its root window.
  const vendorLength = rest.readUInt16LE(16);
  const formats = rest[21];
  const root = rest.readUInt32LE(32 + vendorLength + pad4(vendorLength) + 8 * formats);

  let sequence = 0;
  /** Send a request; `body` is everything after the 4-byte header and is padded here. */
  const send = (opcode, data1, body) => {
    const payload = padded(body);
    const header = Buffer.alloc(4);
    header[0] = opcode;
    header[1] = data1;
    header.writeUInt16LE(1 + payload.length / 4, 2);
    socket.write(Buffer.concat([header, payload]));
    sequence = (sequence + 1) & 0xffff;
    return sequence;
  };
  /** Send a request that has a reply and return the whole reply. An error for it, or for an earlier
      request without a reply, is thrown. Events are skipped: this client selects none, so none should come. */
  const request = async (opcode, data1, body) => {
    const expected = send(opcode, data1, body);
    for (;;) {
      const packet = await read(32);
      const seq = packet.readUInt16LE(2);
      if (packet[0] === 0) {
        throw new Error(`X error ${packet[1]} (request ${packet[10]}, value 0x${packet.readUInt32LE(4).toString(16)}, sequence ${seq})`);
      }
      if (packet[0] !== 1) continue; // an event
      const extra = await read(packet.readUInt32LE(4) * 4);
      if (seq === expected) return Buffer.concat([packet, extra]);
    }
  };

  const atoms = new Map();
  const client = {
    root,
    async atom(name) {
      if (!atoms.has(name)) {
        const bytes = Buffer.from(name, "latin1");
        const body = Buffer.alloc(4);
        body.writeUInt16LE(bytes.length, 0);
        const reply = await request(16, 0, Buffer.concat([body, bytes])); // InternAtom, only-if-exists = false
        atoms.set(name, reply.readUInt32LE(8));
      }
      return atoms.get(name);
    },
    async children(window) {
      const reply = await request(15, 0, u32(window)); // QueryTree
      const count = reply.readUInt16LE(16);
      return Array.from({ length: count }, (_, i) => reply.readUInt32LE(32 + 4 * i));
    },
    /** A property's value, or null when the window does not have it. */
    async property(window, name) {
      // GetProperty: delete = false, type = AnyPropertyType (0), from offset 0, up to 4096 bytes.
      const reply = await request(20, 0, Buffer.concat([u32(window), u32(await client.atom(name)), u32(0), u32(0), u32(1024)]));
      if (reply.readUInt32LE(8) === 0) return null;
      const format = reply[1];
      const items = reply.readUInt32LE(16);
      const value = reply.subarray(32, 32 + (items * format) / 8);
      return { format, value, u32s: format === 32 ? Array.from({ length: items }, (_, i) => value.readUInt32LE(4 * i)) : [] };
    },
    /** "unmapped", "unviewable" or "viewable"; throws (BadWindow) when the window no longer exists. */
    async mapState(window) {
      const reply = await request(3, 0, u32(window)); // GetWindowAttributes
      return MAP_STATE[reply[26]] ?? `unknown (${reply[26]})`;
    },
    /** Ask `window` to close, as a window manager does when its close button is clicked. */
    async requestClose(window) {
      const event = Buffer.alloc(32);
      event[0] = 33; // ClientMessage
      event[1] = 32; // format: 32-bit data
      event.writeUInt32LE(window, 4);
      event.writeUInt32LE(await client.atom("WM_PROTOCOLS"), 8);
      event.writeUInt32LE(await client.atom("WM_DELETE_WINDOW"), 12);
      event.writeUInt32LE(0, 16); // CurrentTime
      // SendEvent with propagate = false and an empty event mask: the event goes to the client that created
      // the window (ICCCM 4.2.8). It has no reply, so a round trip after it brings any error back.
      send(25, 0, Buffer.concat([u32(window), u32(0), event]));
      await request(43, 0, Buffer.alloc(0)); // GetInputFocus
    },
    close() {
      socket.destroy();
    },
  };
  return client;
}

/**
 * The top-level windows that take close requests (WM_DELETE_WINDOW in their WM_PROTOCOLS), with their
 * title, process (_NET_WM_PID) and map state. Without a window manager, top-level windows are the root's
 * own children.
 */
export async function closableWindows(x) {
  const deleteWindow = await x.atom("WM_DELETE_WINDOW");
  const found = [];
  for (const id of await x.children(x.root)) {
    let protocols;
    try {
      protocols = await x.property(id, "WM_PROTOCOLS");
    } catch {
      continue; // gone meanwhile
    }
    if (!protocols?.u32s.includes(deleteWindow)) continue;
    const name = (await x.property(id, "_NET_WM_NAME")) ?? (await x.property(id, "WM_NAME"));
    const pid = await x.property(id, "_NET_WM_PID");
    found.push({
      id,
      name: name ? name.value.toString("utf8") : null,
      pid: pid?.u32s[0] ?? null,
      mapState: await x.mapState(id),
    });
  }
  return found;
}

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

/** `read(n)` resolves with the next `n` bytes from the socket, in order; one read at a time. */
function byteReader(socket) {
  let buffered = Buffer.alloc(0);
  let failure = null;
  let waiting = null;
  const pump = () => {
    if (!waiting) return;
    if (buffered.length >= waiting.n) {
      const out = Buffer.from(buffered.subarray(0, waiting.n));
      buffered = buffered.subarray(waiting.n);
      const { resolve } = waiting;
      waiting = null;
      resolve(out);
    } else if (failure) {
      const { reject } = waiting;
      waiting = null;
      reject(failure);
    }
  };
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    pump();
  });
  socket.on("error", (e) => {
    failure = e;
    pump();
  });
  socket.on("close", () => {
    failure ??= new Error("the X server closed the connection");
    pump();
  });
  return (n) =>
    new Promise((resolve, reject) => {
      if (waiting) return reject(new Error("x11: a read is already waiting"));
      waiting = { n, resolve, reject };
      pump();
    });
}
