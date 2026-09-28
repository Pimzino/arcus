// A tiny SMTP server for e2e/linux.mjs: it takes every message Arcus sends and keeps it, so the test can
// check what was emailed without a real mail server. Node's own `net` only, no dependencies.
//
// It speaks plain SMTP (no STARTTLS), which is what the app's "None" security setting uses: greeting,
// EHLO/HELO, AUTH PLAIN and AUTH LOGIN (any credentials pass), MAIL, RCPT, DATA, RSET, NOOP and QUIT, with
// several messages per connection and several connections at once. It mirrors the Rust test sink in
// src-tauri/src/email/test_smtp.rs, which the email code's own live test is checked against: lettre only
// signs in when the server lists AUTH in its EHLO answer, so that line matters.
//
//   const sink = await startSmtpSink();
//   // ... point Arcus at 127.0.0.1:sink.port, security None ...
//   const [mail] = await sink.waitFor((m) => m.subject === "Arcus: test email", 30_000);

import { createServer } from "node:net";

/**
 * @typedef {{ mailFrom: string, rcptTo: string[], auth: { username: string, password: string } | null,
 *   data: Buffer, subject: string | null, receivedAt: string }} ReceivedMessage
 */

export async function startSmtpSink() {
  /** @type {ReceivedMessage[]} */
  const messages = [];
  const waiters = new Set();
  const connections = new Set();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    serve(socket, (message) => {
      messages.push(message);
      for (const wake of waiters) wake();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    messages,
    /** The first message matching `test`, waiting up to `timeout` ms for it. */
    waitFor(test, timeout) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = messages.find(test);
          if (!found) return false;
          done();
          resolve(found);
          return true;
        };
        const timer = setTimeout(() => {
          done();
          const got = messages.map((m) => JSON.stringify(m.subject)).join(", ") || "none";
          reject(new Error(`no matching email within ${timeout / 1000}s (received: ${got})`));
        }, timeout);
        const done = () => {
          clearTimeout(timer);
          waiters.delete(check);
        };
        waiters.add(check);
        check();
      });
    },
    close() {
      for (const socket of connections) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function serve(socket, onMessage) {
  let pending = Buffer.alloc(0);
  /** What the next line is: a command, an AUTH continuation, or a line of the message after DATA. */
  let mode = "command";
  let auth = null;
  let loginUser = null;
  let mailFrom = null;
  let rcptTo = [];
  let data = [];
  const reply = (text) => socket.write(`${text}\r\n`);

  const onLine = (raw) => {
    if (mode === "data") {
      // The message ends with a line holding a single dot; a leading dot was doubled by the client
      // (dot-stuffing, RFC 5321 4.5.2).
      if (raw.equals(Buffer.from(".\r\n")) || raw.equals(Buffer.from(".\n"))) {
        const body = Buffer.concat(data);
        onMessage({
          mailFrom: mailFrom ?? "",
          rcptTo,
          auth,
          data: body,
          subject: decodeHeaderValue(header(body, "Subject")),
          receivedAt: new Date().toISOString(),
        });
        mode = "command";
        mailFrom = null;
        rcptTo = [];
        data = [];
        reply("250 2.0.0 OK queued");
      } else {
        data.push(raw[0] === 0x2e && raw[1] === 0x2e ? raw.subarray(1) : raw);
      }
      return;
    }
    const line = raw.toString("utf8").replace(/\r?\n$/, "");
    if (mode === "auth-plain") {
      mode = "command";
      return finishAuth(decodePlain(line));
    }
    if (mode === "auth-login-user") {
      loginUser = Buffer.from(line, "base64").toString("utf8");
      mode = "auth-login-pass";
      return reply("334 UGFzc3dvcmQ6");
    }
    if (mode === "auth-login-pass") {
      mode = "command";
      return finishAuth({ username: loginUser ?? "", password: Buffer.from(line, "base64").toString("utf8") });
    }
    const [verb = "", ...args] = line.split(" ");
    switch (verb.toUpperCase()) {
      case "EHLO":
        return reply("250-arcus-e2e-smtp\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SIZE 52428800");
      case "HELO":
        return reply("250 arcus-e2e-smtp");
      case "AUTH": {
        const mechanism = (args[0] ?? "").toUpperCase();
        if (mechanism === "PLAIN") {
          if (args[1]) return finishAuth(decodePlain(args[1]));
          mode = "auth-plain";
          return reply("334 ");
        }
        if (mechanism === "LOGIN") {
          if (args[1]) {
            loginUser = Buffer.from(args[1], "base64").toString("utf8");
            mode = "auth-login-pass";
            return reply("334 UGFzc3dvcmQ6");
          }
          mode = "auth-login-user";
          return reply("334 VXNlcm5hbWU6");
        }
        return reply("504 5.5.4 Unrecognized authentication type");
      }
      case "MAIL":
        mailFrom = angleAddress(line);
        rcptTo = [];
        return reply("250 2.1.0 OK");
      case "RCPT":
        if (mailFrom === null) return reply("503 5.5.1 MAIL first");
        rcptTo.push(angleAddress(line));
        return reply("250 2.1.5 OK");
      case "DATA":
        if (mailFrom === null || rcptTo.length === 0) return reply("503 5.5.1 RCPT first");
        mode = "data";
        return reply("354 End data with <CR><LF>.<CR><LF>");
      case "RSET":
        mailFrom = null;
        rcptTo = [];
        return reply("250 2.0.0 OK");
      case "NOOP":
        return reply("250 2.0.0 OK");
      case "QUIT":
        reply("221 2.0.0 Bye");
        return socket.end();
      default:
        return reply("502 5.5.2 Command not recognized");
    }
  };

  const finishAuth = (credentials) => {
    if (!credentials) return reply("501 5.5.2 Cannot decode response");
    auth = credentials;
    reply("235 2.7.0 Authentication successful");
  };

  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (let end = pending.indexOf(0x0a); end >= 0; end = pending.indexOf(0x0a)) {
      const raw = pending.subarray(0, end + 1);
      pending = pending.subarray(end + 1);
      onLine(Buffer.from(raw));
    }
  });
  // A client that hangs up mid-message leaves nothing half-received behind; errors end that connection only.
  socket.on("error", () => socket.destroy());
  reply("220 arcus-e2e-smtp ESMTP ready");
}

/** `authzid NUL authcid NUL password`, base64 encoded (RFC 4616). */
function decodePlain(encoded) {
  const fields = Buffer.from(encoded, "base64").toString("utf8").split("\0");
  return fields.length === 3 ? { username: fields[1], password: fields[2] } : null;
}

/** The address between `<` and `>` in `MAIL FROM:<a@b> SIZE=1`, or everything after the colon. */
function angleAddress(line) {
  const m = /<([^>]*)>/.exec(line);
  return m ? m[1] : line.slice(line.indexOf(":") + 1).trim();
}

/** The first header called `name` (case-insensitive), unfolded but not decoded; null when absent. */
export function header(data, name) {
  const text = data.toString("utf8");
  const head = text.split(/\r?\n\r?\n/)[0];
  const lines = head.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const colon = lines[i].indexOf(":");
    if (colon > 0 && lines[i].slice(0, colon).toLowerCase() === name.toLowerCase()) {
      let value = lines[i].slice(colon + 1).trimStart();
      while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) value += lines[++i];
      return value;
    }
  }
  return null;
}

/**
 * RFC 2047 encoded words (`=?utf-8?b?…?=`, `=?utf-8?q?…?=`) decoded, which is how lettre writes a subject
 * that is not plain ASCII (Arcus's subjects quote the job's name with “ and ”). Whitespace between two
 * encoded words is dropped, as the RFC says.
 */
export function decodeHeaderValue(raw) {
  if (raw === null) return null;
  return raw
    .replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, _charset, encoding, text) =>
      encoding.toUpperCase() === "B"
        ? Buffer.from(text, "base64").toString("utf8")
        : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16))), "latin1").toString("utf8"),
    );
}
