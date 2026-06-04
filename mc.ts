#!/usr/bin/env bun
/**
 * mc.ts — MeshCore HA CLI
 *
 * Run any meshcore-ha service or query HA entity states from the terminal.
 *
 * Usage:
 *   bun mc.ts cmd <command>          Execute a raw MeshCore command
 *   bun mc.ts send <pubkey> <msg>    Send a direct message to a contact
 *   bun mc.ts chat <pubkey>          Start interactive chat with a contact
 *   bun mc.ts route <pubkey> [path]  Show or set route for a contact
 *   bun mc.ts ping <pubkey> [sec]    Trace/ping a pubkey prefix
 *   bun mc.ts chan <idx> <msg>       Send a channel message
 *   bun mc.ts contacts               List MeshCore contacts available in HA
 *   bun mc.ts sensors                List all meshcore sensor entities
 *   bun mc.ts states [filter]        Dump entity states (optional substring filter)
 *   bun mc.ts state <entity_id>      Get a single entity state + attributes
 *   bun mc.ts events [seconds]       Stream HA events for N seconds (default 10)
 *
 * Examples:
 *   bun mc.ts cmd get_stats_core
 *   bun mc.ts cmd "get_contacts(0)"
 *   bun mc.ts cmd reboot
 *   bun mc.ts send 0a53ef "hello from cli"
 *   bun mc.ts chat 0a53ef
 *   bun mc.ts route 0a53ef direct
 *   bun mc.ts ping 0a53ef
 *   bun mc.ts chan 0 "broadcast test"
 *   bun mc.ts state sensor.meshcore_0a53ef34e4_uptime_kololec
 *   bun mc.ts states meshcore_0a53ef
 *   bun mc.ts events 30
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createInterface } from "readline/promises";
import { parseArgs } from "util";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadEnvFile(path: string) {
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    // Missing env files are fine — rely on later files or environment variables.
  }
}

function loadEnv() {
  loadEnvFile(join(import.meta.dir, ".env"));
  loadEnvFile(join(homedir(), ".meshcore-ha-cli"));
}

loadEnv();

const HA_URL   = (process.env.HA_URL   ?? "").replace(/\/$/, "");
const HA_TOKEN = process.env.HA_TOKEN  ?? "";
const VERIFY   = (process.env.HA_VERIFY_TLS ?? "true").toLowerCase() !== "false";

function requireHaConfig() {
  if (!HA_URL || !HA_TOKEN) {
    throw new Error("HA_URL and HA_TOKEN must be set in .env, ~/.meshcore-ha-cli, or environment.");
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const HEADERS = {
  Authorization: `Bearer ${HA_TOKEN}`,
  "Content-Type": "application/json",
};

const TLS = VERIFY ? undefined : { rejectUnauthorized: false };

async function haGet(path: string) {
  const res = await fetch(`${HA_URL}${path}`, {
    headers: HEADERS,
    tls: TLS,
  } as RequestInit & { tls?: unknown });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

async function haGetStateIfExists(entityId: string) {
  const res = await fetch(`${HA_URL}/api/states/${entityId}`, {
    headers: HEADERS,
    tls: TLS,
  } as RequestInit & { tls?: unknown });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /api/states/${entityId} → ${res.status} ${res.statusText}`);
  return res.json();
}

async function haPost(path: string, body: unknown) {
  const res = await fetch(`${HA_URL}${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
    tls: TLS,
  } as RequestInit & { tls?: unknown });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path} → ${res.status} ${res.statusText}\n${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function execCommand(command: string, timeoutMs = 15000) {
  console.error(`→ ${command}`);

  const payload = await meshcoreCommand(command, timeoutMs);

  if (payload && typeof payload === "object" && Object.keys(payload).length > 0) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.error("✓ done (no payload returned)");
  }
}

async function meshcoreCommand(command: string, timeoutMs = 15000) {
  // Use HA's service response feature (supported since HA 2023.7).
  // POST to /api/services/<domain>/<service>?return_response=true returns
  // the service's return value directly in the JSON body.
  const url = `${HA_URL}/api/services/meshcore/execute_command?return_response=true`;
  const res = await fetch(url, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(timeoutMs),
    tls: TLS,
  } as RequestInit & { tls?: unknown });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}\n${text}`);
  }

  const body = await res.json();

  // HA 2023.7+ wraps the return value under "service_response"
  return body?.service_response ?? body;
}

async function meshcoreService(service: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${HA_URL}/api/services/meshcore/${service}?return_response=true`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
    tls: TLS,
  } as RequestInit & { tls?: unknown });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST /api/services/meshcore/${service} → ${res.status} ${res.statusText}\n${text}`);
  }

  const response = await res.json();
  return response?.service_response ?? response;
}

/** Open a WS, auth, then resolve with a cancel function and a promise that
 *  resolves when a matching meshcore_message_sent event arrives. */
function waitForSentEvent(
  matchFn: (data: any) => boolean,
  timeoutMs: number,
): Promise<{ ack_received: boolean; elapsed_ms: number } | null> {
  return new Promise((resolve) => {
    const wsUrl = HA_URL.replace(/^https/, "wss").replace(/^http/, "ws") + "/api/websocket";
    const ws = new WebSocket(wsUrl, VERIFY ? undefined : { tls: { rejectUnauthorized: false } } as any);
    let msgId = 1;
    const t0 = Date.now();

    const done = (result: { ack_received: boolean; elapsed_ms: number } | null) => {
      ws.close();
      resolve(result);
    };

    const timer = setTimeout(() => done(null), timeoutMs);

    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      if (msg.type === "auth_required") {
        ws.send(JSON.stringify({ type: "auth", access_token: HA_TOKEN }));
      } else if (msg.type === "auth_ok") {
        ws.send(JSON.stringify({ id: msgId++, type: "subscribe_events", event_type: "meshcore_message_sent" }));
      } else if (msg.type === "event" && msg.event?.event_type === "meshcore_message_sent") {
        const data = msg.event.data ?? {};
        if (matchFn(data)) {
          clearTimeout(timer);
          done({ ack_received: !!data.ack_received, elapsed_ms: Date.now() - t0 });
        }
      }
    };
    ws.onerror = () => { clearTimeout(timer); done(null); };
  });
}

async function sendMessage(pubkeyPrefix: string, message: string, timeoutMs = 30000) {
  console.error(`→ send to ${pubkeyPrefix}: "${message}"`);
  const t0 = Date.now();

  // Start listening before we send so we don't miss the event
  const waitPromise = waitForSentEvent(
    (d) => (d.contact_public_key ?? "").startsWith(pubkeyPrefix.toLowerCase()) ||
            (d.receiver ?? "").toLowerCase().includes(pubkeyPrefix.toLowerCase()),
    timeoutMs,
  );

  await haPost("/api/services/meshcore/send_message", { pubkey_prefix: pubkeyPrefix, message });

  const result = await waitPromise;
  if (result) {
    const ack = result.ack_received ? "✓ ACK" : "✗ no ACK";
    console.log(JSON.stringify({ status: ack, elapsed_ms: result.elapsed_ms }));
  } else {
    console.log(JSON.stringify({ status: "timeout", elapsed_ms: Date.now() - t0 }));
  }
}

async function sendChannel(channelIdx: number, message: string, timeoutMs = 30000) {
  console.error(`→ chan ${channelIdx}: "${message}"`);
  const t0 = Date.now();

  const waitPromise = waitForSentEvent(
    (d) => d.message_type === "channel",
    timeoutMs,
  );

  await haPost("/api/services/meshcore/send_channel_message", { channel: channelIdx, message });

  const result = await waitPromise;
  if (result) {
    console.log(JSON.stringify({ status: "✓ sent", elapsed_ms: result.elapsed_ms }));
  } else {
    console.log(JSON.stringify({ status: "timeout", elapsed_ms: Date.now() - t0 }));
  }
}

async function getDeviceContacts() {
  const payload = await meshcoreService("get_contacts");
  return extractContacts(payload);
}

function resolveOneContact(contacts: any[], pubkeyPrefix: string) {
  const matches = findContactByPrefix(contacts, pubkeyPrefix);
  if (matches.length === 0) throw new Error(`Contact not found: ${pubkeyPrefix}`);
  if (matches.length > 1) {
    const choices = matches.map((contact) => `${contactKey(contact).slice(0, 12)} ${contactName(contact)}`).join(", ");
    throw new Error(`Contact prefix is ambiguous: ${pubkeyPrefix} (${choices})`);
  }
  return matches[0];
}

function routeHashWidth(mode: string) {
  switch (Number(mode)) {
    case 0:
      return 1;
    case 1:
      return 2;
    case 2:
      return 3;
    default:
      return 0;
  }
}

function splitRoutePath(path: string, mode: string, len: string) {
  const rawHex = path.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  const byteLen = Number(len);
  const hex = Number.isFinite(byteLen) && byteLen > 0
    ? rawHex.slice(0, byteLen * 2)
    : rawHex;
  const width = routeHashWidth(mode) * 2;
  if (!hex || !width || hex.length % width !== 0) return hex;

  const hops: string[] = [];
  for (let i = 0; i < hex.length; i += width) hops.push(hex.slice(i, i + width));
  return hops.join(",");
}

function routeLabel(contact: any) {
  const path = contactValue(contact, ["out_path"]);
  const len = contactValue(contact, ["out_path_len"]);
  const mode = contactValue(contact, ["out_path_hash_mode"]);
  const numericLen = Number(len);

  if (numericLen < 0) return "auto/flood";
  if (numericLen === 0 && !path) return "direct";
  if (path) return splitRoutePath(path, mode, len);
  return "unknown";
}

function normalizeRoutePathArg(rawPath: string) {
  const value = rawPath.trim().toLowerCase();
  if (["auto", "reset", "flood"].includes(value)) return { action: "reset" as const };
  if (value === "direct") return { action: "change" as const, hex: "" };

  const hex = value
    .replace(/0x/g, "")
    .replace(/[,\s:_-]/g, "");

  if (!hex || hex.length % 2 !== 0 || /[^0-9a-f]/.test(hex)) {
    throw new Error("Route path must be 'direct', 'auto'/'reset'/'flood', or hex bytes like 1a,2c.");
  }

  return { action: "change" as const, hex };
}

function bytesLiteral(hex: string) {
  const bytes = hex.match(/../g) ?? [];
  return `b"${bytes.map((byte) => `\\x${byte}`).join("")}"`;
}

async function routeContact(pubkeyPrefix: string, rawPath?: string) {
  const contact = resolveOneContact(await getDeviceContacts(), pubkeyPrefix);
  const key = contactKey(contact);
  const name = contactName(contact);

  if (!rawPath) {
    console.log(`${name} (${key.slice(0, 12)})`);
    console.log(`  route : ${routeLabel(contact)}`);
    console.log(`  mode  : ${contactValue(contact, ["out_path_hash_mode"]) || "unknown"}`);
    console.log(`  len   : ${contactValue(contact, ["out_path_len"]) || "unknown"}`);
    console.log(`  raw   : ${contactValue(contact, ["out_path"]) || ""}`);
    return;
  }

  const path = normalizeRoutePathArg(rawPath);
  const command = path.action === "reset"
    ? `reset_path(${JSON.stringify(key)})`
    : `change_contact_path(${JSON.stringify(key)}, ${bytesLiteral(path.hex)})`;

  console.error(`→ ${command}`);
  const payload = await meshcoreCommand(command, 30000);
  console.log(JSON.stringify({
    contact: name,
    pubkey_prefix: key.slice(0, 12),
    route: rawPath,
    response: payload,
  }, null, 2));
}

function formatTracePath(value: unknown) {
  if (Array.isArray(value)) return value.map(String).join(",");
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

async function pingContact(pubkeyPrefix: string, timeoutSeconds = 15) {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("timeout must be a positive number of seconds");
  }

  const t0 = Date.now();
  const payload = await meshcoreService("trace", {
    pubkey_prefix: pubkeyPrefix,
    timeout: timeoutSeconds,
  });
  const elapsed = Date.now() - t0;
  const trace = payload?.trace;

  if (!trace) {
    console.log(JSON.stringify({
      pubkey_prefix: pubkeyPrefix,
      ok: false,
      elapsed_ms: elapsed,
      error: payload?.error ?? "trace_failed",
      response: payload,
    }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    pubkey_prefix: pubkeyPrefix,
    ok: true,
    elapsed_ms: elapsed,
    hop_count: trace.hop_count ?? trace.hops ?? trace.hopCount,
    path: formatTracePath(trace.path ?? trace.route ?? trace.hops_path),
    rtt_ms: trace.rtt_ms ?? trace.round_trip_ms ?? trace.elapsed_ms,
    snr: trace.snr ?? trace.snr_values ?? trace.per_hop_snr,
    trace,
  }, null, 2));
}

function wsUrl() {
  return HA_URL.replace(/^https/, "wss").replace(/^http/, "ws") + "/api/websocket";
}

function parseWsData(data: string | ArrayBuffer | Blob) {
  return JSON.parse(typeof data === "string" ? data : data.toString());
}

function eventMatchesContact(data: any, pubkeyPrefix: string) {
  const prefix = pubkeyPrefix.toLowerCase();
  const values = Object.entries(data ?? {})
    .filter(([key]) => /(pubkey|public_key|contact|sender|receiver|from|to)/i.test(key))
    .map(([, value]) => String(value ?? "").toLowerCase());

  return values.some((value) => value.startsWith(prefix) || value.includes(prefix));
}

function contactKey(contact: any) {
  return contactValue(contact, ["public_key", "pubkey", "pubkey_prefix", "id"]);
}

function contactName(contact: any) {
  return cleanText(contactValue(contact, ["adv_name", "name", "display_name", "short_name"])) || contactKey(contact).slice(0, 12);
}

function mergeContacts(contacts: any[]) {
  const byKey = new Map<string, any>();
  for (const contact of contacts) {
    const key = contactKey(contact).slice(0, 12).toLowerCase();
    if (!key) continue;
    byKey.set(key, { ...(byKey.get(key) ?? {}), ...contact });
  }
  return [...byKey.values()];
}

function findContactByPrefix(contacts: any[], pubkeyPrefix: string) {
  const prefix = pubkeyPrefix.toLowerCase();
  return contacts.filter((contact) => contactKey(contact).toLowerCase().startsWith(prefix));
}

function messageText(data: any) {
  for (const key of ["message", "text", "content", "payload", "msg"]) {
    const value = data?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return JSON.stringify(data);
}

function compactHex(value: string) {
  const cleaned = value.replace(/\s+/g, "");
  return cleaned.length > 16 ? `${cleaned.slice(0, 8)}…${cleaned.slice(-4)}` : cleaned;
}

function routeTag(data: any) {
  const parts: string[] = [];
  const route = contactValue(data, ["route", "path", "out_path", "via", "next_hop"]);
  const pathHash = contactValue(data, ["path_hash", "path_hashes", "route_hash"]);
  const hopCount = contactValue(data, ["hop_count", "hops"]);
  const rssi = contactValue(data, ["rssi", "last_rssi"]);
  const snr = contactValue(data, ["snr", "last_snr"]);

  if (route && route !== "-1") parts.push(`route ${compactHex(route)}`);
  if (pathHash) parts.push(`hash ${compactHex(pathHash)}`);
  if (hopCount && hopCount !== "-1" && hopCount !== "0") parts.push(`${hopCount}h`);
  if (rssi) parts.push(`${rssi}dBm`);
  if (snr) parts.push(`${snr}dB`);

  if (parts.length === 0 && data?.message_type === "direct") parts.push("direct");

  return parts.length > 0 ? `[${parts.join(" ")}]` : "";
}

function printChatLine(line: string, rl?: ReturnType<typeof createInterface>) {
  process.stdout.write(`\r\x1b[2K${line}\n`);
  rl?.prompt();
}

function formatDuration(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function chatContact(pubkeyPrefix: string) {
  const contacts = await getHaContacts();
  const matches = findContactByPrefix(contacts, pubkeyPrefix);
  if (matches.length === 0) throw new Error(`Contact not found: ${pubkeyPrefix}`);
  if (matches.length > 1) {
    const choices = matches.map((contact) => `${contactKey(contact).slice(0, 12)} ${contactName(contact)}`).join(", ");
    throw new Error(`Contact prefix is ambiguous: ${pubkeyPrefix} (${choices})`);
  }

  const contact = matches[0];
  const resolvedKey = contactKey(contact);
  const name = contactName(contact);
  const events = ["meshcore_message", "meshcore_message_sent", "meshcore_delivery_update"];
  const ws = new WebSocket(wsUrl(), VERIFY ? undefined : { tls: { rejectUnauthorized: false } } as any);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  const pendingSends: { message: string; createdAt: number }[] = [];
  let msgId = 1;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    rl.close();
    ws.close();
  };

  const ready = new Promise<void>((resolve, reject) => {
    let authenticated = false;

    ws.onmessage = (ev) => {
      const msg = parseWsData(ev.data);

      if (msg.type === "auth_required") {
        ws.send(JSON.stringify({ type: "auth", access_token: HA_TOKEN }));

      } else if (msg.type === "auth_ok") {
        authenticated = true;
        for (const event_type of events) {
          ws.send(JSON.stringify({ id: msgId++, type: "subscribe_events", event_type }));
        }
        resolve();

      } else if (msg.type === "auth_invalid") {
        reject(new Error("authentication failed — check HA_TOKEN"));
        close();

      } else if (msg.type === "event" && msg.event?.event_type) {
        const eventType = msg.event.event_type;
        const data = msg.event.data ?? {};
        if (!eventMatchesContact(data, resolvedKey) && !eventMatchesContact(data, pubkeyPrefix)) return;

        const ts = new Date(msg.event.time_fired ?? Date.now()).toLocaleTimeString();
        if (eventType === "meshcore_message") {
          const type = data.message_type ?? data.type;
          if (type === "channel") return;
          const text = messageText(data);
          const pendingIndex = pendingSends.findIndex((pending) => pending.message === text && Date.now() - pending.createdAt < 120000);
          if (pendingIndex !== -1) return;
          const route = routeTag(data);
          printChatLine(`[${ts}] ${name}: ${text}${route ? ` ${route}` : ""}`, rl);
        } else if (eventType === "meshcore_message_sent") {
          const pending = pendingSends.shift();
          const ack = data.ack_received ? "ACK" : "sent";
          if (pending) {
            const route = routeTag(data);
            printChatLine(`[${ts}] me: ${pending.message} [${ack} ${formatDuration(Date.now() - pending.createdAt)}${route ? ` ${route.slice(1, -1)}` : ""}]`, rl);
          } else {
            printChatLine(`[${ts}] me: [${ack}]`, rl);
          }
        } else if (eventType === "meshcore_delivery_update") {
          const ack = data.ack_received ?? data.delivered ?? data.ack;
          const pending = pendingSends.shift();
          if (pending) {
            const status = ack ? "ACK" : "no ACK";
            const route = routeTag(data);
            printChatLine(`[${ts}] me: ${pending.message} [${status} ${formatDuration(Date.now() - pending.createdAt)}${route ? ` ${route.slice(1, -1)}` : ""}]`, rl);
          } else {
            printChatLine(`[${ts}] delivery: ${ack === undefined ? JSON.stringify(data) : ack ? "ACK" : "no ACK"}`, rl);
          }
        }

      } else if (msg.type === "result" && !msg.success) {
        printChatLine(`subscription error: ${JSON.stringify(msg.error)}`, rl);
      }
    };

    ws.onerror = (e: any) => reject(new Error(e.message ?? String(e)));
    ws.onclose = () => {
      if (!closed) rl.close();
      if (!closed && !authenticated) reject(new Error("websocket closed before authentication completed"));
    };
  });

  process.on("SIGINT", close);
  process.on("SIGTERM", close);

  await ready;
  console.error(`Chat with ${name} (${resolvedKey.slice(0, 12)}). Type /quit to exit.`);
  rl.prompt();

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) {
      rl.prompt();
      continue;
    }
    if (line === "/quit" || line === "/exit") {
      close();
      break;
    }

    pendingSends.push({ message: line, createdAt: Date.now() });
    await haPost("/api/services/meshcore/send_message", { pubkey_prefix: pubkeyPrefix, message: line });
    if (!closed) rl.prompt();
  }

  close();
}

async function listSensors() {
  const states: any[] = await haGet("/api/states");
  const mc = states
    .filter(e => e.entity_id.startsWith("sensor.meshcore_"))
    .sort((a, b) => a.entity_id.localeCompare(b.entity_id));

  console.log(`\n${mc.length} MeshCore sensor entities:\n`);
  for (const e of mc) {
    const unit = e.attributes?.unit_of_measurement ?? "";
    console.log(`  ${e.entity_id.padEnd(65)} ${String(e.state).padStart(10)} ${unit}`);
  }
}

function contactValue(contact: any, keys: string[]) {
  for (const key of keys) {
    const value = contact?.[key];
    if (value !== undefined && value !== null && value !== "") return String(value);
  }
  return "";
}

function cleanText(value: string) {
  return value.replace(/[\x00-\x1f\x7f]/g, "").trim();
}

function formatUnixTime(value: string) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return value;
  return new Date(seconds * 1000).toLocaleString();
}

function formatNodeType(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.startsWith("client")) return "cli";
  if (normalized.startsWith("repeater")) return "rep";
  if (normalized.startsWith("room")) return "room";
  if (normalized.startsWith("sensor")) return "sens";
  if (normalized.startsWith("unknown")) return "unk";

  switch (Number(value)) {
    case 1:
      return "cli";
    case 2:
      return "rep";
    case 3:
      return "room";
    case 4:
      return "sens";
    default:
      return value;
  }
}

function looksLikeContact(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return [
    "adv_name",
    "name",
    "display_name",
    "pubkey_prefix",
    "public_key",
    "pubkey",
    "last_advert",
    "last_seen",
  ].some((key) => value[key] !== undefined);
}

function extractContacts(payload: any): any[] {
  if (typeof payload === "string") {
    try {
      return extractContacts(JSON.parse(payload));
    } catch {
      return [];
    }
  }

  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  for (const key of ["contacts", "contact_list", "result", "response", "data", "value", "return_value"]) {
    const contacts = extractContacts(payload[key]);
    if (contacts.length > 0) return contacts;
  }

  if (looksLikeContact(payload)) return [payload];

  const mapped = Object.entries(payload)
    .filter(([, value]) => looksLikeContact(value))
    .map(([key, value]) => {
      const contact = value as Record<string, unknown>;
      return {
        ...contact,
        pubkey_prefix: contactValue(contact, ["pubkey_prefix", "public_key", "pubkey", "id"]) || key,
      };
    });
  if (mapped.length > 0) return mapped;

  return [];
}

function stateToContact(entity: any) {
  const attrs = entity.attributes ?? {};
  const publicKey = contactValue(attrs, ["public_key", "pubkey", "pubkey_prefix", "id"]);
  if (!publicKey) return null;

  return {
    ...attrs,
    entity_id: entity.entity_id,
    ha_state: entity.state,
    source: "binary",
    pubkey_prefix: contactValue(attrs, ["pubkey_prefix"]) || publicKey.slice(0, 12),
    public_key: publicKey,
  };
}

function optionToContact(option: string, source: string) {
  const match = option.match(/^(.*)\s+\(([0-9a-fA-F]{6,64})\)$/);
  if (!match) return null;

  const [, rawName, pubkeyPrefix] = match;
  return {
    adv_name: cleanText(rawName),
    pubkey_prefix: pubkeyPrefix.toLowerCase(),
    public_key: pubkeyPrefix.toLowerCase(),
    ha_state: source,
    source,
    added_to_node: source !== "discovered",
  };
}

function selectOptionsToContacts(entity: any) {
  const options = entity.attributes?.options;
  if (!Array.isArray(options)) return [];

  const entityId = String(entity.entity_id ?? "");
  const friendlyName = String(entity.attributes?.friendly_name ?? "");
  const label = `${entityId} ${friendlyName}`.toLowerCase();
  if (!label.includes("meshcore") || !label.includes("contact")) return [];

  const source = label.includes("discovered")
    ? "discovered"
    : label.includes("added")
      ? "added"
      : "contact";

  return options
    .map((option) => optionToContact(String(option), source))
    .filter((contact): contact is Record<string, unknown> => contact !== null);
}

function meshcoreContactSelectIds() {
  const bases = [
    "select.meshcore_contact",
    "select.meshcore_added_contact",
    "select.meshcore_discovered_contact",
  ];
  const ids = [...bases];

  for (let i = 2; i <= 10; i++) {
    for (const base of bases) ids.push(`${base}_${i}`);
  }

  return ids;
}

async function getHaContacts() {
  const entities = (await Promise.all(
    meshcoreContactSelectIds().map((entityId) => haGetStateIfExists(entityId))
  )).filter((entity): entity is Record<string, unknown> => entity !== null);

  return mergeContacts(entities.flatMap(selectOptionsToContacts))
    .sort((a, b) => contactName(a).localeCompare(contactName(b)));
}

async function listContacts() {
  const contacts = await getHaContacts();

  if (contacts.length === 0) {
    console.log("No meshcore-ha contact entities found.");
    return;
  }

  console.log(`\n${contacts.length} meshcore-ha contacts:\n`);
  console.log(`  ${"key".padEnd(12)} ${"name".padEnd(24)} ${"state".padEnd(10)} ${"src".padEnd(10)} ${"node".padEnd(5)} ${"type".padEnd(6)} ${"lat".padStart(10)} ${"lon".padStart(11)} last`);
  console.log(`  ${"-".repeat(12)} ${"-".repeat(24)} ${"-".repeat(10)} ${"-".repeat(10)} ${"-".repeat(5)} ${"-".repeat(6)} ${"-".repeat(10)} ${"-".repeat(11)} ${"-".repeat(22)}`);

  for (const contact of contacts) {
    const key = contactValue(contact, ["pubkey_prefix", "public_key", "pubkey", "id"]).slice(0, 12);
    const name = contactName(contact);
    const state = contactValue(contact, ["ha_state", "state"]);
    const source = contactValue(contact, ["source"]);
    const added = contactValue(contact, ["added_to_node"]);
    const type = formatNodeType(contactValue(contact, ["node_type_str", "type", "role", "device_type"]) || (contact?.is_repeater ? "repeater" : ""));
    const lat = contactValue(contact, ["latitude", "adv_lat", "lat"]);
    const lon = contactValue(contact, ["longitude", "adv_lon", "lon"]);
    const last = contactValue(contact, ["last_advert_formatted"]) || formatUnixTime(contactValue(contact, ["last_advert", "last_seen", "updated_at", "lastmod"]));

    console.log(`  ${key.padEnd(12)} ${name.slice(0, 24).padEnd(24)} ${state.slice(0, 10).padEnd(10)} ${source.slice(0, 10).padEnd(10)} ${added.slice(0, 5).padEnd(5)} ${type.slice(0, 6).padEnd(6)} ${lat.slice(0, 10).padStart(10)} ${lon.slice(0, 11).padStart(11)} ${last}`);
  }
}

async function dumpStates(filter?: string) {
  const states: any[] = await haGet("/api/states");
  const filtered = filter
    ? states.filter(e => e.entity_id.includes(filter))
    : states;

  console.log(`\n${filtered.length} entities${filter ? ` matching "${filter}"` : ""}:\n`);
  for (const e of filtered.sort((a, b) => a.entity_id.localeCompare(b.entity_id))) {
    const unit = e.attributes?.unit_of_measurement ?? "";
    console.log(`  ${e.entity_id.padEnd(65)} ${String(e.state).padStart(12)} ${unit}`);
  }
}

async function getState(entityId: string) {
  const e: any = await haGet(`/api/states/${entityId}`);
  const unit = e.attributes?.unit_of_measurement ?? "";
  console.log(`\n${e.entity_id}`);
  console.log(`  state      : ${e.state} ${unit}`);
  console.log(`  last_changed: ${e.last_changed}`);
  console.log(`  attributes :`);
  for (const [k, v] of Object.entries(e.attributes ?? {})) {
    console.log(`    ${String(k).padEnd(30)} ${v}`);
  }
}

// All event types fired by meshcore-ha
const MESHCORE_EVENTS = [
  "meshcore_message",           // incoming message / channel message
  "meshcore_message_sent",      // outgoing message confirmation
  "meshcore_delivery_update",   // delivery ACK
  "meshcore_connected",         // radio connected
  "meshcore_disconnected",      // radio disconnected
  "meshcore_raw_event",         // raw firmware events
];

async function streamEvents(seconds: number | null, filter?: string) {
  const wsUrl = HA_URL.replace(/^https/, "wss").replace(/^http/, "ws") + "/api/websocket";
  console.error(`Connecting to ${wsUrl}${seconds ? ` for ${seconds}s` : ""}… (Ctrl+C to stop)`);

  const events = filter
    ? MESHCORE_EVENTS.filter(e => e.includes(filter))
    : MESHCORE_EVENTS;

  // Bun's WebSocket supports tls options via the second argument
  const ws = new WebSocket(wsUrl, VERIFY ? undefined : { tls: { rejectUnauthorized: false } } as any);
  let msgId = 1;
  let ready = false;

  ws.onopen = () => {
    // auth_required fires after open; nothing to send yet
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());

    if (msg.type === "auth_required") {
      ws.send(JSON.stringify({ type: "auth", access_token: HA_TOKEN }));

    } else if (msg.type === "auth_ok") {
      ready = true;
      console.error(`✓ authenticated — subscribing to ${events.length} event types\n`);
      for (const event_type of events) {
        ws.send(JSON.stringify({ id: msgId++, type: "subscribe_events", event_type }));
      }

    } else if (msg.type === "auth_invalid") {
      console.error("✗ authentication failed — check HA_TOKEN");
      ws.close();

    } else if (msg.type === "event" && msg.event?.event_type) {
      const { event_type, data, time_fired } = msg.event;
      const ts = time_fired ? new Date(time_fired).toISOString() : new Date().toISOString();
      // Print as clean JSON line — works with: mc events | jq .
      process.stdout.write(JSON.stringify({ ts, type: event_type, data }) + "\n");

    } else if (msg.type === "result" && !msg.success) {
      console.error(`subscription error: ${JSON.stringify(msg.error)}`);
    }
  };

  ws.onerror = (e: any) => console.error("WS error:", e.message ?? e);
  ws.onclose = () => { if (ready) console.error("\nConnection closed."); };

  await new Promise<void>((resolve) => {
    if (seconds !== null) {
      setTimeout(() => { ws.close(); resolve(); }, seconds * 1000);
    }
    // Otherwise run until Ctrl+C / process exit
    process.on("SIGINT", () => { ws.close(); resolve(); });
    process.on("SIGTERM", () => { ws.close(); resolve(); });
  });
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`
mc — MeshCore HA CLI

Commands:
  cmd <command>              Execute a raw MeshCore command
  send <pubkey> <msg>        Send a direct message to a contact by pubkey prefix
  chat <pubkey>              Start interactive chat with a contact by pubkey prefix
  route <pubkey> [path]      Show or set contact route (direct, auto/reset/flood, or hex)
  ping <pubkey> [seconds]    Trace/ping a pubkey prefix without contact lookup
  chan <idx> <msg>           Send a channel message
  contacts                   List MeshCore contacts available in HA
  sensors                    List all meshcore sensor entities
  states [filter]            Dump entity states
  state <entity_id>          Get a single entity state and attributes
  events [filter] [seconds]  Stream meshcore HA events as JSON lines
`);
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    help: { type: "boolean", short: "h" },
  },
  strict: true,
  allowPositionals: true,
});

const [subcmd, ...rest] = positionals;

try {
  if (values.help || !subcmd) {
    printHelp();
    process.exit(0);
  }

  switch (subcmd) {
    case "cmd":
      requireHaConfig();
      if (!rest[0]) throw new Error("Usage: mc cmd <command>");
      await execCommand(rest.join(" "));
      break;

    case "send":
      requireHaConfig();
      if (rest.length < 2) throw new Error("Usage: mc send <pubkey_prefix> <message>");
      await sendMessage(rest[0], rest.slice(1).join(" "));
      break;

    case "chat":
      requireHaConfig();
      if (!rest[0]) throw new Error("Usage: mc chat <pubkey_prefix>");
      await chatContact(rest[0]);
      break;

    case "route":
      requireHaConfig();
      if (!rest[0]) throw new Error("Usage: mc route <pubkey_prefix> [direct|auto|reset|flood|hex_path]");
      await routeContact(rest[0], rest[1]);
      break;

    case "ping": {
      requireHaConfig();
      if (!rest[0]) throw new Error("Usage: mc ping <pubkey_prefix> [timeout_seconds]");
      const timeoutSeconds = rest[1] === undefined ? 15 : Number(rest[1]);
      await pingContact(rest[0], timeoutSeconds);
      break;
    }

    case "chan": {
      requireHaConfig();
      if (rest.length < 2) throw new Error("Usage: mc chan <channel_idx> <message>");

      const channelIdx = parseInt(rest[0], 10);
      if (Number.isNaN(channelIdx)) throw new Error("channel_idx must be a number");

      await sendChannel(channelIdx, rest.slice(1).join(" "));
      break;
    }

    case "contacts":
      requireHaConfig();
      await listContacts();
      break;

    case "sensors":
      requireHaConfig();
      await listSensors();
      break;

    case "states":
      requireHaConfig();
      await dumpStates(rest[0]);
      break;

    case "state":
      requireHaConfig();
      if (!rest[0]) throw new Error("Usage: mc state <entity_id>");
      await getState(rest[0]);
      break;

    case "events": {
      requireHaConfig();
      const firstIsNum = rest[0] !== undefined && !Number.isNaN(parseInt(rest[0], 10));
      const secs = firstIsNum ? parseInt(rest[0], 10) : null;
      const filter = firstIsNum ? rest[1] : rest[0];
      await streamEvents(secs, filter);
      break;
    }

    default:
      throw new Error(`Unknown command: ${subcmd}`);
  }
} catch (err: any) {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
}
