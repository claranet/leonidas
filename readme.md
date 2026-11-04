# Leonidas

Leonidas is a transparent caching proxy for SNMP traffic, backed by Redis.

## Situation

SNMP polling places a high load on the network devices being polled. For legacy devices, this can have a negative impact on their ability to perform their intended purpose.

## Mission

Leonidas reduces the load that SNMP polling puts on network devices by transparently proxying polls and caching their responses in a distributed key/value store (Redis).

## Execution

Leonidas runs on a Linux host that is in the network path between the SNMP pollers and the devices being polled (i.e. it routes that traffic). It uses iptables to detect SNMP traffic and to redirect it into the proxy.

Several instances can share one Redis. They share both the cached responses and the list of known devices.

### Devices

1. All SNMP traffic (UDP/161) in `PREROUTING` is sent to a dedicated chain (`nat/LEONIDAS`). Leonidas never modifies rules outside of that chain, and removes the chain on shutdown.
2. Traffic to unknown devices hits a rate limited `LOG` rule. The watcher follows the kernel log, picks up the destination address and registers the device in Redis.
3. Every instance is notified (Redis pub/sub), starts a proxy on a random port for the device and adds a `DNAT` rule for it.

A device can also be set to `passthrough`: its traffic is neither proxied nor cached.

### Polls

Leonidas handles an SNMP poll as diagrammed below:

![Poll Handler Flowchart](docs/poll-handler-flowchart.png "Poll Handler Flowchart")

- `GET`, `GETNEXT` and `GETBULK` (SNMPv1/v2c) are cached. The cache key consists of device, version, community (hashed), PDU type, bulk parameters and all requested OIDs, so `snmpwalk`/`snmpbulkwalk` work as expected.
- Concurrent identical polls result in a single request to the device.
- `SET`, SNMPv3 and anything else that cannot be cached is relayed to the device unchanged.
- Responses with `noError` and `noSuchName` are cached, other errors are passed on but not cached.
- If Redis is unavailable, polls still work (memory cache and device only).

Responses are cached in memory for `cache.memoryTtlSec` (default 30 s) and in Redis for `cache.redisTtlSec` (default 300 s).

## Configuration

Configuration is merged from `config/default.json`, then `config/local.json` (or the file in `$LEONIDAS_CONFIG`), then environment variables.

| Setting | Environment variable | Default | Description |
|---|---|---|---|
| `redis.url` | `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection |
| `redis.prefix` | | `leonidas` | Prefix for all Redis keys and channels |
| `proxy.address` | `LEONIDAS_PROXY_ADDRESS` | – | Local address polls are DNAT'ed to (**required**) |
| `cache.memoryTtlSec` | `LEONIDAS_MEMORY_TTL_SEC` | `30` | In-memory cache TTL in seconds (`0` disables it) |
| `cache.redisTtlSec` | `LEONIDAS_REDIS_TTL_SEC` | `300` | Redis cache TTL in seconds |
| `cache.maxEntries` | | `100000` | In-memory cache size |
| `upstream.port` | | `161` | SNMP port of the devices |
| `upstream.timeoutMs` | | `2000` | Timeout per request to a device in ms |
| `upstream.retries` | | `1` | Retries after a timeout |
| `devices.defaultHandler` | | `proxy` | Handler for discovered devices (`proxy` or `passthrough`) |
| `devices.static` | | `[]` | Devices to register on startup, e.g. `{ "ip": "10.0.0.1", "handler": "passthrough" }` |
| `iptables.enabled` | `LEONIDAS_IPTABLES_ENABLED` | `true` | Manage iptables rules |
| `iptables.binary` | | `iptables` | e.g. `iptables-legacy` if the host does not use nftables |
| `watcher.enabled` | `LEONIDAS_WATCHER_ENABLED` | `true` | Discover devices from the kernel log |
| `watcher.file` | `LEONIDAS_WATCHER_FILE` | `/var/log/kern.log` | Kernel log file |
| `http.address` / `http.port` | `LEONIDAS_HTTP_ADDRESS` / `LEONIDAS_HTTP_PORT` | `127.0.0.1` / `8161` | Status endpoint |
| `log.level` | `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` |

A static device may have a fixed `port`. Leonidas then listens on that port, which allows polling Leonidas directly (e.g. with `iptables.enabled: false` during development).

### Managing devices

Devices are stored in the Redis hash `leonidas:devices`. Changes must be announced on the channel of the same name:

```bash
redis-cli hset leonidas:devices 10.0.0.1 '{"ip":"10.0.0.1","handler":"passthrough"}'
redis-cli publish leonidas:devices '{"ip":"10.0.0.1","action":"upsert"}'

redis-cli hdel leonidas:devices 10.0.0.1
redis-cli publish leonidas:devices '{"ip":"10.0.0.1","action":"remove"}'
```

### Status

- `GET /health` – liveness and Redis connectivity
- `GET /devices` – handled devices with cache statistics

## Running

Requirements: Linux, Node.js ≥ 26, root or `CAP_NET_ADMIN`, IP forwarding enabled, Redis.

```bash
npm ci
LEONIDAS_PROXY_ADDRESS=192.168.10.1 node src/index.js
```

### Docker

```bash
docker compose up -d --build
```

The container uses the host network and `NET_ADMIN`, since it manages the host's iptables rules. Adjust `LEONIDAS_PROXY_ADDRESS` in `docker-compose.yml` to an address of the host.

## Development

```bash
npm test
```

The tests need neither root nor Redis. For an end-to-end setup, `vagrant up` starts three VMs:

1. **router** – runs Leonidas and Redis, routes between `poller` and `server`
2. **poller** – issues `snmp*` commands
3. **server** – runs `snmpd`

```bash
# terminal 1
vagrant up
vagrant ssh router
sudo -i
cd /vagrant
node src/index.js
```

```bash
# terminal 2
vagrant ssh poller
snmpbulkwalk -v2c -c public 192.168.20.2 system
```
