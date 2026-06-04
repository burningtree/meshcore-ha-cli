# mc — MeshCore HA CLI

Command-line tool for controlling and querying MeshCore nodes via the Home Assistant REST API (meshcore-ha integration).

## Install

```bash
make install        # builds with bun and copies to ~/.bun/bin/mc
cp .env.example .env
# edit .env with your HA URL and token
```

`.env` is loaded from the same directory as the binary. To make it work from anywhere:

```bash
ln -s $(pwd)/.env ~/.bun/bin/.env
```

## Configuration

```ini
# .env
HA_URL=https://homeassistant.local:8123
HA_TOKEN=your-long-lived-access-token
HA_VERIFY_TLS=false   # set false for self-signed certs / Tailscale
```

Token: HA → Profile → Security → Long-lived access tokens.

---

## Commands

### `cmd` — execute a raw MeshCore command

Sends the command over the radio and **waits for the result**. Output is clean JSON, so you can pipe to `jq`.

```bash
mc cmd <command>
```

Two syntax forms accepted:
- **Bare name**: `mc cmd get_stats_core`
- **Functional**: `mc cmd "req_status_sync(0a53ef)"` — pass a contact by pubkey prefix

```bash
# Read device stats
mc cmd get_stats_core
mc cmd get_stats_radio
mc cmd get_stats_packets

# Battery info
mc cmd get_bat

# System time
mc cmd get_time

# Contacts list (lastmod=0 = all)
mc cmd "get_contacts(0)"

# Environmental telemetry from companion
mc cmd get_self_telemetry

# Custom variables stored on the device
mc cmd get_custom_vars

# Reboot the companion node
mc cmd reboot
```

### `send` — send a direct message

```bash
mc send <pubkey_prefix> <message>

mc send 0a53ef "hello from cli"
```

### `chan` — send a channel message

```bash
mc chan <channel_index> <message>

mc chan 0 "broadcast to channel 0"
mc chan 1 "team channel message"
```

### `contacts` — list all MeshCore entities

Shows every `sensor.meshcore_*` entity with its current value and unit.

```bash
mc contacts
```

### `states` — dump HA entity states

```bash
mc states                    # all entities
mc states meshcore_0a53ef    # filter by substring
mc states f7f57b             # just companion
```

### `state` — full detail on one entity

```bash
mc state sensor.meshcore_0a53ef34e4_uptime_kololec
mc state sensor.meshcore_0a53ef34e4_bat_kololec
```

### `events` — stream live HA events

Opens a WebSocket and prints MeshCore events as they arrive.

```bash
mc events           # 10 seconds (default)
mc events 60        # 60 seconds
```

---

## Examples

### Monitor signal quality continuously

```bash
watch -n 5 'mc cmd get_stats_radio | jq "{rssi:.last_rssi, snr:.last_snr, noise:.noise_floor}"'
```

### Check repeater status over LoRa

```bash
# req_status_sync queries the repeater over LoRa — takes a few seconds
mc cmd "req_status_sync(0a53ef)"
```

### Get uptime as human-readable

```bash
mc cmd get_stats_core | jq '.uptime_secs | . / 86400 | floor | "\(.) days"'
```

### Compare RX vs TX airtime ratio

```bash
mc cmd get_stats_radio | jq '{rx_hrs: (.rx_air_secs/3600|round), tx_hrs: (.tx_air_secs/3600|round), ratio: ((.rx_air_secs/.tx_air_secs)*100|round|tostring + "%")}'
```

### Show packet error rate

```bash
mc cmd get_stats_packets | jq '{total_rx: .recv, errors: .recv_errors, error_pct: (.recv_errors/.recv*100|round|tostring+"%")}'
```

### Watch all meshcore entity values refresh

```bash
watch -n 30 'mc states meshcore_0a53ef | grep -E "uptime|bat|rssi|nb_recv|nb_sent"'
```

### Send a command and wait for reply event

```bash
# Send in background, stream events to catch the async response
mc events 30 &
mc send 0a53ef "ping"
wait
```

### Dump all contacts with their key prefix

```bash
mc cmd "get_contacts(0)" | jq '.[] | {name: .adv_name, key: .pubkey_prefix}'
```

### Set TX power

```bash
mc cmd "set_tx_power(22)"
```

### Change node name

```bash
mc cmd "set_name(MyNode)"
```

### Request telemetry from a remote repeater

```bash
# req_telemetry_sync(contact, timeout_ms)
mc cmd "req_telemetry_sync(0a53ef, 10000)"
```

### One-liner: full node health summary

```bash
echo "=== core ===" && mc cmd get_stats_core | jq . && \
echo "=== radio ===" && mc cmd get_stats_radio | jq . && \
echo "=== packets ===" && mc cmd get_stats_packets | jq .
```

---

## All known commands

| Command | Args | Description |
|---------|------|-------------|
| `get_stats_core` | — | Battery, uptime, errors, queue |
| `get_stats_radio` | — | RSSI, SNR, noise floor, airtime |
| `get_stats_packets` | — | Packet counters (recv/sent/flood/direct) |
| `get_bat` | — | Battery level and storage info |
| `get_time` | — | Device clock |
| `get_contacts` | lastmod | All contacts (0 = all) |
| `get_self_telemetry` | — | Environmental sensors on companion |
| `get_custom_vars` | — | Stored key/value pairs |
| `get_path_hash_mode` | — | Current path hash mode |
| `get_autoadd_config` | — | Auto-add contact configuration |
| `send_appstart` | — | Re-initialize firmware |
| `send_device_query` | — | Device info query |
| `send_advert` | bool | Broadcast an advert |
| `reboot` | — | Reboot companion node |
| `set_name` | str | Set node display name |
| `set_tx_power` | int | Set TX power in dBm |
| `set_coords` | lat, lon | Set GPS coordinates |
| `set_time` | int | Set device clock (unix ts) |
| `set_radio` | freq, bw, sf, cr | Set radio parameters |
| `set_flood_scope` | str | Set flood scope |
| `req_status_sync` | contact | Query repeater status over LoRa |
| `req_telemetry_sync` | contact, timeout | Query repeater telemetry |
| `req_neighbours_sync` | contact | Get repeater neighbour list |
| `req_basic_sync` | contact | Basic node info from repeater |
| `send_login` | contact, password | Login to repeater admin |
| `send_msg` | contact, message | Send direct message |
| `send_chan_msg` | channel, message | Send channel message |
| `send_cmd` | contact, command | Send remote command |
| `reset_path` | contact | Reset route to contact |
| `remove_contact` | contact | Remove a contact |
| `export_contact` | contact | Export contact data |
| `export_private_key` | — | Export device private key |
