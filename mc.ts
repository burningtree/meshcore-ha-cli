#!/usr/bin/env bun
/**
 * mc.ts — MeshCore HA CLI
 *
 * Run any meshcore-ha service or query HA entity states from the terminal.
 *
 * Usage:
 *   bun mc.ts cmd <command>          Execute a raw MeshCore command
 *   bun mc.ts send <pubkey> <msg>    Send a direct message to a contact
 *   bun mc.ts chan <idx> <msg>       Send a channel message
 *   bun mc.ts contacts               List all meshcore sensor entities
 *   bun mc.ts states [filter]        Dump entity states (optional substring filter)
 *   bun mc.ts state <entity_id>      Get a single entity state + attributes
 *   bun mc.ts events [seconds]       Stream HA events for N seconds (default 10)
 *
 * Examples:
 *   bun mc.ts cmd get_stats_core
 *   bun mc.ts cmd "get_contacts(0)"
 *   bun mc.ts cmd reboot
 *   bun mc.ts send 0a53ef "hello from cli"
 *   bun mc.ts chan 0 "broadcast test"
 *   bun mc.ts state sensor.meshcore_0a53ef34e4_uptime_kololec
 *   bun mc.ts states meshcore_0a53ef
 *   bun mc.ts events 30
 */

import { readFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadEnv() {
  try {
    const raw = readFileSync(join(import.meta.dir, ".env"), "utf8");
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
    // no .env file — rely on environment variables
  }
}

loadEnv();

const HA_URL   = (process.env.HA_URL   ?? "").replace(/\/$/, "");
const HA_TOKEN = process.env.HA_TOKEN  ?? "";
const VERIFY   = (process.env.HA_VERIFY_TLS ?? "true").toLowerCase() !== "false";

if (!HA_URL || !HA_TOKEN) {
  console.error("Error: HA_URL and HA_TOKEN must be set in .env or environment.");
  process.exit(1);
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
  const payload = body?.service_response ?? body;

  if (payload && typeof payload === "object" && Object.keys(payload).length > 0) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.error("✓ done (no payload returned)");
  }
}

async function sendMessage(pubkeyPrefix: string, message: string) {
  console.log(`→ send_message to ${pubkeyPrefix}: "${message}"`);
  await haPost("/api/services/meshcore/send_message", {
    pubkey_prefix: pubkeyPrefix,
    message,
  });
  console.log("✓ sent");
}

async function sendChannel(channelIdx: number, message: string) {
  console.log(`→ send_channel_message [${channelIdx}]: "${message}"`);
  await haPost("/api/services/meshcore/send_channel_message", {
    channel: channelIdx,
    message,
  });
  console.log("✓ sent");
}

async function listContacts() {
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

async function streamEvents(seconds: number) {
  // HA websocket for events
  const wsUrl = HA_URL.replace(/^http/, "ws") + "/api/websocket";
  console.log(`Connecting to ${wsUrl} for ${seconds}s…`);

  const ws = new WebSocket(wsUrl);
  let msgId = 1;

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === "auth_required") {
      ws.send(JSON.stringify({ type: "auth", access_token: HA_TOKEN }));
    } else if (msg.type === "auth_ok") {
      console.log("✓ authenticated, subscribing to meshcore events…\n");
      ws.send(JSON.stringify({ id: msgId++, type: "subscribe_events", event_type: "meshcore_message_sent" }));
      ws.send(JSON.stringify({ id: msgId++, type: "subscribe_events", event_type: "meshcore_message_received" }));
      ws.send(JSON.stringify({ id: msgId++, type: "subscribe_events", event_type: "meshcore_command_result" }));
    } else if (msg.type === "event") {
      const { event_type, data } = msg.event;
      console.log(`[${new Date().toISOString()}] ${event_type}`);
      console.log(JSON.stringify(data, null, 2));
      console.log();
    }
  };

  ws.onerror = (e) => console.error("WS error:", e);

  await new Promise<void>((resolve) => {
    setTimeout(() => {
      ws.close();
      resolve();
    }, seconds * 1000);
  });

  console.log("Done.");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const [, , subcmd, ...rest] = process.argv;

if (!subcmd) {
  console.log(`
mc.ts — MeshCore HA CLI

Commands:
  cmd <command>          Execute a raw MeshCore command
  send <pubkey> <msg>    Send a direct message to a contact by pubkey prefix
  chan <idx> <msg>       Send a channel message (idx = 0, 1, 2…)
  contacts               List all meshcore sensor entities
  states [filter]        Dump entity states (optional substring filter)
  state <entity_id>      Get a single entity state + attributes
  events [seconds]       Stream HA events for N seconds (default 10)
`);
  process.exit(0);
}

try {
  switch (subcmd) {
    case "cmd":
      if (!rest[0]) { console.error("Usage: mc.ts cmd <command>"); process.exit(1); }
      await execCommand(rest.join(" "));
      break;

    case "send":
      if (rest.length < 2) { console.error("Usage: mc.ts send <pubkey_prefix> <message>"); process.exit(1); }
      await sendMessage(rest[0], rest.slice(1).join(" "));
      break;

    case "chan":
      if (rest.length < 2) { console.error("Usage: mc.ts chan <channel_idx> <message>"); process.exit(1); }
      await sendChannel(parseInt(rest[0]), rest.slice(1).join(" "));
      break;

    case "contacts":
      await listContacts();
      break;

    case "states":
      await dumpStates(rest[0]);
      break;

    case "state":
      if (!rest[0]) { console.error("Usage: mc.ts state <entity_id>"); process.exit(1); }
      await getState(rest[0]);
      break;

    case "events":
      await streamEvents(parseInt(rest[0] ?? "10"));
      break;

    default:
      console.error(`Unknown command: ${subcmd}`);
      process.exit(1);
  }
} catch (err: any) {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
}
