// The intent intake listener: a tiny localhost-only HTTP server that lets the Automate tab hand a
// signed intent straight to this executor — replacing the "download a JSON file and move it into
// ~/.openzaps/executor/intents/ by hand" step when the user browses on the machine the daemon
// runs on.
//
// Threat model, in order of what actually matters:
//   * The listener binds 127.0.0.1 ONLY. Nothing off-machine can reach it.
//   * Browsers CAN reach localhost from web pages, so the browser is the attack surface: CORS
//     restricts readable responses to the OpenZaps origins (+ localhost dev), and the write
//     endpoint requires a bearer token that no web page can read (it lives chmod-600 on disk;
//     the user pastes it into the UI once). A hostile page without the token gets 401s.
//   * Even a successful hostile write is bounded: the payload is schema-validated here, and every
//     intent is re-verified by the capsule on-chain (signature, policy, cadence, condition), so
//     the worst spam achieves is a wasted simulation — same as dropping a garbage file.
// Chrome's Private Network Access preflight (public https page → local http server) is answered
// with `Access-Control-Allow-Private-Network: true`.
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { validateIntentObject } from "./store.mjs";
import { log } from "./engine.mjs";

const MAX_BODY_BYTES = 64 * 1024; // a signed intent is ~1.5KB; 64KB is generous headroom
const ALLOWED_ORIGINS = [
  /^https:\/\/(www\.)?0xzaps\.com$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

/** Load (or mint once) the intake bearer token, chmod 600. */
export function loadIntakeToken(tokenFile) {
  if (existsSync(tokenFile)) {
    const raw = readFileSync(tokenFile, "utf8").trim();
    if (/^[0-9a-f]{48}$/.test(raw)) {
      // A pre-existing file created under a looser umask keeps its old mode unless we re-assert it.
      try {
        chmodSync(tokenFile, 0o600);
      } catch {
        // Best effort — a token we cannot lock down is still gated by the loopback bind.
      }
      return raw;
    }
    // Malformed token file: mint a fresh one rather than serving with a guessable value.
  }
  const token = randomBytes(24).toString("hex");
  writeFileSync(tokenFile, token, { mode: 0o600 });
  return token;
}

/**
 * DNS-rebinding guard. The socket is bound to 127.0.0.1, but a browser whose DNS for attacker.com
 * has been rebound to 127.0.0.1 sends `Host: attacker.com` and the browser treats the response as
 * same-origin — bypassing CORS on reads. Requiring a loopback Host closes that: a real local client
 * always sends `127.0.0.1`/`localhost`, a rebinding attacker cannot forge the Host to a loopback
 * name without the browser resolving it back to loopback (defeating their own attack).
 */
function hostIsLoopback(hostHeader) {
  if (typeof hostHeader !== "string") return false;
  const host = hostHeader.split(":")[0].toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

function corsHeaders(origin) {
  if (!origin || !ALLOWED_ORIGINS.some((re) => re.test(origin))) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization",
    // Chrome PNA: a secure public page talking to a private (localhost) server needs this on the
    // preflight response or the browser refuses the request outright.
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function tokenMatches(header, token) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice(7).trim());
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Start the intake server. `deps.isExecuting` reports signer presence for /health;
 * `deps.countIntents` reports the store size. Returns the node server (for close()).
 */
export function startIntake({ cfg, token, isExecuting, countIntents }) {
  const server = createServer(async (req, res) => {
    const headers = { "Content-Type": "application/json", ...corsHeaders(req.headers.origin) };
    const respond = (code, body) => {
      res.writeHead(code, headers);
      res.end(JSON.stringify(body));
    };

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, headers);
        res.end();
        return;
      }

      // DNS-rebinding guard on every real request (preflight above needs none — it carries no body
      // and reveals nothing).
      if (!hostIsLoopback(req.headers.host)) {
        respond(403, { error: "host not allowed" });
        return;
      }

      if (req.method === "GET" && req.url === "/health") {
        respond(200, {
          ok: true,
          service: "openzaps-executor",
          chainId: cfg.chainId,
          executing: isExecuting(),
          intents: countIntents(),
        });
        return;
      }

      if (req.method === "POST" && req.url === "/intents") {
        if (!tokenMatches(req.headers.authorization, token)) {
          respond(401, { error: "missing or wrong intake token" });
          return;
        }
        let raw;
        try {
          raw = JSON.parse(await readBody(req));
        } catch (err) {
          respond(400, { error: `unreadable body: ${err.message}` });
          return;
        }
        let validated;
        try {
          validated = validateIntentObject(raw);
        } catch (err) {
          respond(422, { error: `invalid intent: ${err.message}` });
          return;
        }
        if (BigInt(validated.intent.chainId) !== BigInt(cfg.chainId)) {
          respond(422, { error: `intent chainId ${validated.intent.chainId} != executor chain ${cfg.chainId}` });
          return;
        }
        // Never trust a client filename — derive one, with a random suffix so two POSTs in the
        // same millisecond cannot collide, and the exclusive `wx` flag so a write NEVER silently
        // overwrites an existing intent (the old scheme acked 201 while discarding the file).
        const stem = `intake-${Date.now()}-${validated.kind}-${validated.intent.zap.slice(2, 10).toLowerCase()}`;
        let name;
        for (let attempt = 0; ; attempt++) {
          const candidate = `${stem}-${randomBytes(4).toString("hex")}.json`;
          try {
            writeFileSync(join(cfg.intentsDir, candidate), JSON.stringify(raw, null, 2), { flag: "wx" });
            name = candidate;
            break;
          } catch (err) {
            if (err.code === "EEXIST" && attempt < 5) continue; // vanishingly unlikely; retry
            throw err;
          }
        }
        log("info", `intake: stored ${name} (${validated.kind} for ${validated.intent.zap})`);
        respond(201, { stored: name });
        return;
      }

      respond(404, { error: "unknown endpoint (GET /health, POST /intents)" });
    } catch (err) {
      respond(500, { error: err.message });
    }
  });

  // A bind failure (port already held by a stale copy or another app) must NOT take down the
  // daemon — the intent and keeper loops are the point. Log it and run without intake; without
  // this handler Node throws the 'error' event uncaught and the whole process exits (→ launchd
  // restart loop).
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log("warn", `intake port ${cfg.intakePort} is in use — running WITHOUT the intake listener (file drop still works)`);
    } else {
      log("error", `intake listener error: ${err.message} — continuing without it`);
    }
  });

  server.listen(cfg.intakePort, "127.0.0.1", () => {
    log("info", `intake listening on http://127.0.0.1:${cfg.intakePort} (POST /intents, token-gated)`);
  });
  return server;
}
