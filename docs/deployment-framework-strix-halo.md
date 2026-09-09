<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Yardmaster on a Framework Desktop (Ryzen AI Max+ 395 / Strix Halo), Fedora 43/44

Target: AMD Ryzen AI Max+ 395 (16 × Zen 5), Radeon 8060S iGPU (RDNA 3.5,
`gfx1100` per `rocminfo` on this host), 128 GB LPDDR5x unified memory, Fedora 43/44, Docker + Portainer.

One shared network namespace (owned by `ollama`); every other service joins it
with `network_mode: service:ollama`, so all published ports are declared on
`ollama`:

| Service | What | Reach it at |
| --- | --- | --- |
| `ollama` (`ollama/ollama:rocm`) | the engine, GPU-accelerated on the 8060S | `127.0.0.1:11434` (in-namespace) |
| `yardmaster` (`--target runtime-proxy`) | the broker + Ollama proxy | loopback `:11435` in-namespace |
| `yardmaster-lan-shim` (`socat`) | loopback→LAN bridge for the proxy | **host `:11435`** — point LAN clients here |
| `yardmaster-harness` | the DeepSeek Harness Web UI (`dsh web`), own `yardmaster-harness` volume | loopback `:3080` in-namespace |
| `yardmaster-harness-proxy` (Node) | loopback→publish bridge for dsh + optional Basic Auth + WS | **`:3080`** — `${YM_BIND}` |
| `yardmaster-console` | config editor + backend health + metrics + link to the Harness | **`:8770`** — `${YM_BIND}` |

**LAN access.** The Console and Harness publish on `127.0.0.1` by default. Set
the stack env var **`YM_BIND=0.0.0.0`** to expose both to your LAN, and
**`YM_LAN_HOST=<framework-ip>`** (e.g. `10.116.2.145`) so dsh's browser-trust
fence accepts that authority. Set **`YM_AUTH_ENABLED=1`** + `YM_AUTH_USER` +
`YM_AUTH_PASS` to require a login on both. See §6.

Stack file: [`../deploy/portainer/examples/framework-strix-halo.stack.yml`](../deploy/portainer/examples/framework-strix-halo.stack.yml).

> **Why a shared namespace?** The `yardmaster` entrypoint registers the local
> engine as a manual node at `127.0.0.1:11434`, so engine and proxy must share
> loopback. All four services run `network_mode: service:ollama` and every
> published port is declared on the `ollama` service.

> **The proxy is loopback-only for plaintext — by design.** PAIR's security
> model: a non-loopback plaintext request to the proxy gets **`403`** (`rejected
> non-loopback plaintext request; cluster peers must use mTLS`). Only paired
> cluster nodes may reach it over the LAN (mTLS). So this stack runs a tiny
> `socat` sidecar (`yardmaster-lan-shim`) that accepts LAN traffic on `:11430`
> and forwards it through a fresh `127.0.0.1:11435` connection — the proxy sees
> loopback and serves it. Host port `11435` maps to the shim. See
> [security.md](security.md). (For a machine you control, the "right" long-term
> answer is to run Yardmaster on it too and pair the two — then it points at its
> own `localhost` and the cluster forwards.)

> **Verified working on this host (Fedora 43, Docker 29.8):** ROCm inference
> **through the proxy on `:11435`** (`POST /v1/chat/completions` reaches the
> engine and returns a response), the Console (config editing + Validate + live
> backend probes), and the embedded dsh UI. The `yardmaster` `runtime-proxy`
> image builds from source in Portainer. **Not yet:** Switchyard
> model-selection, the `:4000` Anthropic ingress, and routing to the Asus/Susa
> vLLM nodes by config — all need `YM_DATAPLANE_MODE=dataplane`
> ([#36](https://github.com/pakgrou-porg/yardmaster/issues/36) →
> [#26](https://github.com/pakgrou-porg/yardmaster/issues/26)). See
> [ADR-0024](decisions/0024-container-sibling-engine-wiring.md) for how the
> container wires the engine (engine-manager removed; a FIFO holds the broker's
> stdin open — **no `stdin_open` / `tty` needed**; a `node/add` frame registers
> the engine).

---

## 1. BIOS — give the iGPU memory

Reboot → BIOS → set the iGPU / UMA framebuffer:

| BIOS wording (varies) | Set to |
| --- | --- |
| "UMA Frame Buffer Size" / "iGPU Memory" / "Dedicated Graphics Memory" | **≥ 48 GB** (64–96 GB for 70B-class models) |
| "UMA Mode" | `UMA_SPECIFIED` / `Dedicated` (not `Auto`) |

Current ROCm/Ollama VRAM sizing keys off this carve-out. Leave
16–32 GB for the OS + router.

Verify after boot: `rocminfo | grep -A2 'Pool 1' | grep Size`.

---

## 2. Fedora 43/44 host prep

```bash
# --- Docker CE ---
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"        # log out / back in
# (If there is no matching Fedora build yet, point the repo at Fedora 41 packages, or
#  use rootful podman: sudo systemctl enable --now podman.socket)

# --- SELinux: let containers use the GPU device nodes ---
sudo setsebool -P container_use_devices on

# --- firewalld: open the LAN-facing proxy + mDNS; keep the rest closed ---
sudo firewall-cmd --permanent --add-port=11435/tcp     # the Yardmaster proxy
sudo firewall-cmd --permanent --add-service=mdns
# Only if you set YM_BIND=0.0.0.0 to reach the Console + Harness from the LAN
# (see §6 — neither has real auth; prefer restricting the source):
#   sudo firewall-cmd --permanent --add-port=8770/tcp   # Console  (no auth)
#   sudo firewall-cmd --permanent --add-port=3080/tcp   # Harness  (token + cookie only)
# Never open 14318 (telemetry) to the LAN.
sudo firewall-cmd --reload

# --- render / video GIDs (for host-side rocminfo; container gets them via the stack) ---
sudo usermod -aG render,video "$USER"
getent group render video               # note the GIDs -> put them in group_add

# --- Portainer ---
docker volume create portainer_data
docker run -d --name portainer --restart unless-stopped -p 9443:9443 \
  -v /var/run/docker.sock:/var/run/docker.sock -v portainer_data:/data \
  portainer/portainer-ce:latest
```

Open `https://<framework-ip>:9443`, set the admin password.

---

## 3. `yardmaster.toml` (optional now, used later)

Create `/etc/yardmaster/yardmaster.toml`. In `runtime-proxy` mode the proxy does
**not** read it — the Console does (for the Backends probe and validation), and
the data plane will once it exists. Express your local + remote nodes in the
**real schema** (a strict superset of Switchyard's):

```toml
schema_version = 1

[egress]
allow_lan = true        # 10.x.x.x vLLM nodes are private-range
allow_remote = false

[providers.local_ollama]
kind = "openai_compatible"
base_url = "http://127.0.0.1:11434"

[providers.asus_util]
kind = "openai_compatible"
base_url = "http://10.116.2.56:8002/v1"

[providers.susa]
kind = "openai_compatible"
base_url = "http://10.116.2.120:8000/v1"

[targets]

[targets.local]
id = "llama3.2"
locality = "lan"
provider = "local_ollama"

[targets.util]
id = "gemma-4-12b-utility"
locality = "lan"
provider = "asus_util"

[targets.qwen_big]
id = "qwen3.6-35b-a3b"
locality = "lan"
provider = "susa"

[routes.default]
id = "auto"
type = "passthrough"
target = "local"
```

There is **no `[engines.*]` table** and `[cluster]` is broker-written, not user
config. The Console's **Validate** button catches schema mistakes.

---

## 4. Deploy the stack in Portainer

**Stacks → Add stack → Repository:**

- URL `https://github.com/pakgrou-porg/yardmaster`, ref `refs/heads/main`,
  Compose path `deploy/portainer/examples/framework-strix-halo.stack.yml`.
- The first deploy builds `yardmaster` (`runtime-proxy`, Go workers) and
  `yardmaster-console` from the repo. A few minutes, then cached.
- If the `yardmaster` build fails, deploy without it (delete that service) — the
  `ollama` + `yardmaster-console` services still give you GPU inference plus the
  config/health UI.

Verify the `group_add` GIDs match `getent group video render` from step 2;
replace `"39"` / `"105"` if they differ.

---

## 5. Pull models, point clients

Use **real** Ollama model names (browse <https://ollama.com/library>). The spec's
`qwen4:*` / `nemotron-*` are placeholders and do not exist in the registry.

```bash
# you already have llama3.2 (~2 GB) — nothing to pull for a first test.
docker exec -it yardmaster-ollama ollama pull qwen3:14b        # or gemma3:12b, deepseek-r1:14b
docker exec -it yardmaster-ollama ollama pull qwen3:32b        # bigger; 70B-class fits 128 GB too (llama3.3:70b, qwen2.5:72b)

# through the Yardmaster proxy, from any LAN machine (model = whatever you pulled):
curl http://<framework-ip>:11435/api/chat -d '{"model":"llama3.2","messages":[{"role":"user","content":"hi"}]}'
# or OpenAI-style:
curl http://<framework-ip>:11435/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"llama3.2","messages":[{"role":"user","content":"hi"}]}'
```

The entrypoint registers the engine ~10 s after the broker starts
(`YM_MANUAL_NODE_DELAY`); `docker logs yardmaster | grep "manual node"` should
show `ollama_up=true models=N`. If the proxy still returns `no available node
advertises the requested model`, the engine isn't on `127.0.0.1:11434` in the
shared namespace — check `OLLAMA_HOST` and that `network_mode: service:ollama`
is set. As a fallback, add `- "11434:11434"` to the `ollama` service and point
clients there directly.

---

## 6. The Console and Harness on your LAN

Both are their own Portainer services in this stack. By default they publish on
`127.0.0.1` only. To reach them from any machine on your LAN, set two stack env
vars (Portainer → *Stack* → *Environment variables*, or an `.env`):

| Env var | Set to | Effect |
| --- | --- | --- |
| `YM_BIND` | `0.0.0.0` | publish `:8770` (Console) and `:3080` (Harness) on every interface |
| `YM_LAN_HOST` | your Framework LAN IP, e.g. `10.116.2.145` | added to dsh's `--trusted-host` list so a browser on `http://<ip>:3080` isn't rejected |
| `YM_AUTH_ENABLED` | `1` | require HTTP Basic Auth in front of **both** the Console and the Harness |
| `YM_AUTH_USER` / `YM_AUTH_PASS` | your choice | the credentials (or `YM_AUTH_PASS_FILE=/run/secrets/…` for a Docker secret) |

Redeploy the stack after changing them. Then open **`http://<framework-ip>:8770`**
(Console) from anywhere on the LAN; the Console's **Agent** tab links to
**`http://<framework-ip>:3080`** with the current token (it rewrites the host in
the URL to match however *you* reached the Console, so the link works from
loopback and from the LAN).

### Authentication (`YM_AUTH_ENABLED=1`)

Set `YM_AUTH_ENABLED=1` + `YM_AUTH_USER` + `YM_AUTH_PASS` in the stack env / `.env`.
That turns on HTTP Basic Auth for:

- the **Console** (`:8770`) — enforced natively in the server;
- the **Harness** (`:3080`) — enforced by the `yardmaster-harness-proxy` sidecar
  (a small Node HTTP+WebSocket reverse proxy that replaces the old `socat` shim),
  which sits in front of `dsh` and also proxies its WebSocket.

The credentials live in the stack definition, so they are **durable across
restarts and reboots**. With `YM_AUTH_ENABLED=1` the Console and the proxy
**refuse to start** unless both user and pass are set — they never run open.
`/healthz` stays open so the container health probe still works. This is *in
addition to* dsh's own launch-token + signed cookie, not a replacement.

> **Without auth**, anyone who reaches `:8770` can rewrite `yardmaster.toml`, and
> anyone with the tokened Harness URL gets a shell-capable agent on that
> container. On a trusted home LAN behind one router that is usually acceptable;
> on anything shared, set `YM_AUTH_ENABLED=1` and/or restrict the source in
> firewalld:
> ```bash
> sudo firewall-cmd --permanent --add-rich-rule=\
> 'rule family="ipv4" source address="10.116.2.0/24" port port="8770" protocol="tcp" accept'
> ```

Console tabs:

- **Config** — paste/edit `yardmaster.toml`, **Validate**, **Save**. Saves to
  the bind-mounted file if writable, else the `yardmaster-data` copy at
  `/data/Nvidia Corporation/Personal AI Router/yardmaster.toml` (a stale
  dangling symlink there from an old `:ro` bind mount is detected and replaced).
- **Backends** — live up/down + latency + model list for `local_ollama`,
  `asus_util`, `susa`, …
- **Metrics** — empty until the data plane writes events; the schema is in
  place.
- **Agent** — links to the Harness Web UI with its current token (see §7).

---

## 7. DeepSeek Harness, routed through Yardmaster

The Harness runs as the **`yardmaster-harness`** service — `dsh web` on
in-namespace loopback `:3080` (dsh refuses to bind `0.0.0.0` because it executes
model code), published via the **`yardmaster-harness-proxy`** sidecar (Node
HTTP+WebSocket reverse proxy; adds Basic Auth when `YM_AUTH_ENABLED=1`, plain
pass-through otherwise).

**Token persistence.** `dsh` mints a fresh launch token every start, but on
first use it sets a **signed cookie** derived from a secret in `DSH_HOME`. This
stack gives the Harness its **own named volume `yardmaster-harness` mounted at
`/dshhome`** (`DSH_HOME=/dshhome`), so that secret — and your sessions and
credentials — **persist across restarts**: once a browser has the cookie it
stays logged in; you don't re-paste the token on every container restart. The
entrypoint (`docker/harness-entrypoint.sh`) also writes the *current* tokened
URL to `/dshhome/web-url`, which the Console reads (mounted `:ro`) so its
**Agent** tab always links to a working URL without you grepping logs.

**Do not pass `--set` via `YM_HARNESS_EXTRA_ARGS`.** `dsh web` only accepts
`--host` / `--port` / `--trusted-host` / `--no-open`; `--set` is a *top-level*
`dsh` flag and passing it here makes dsh exit (`unknown option '--set'`) and the
service crash-loop — nothing then listens on `:3080`. The entrypoint strips a
leading `--set …` pair with a warning, but don't rely on that.

To change the Harness's default model, use its **Settings** UI, or edit the
persistent profile patch on the `yardmaster-harness` volume. `cordis.patch.yml`
**must be a top-level YAML array** — an empty or malformed file makes dsh exit
`must be a top-level YAML array of loader patch entries` and crash-loop. Write it
with `printf` (do **not** pipe a heredoc into `docker run` without `-i`, which
silently produces an empty file):

```bash
docker run --rm -v yardmaster-harness:/dshhome alpine sh -c '
  mkdir -p /dshhome/profiles/web
  printf "%s\n" \
    "- id: agent-default-model" \
    "  config:" \
    "    provider: deepseek-official" \
    "    model: deepseek-v4-flash" \
    > /dshhome/profiles/web/cordis.patch.yml
  chown -R 10001:10001 /dshhome/profiles
'
docker restart yardmaster-harness
```

To undo an override, reset the file to an empty array:

```bash
docker run --rm -v yardmaster-harness:/dshhome alpine \
  sh -c 'printf "[]\n" > /dshhome/profiles/web/cordis.patch.yml'
docker restart yardmaster-harness
```

When `YM_DATAPLANE_MODE=dataplane` exists, switch to `dsh --profile
yardmaster-web` and the adapter handles tiers + correlation.

---

## 8. Confirm the GPU is working

```bash
docker exec -it yardmaster-ollama rocminfo | grep -i 'gfx110\|Marketing Name'
docker exec -it yardmaster-ollama ollama ps        # want "100% GPU"
sudo dnf install -y amdgpu_top && amdgpu_top
```

---

## 9. Tuning for 128 GB

Set on the `ollama` service (defaults in the stack are sane):

| Variable | Suggested | Why |
| --- | --- | --- |
| `OLLAMA_KEEP_ALIVE` | `30m` or `-1` | keep big models resident |
| `OLLAMA_MAX_LOADED_MODELS` | `3` | a planner + worker + judge tier hot at once |
| `OLLAMA_NUM_PARALLEL` | `4` | let the engine batch concurrent requests |
| `OLLAMA_FLASH_ATTENTION` | `1` | faster, less memory for long context |
| `OLLAMA_KV_CACHE_TYPE` | `q8_0` (optional) | big context without a big cache |

---

## 10. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `ollama ps` shows `100% CPU` / "no compatible GPUs" | `rocminfo` on this host reports the 8060S as `gfx1100`, natively supported — no override needed. If a build still falls back to CPU, try `HSA_OVERRIDE_GFX_VERSION: "11.0.0"` on `ollama`. |
| ROCm sees only a few GB VRAM | raise the BIOS UMA carve-out (§1) |
| `permission denied` on `/dev/kfd` | `sudo setsebool -P container_use_devices on`; confirm `group_add: ["39","105"]` = `getent group video render` (39/105 on this host) |
| `rocminfo` errors on a syscall | uncomment `security_opt: [seccomp=unconfined]` on `ollama` |
| proxy `:11435`: `no available node advertises the requested model` | the entrypoint's `node/add` didn't land — check `docker logs yardmaster \| grep "manual node"`, that the engine is on `127.0.0.1:11434`, and `YM_LOCAL_ENGINE_URL` is set. Bump `YM_MANUAL_NODE_DELAY` if the engine is slow to start. |
| `yardmaster` container exits ~30 s after start with no error | you're on an old image — pull/rebuild; the current entrypoint holds the broker's stdin open via a FIFO (no `stdin_open` needed) |
| LAN clients get `403` / "rejected non-loopback plaintext" | expected without the shim — confirm `yardmaster-lan-shim` is running and the `ollama` service publishes `11435:11430` |
| LAN clients cannot reach `:11435` at all | firewalld (§2, `--add-port=11435/tcp`); confirm `yardmaster-lan-shim` is `Up` |
| Console/Harness only reachable on `127.0.0.1` | set `YM_BIND=0.0.0.0` **and** `YM_LAN_HOST=<framework-ip>`, redeploy; open the ports in firewalld (§2) |
| Harness in the browser: `Blocked request. This host is not allowed` | dsh's trust fence — `YM_LAN_HOST` is unset or wrong. Set it to the exact IP you type in the URL bar and redeploy. Add more with `YM_HARNESS_TRUSTED_HOSTS` (space-separated `host:port`). |
| Harness asks for the token again after every restart | you're not on a persistent `DSH_HOME` — confirm the `yardmaster-harness` volume is mounted at `/dshhome` and `yardmaster-init` chowned it to `10001` |
| Console Agent tab shows a loopback URL from a LAN browser | old image — rebuild `yardmaster-console`; the current `/api/agent` rewrites the host from your request |
| `yardmaster-harness` exits / `dsh: not found` | old `yardmaster:proxy-local` — rebuild; the Dockerfile symlinks `dsh` → `…/@deepseek-ai/dsh/lib/bin.js` |
| `yardmaster-harness` crash-loops with `error: unknown option '--set'` | you passed `--set …` in `YM_HARNESS_EXTRA_ARGS` — `dsh web` doesn't take it. Remove that env var (or set the model via `cordis.patch.yml`, §7) and redeploy. |
| `yardmaster-harness` crash-loops: `cordis.patch.yml must be a top-level YAML array` | the overlay file is empty or malformed (often from piping a heredoc into `docker run` without `-i`). Reset it: `docker run --rm -v yardmaster-harness:/dshhome alpine sh -c 'printf "[]\n" > /dshhome/profiles/web/cordis.patch.yml'` then `docker restart yardmaster-harness`. The current entrypoint also auto-heals a blank file. |
| Harness browser prompts for a username/password | `YM_AUTH_ENABLED=1` — enter `YM_AUTH_USER` / `YM_AUTH_PASS`. To turn it off, unset `YM_AUTH_ENABLED` and redeploy. |
| `yardmaster-harness-proxy` won't start: `refusing to start open` | `YM_AUTH_ENABLED=1` but `YM_AUTH_USER` or `YM_AUTH_PASS` is empty — set both, or unset `YM_AUTH_ENABLED`. |
| `nvpair-node-info: detected 0 GPU(s)` / `nvidia-smi unavailable` | expected on AMD — PAIR's telemetry is NVIDIA-only. Does **not** affect the engine's GPU use; only the scheduler's GPU-pressure / `vram_aware` signals, which don't matter for a single node. Tracked in [#48](https://github.com/pakgrou-porg/yardmaster/issues/48). |
| SELinux `AVC` denial on a bind mount | add `:Z` (or `:z`) to that mount (the stack already has it on `yardmaster.toml`) |
| Portainer build fails in `rust-build` | expected until [#36](https://github.com/pakgrou-porg/yardmaster/issues/36) — the stack uses `target: runtime-proxy`, which skips it; don't change the target |
| "container name already in use" on redeploy | `docker rm -f yardmaster yardmaster-ollama yardmaster-console yardmaster-init yardmaster-lan-shim yardmaster-harness yardmaster-harness-proxy` then redeploy (Portainer + explicit `container_name`). Also remove the old `yardmaster-harness-shim` if you deployed an earlier revision. |

---

## 11. Second node

Deploy the same stack on another LAN machine. Pair with the PIN via the bundled
TUI until the headless helper lands
([#46](https://github.com/pakgrou-porg/yardmaster/issues/46)):

```bash
docker exec -it yardmaster /opt/yardmaster/bin/nvpair-tui
```

Read the PIN on one, enter it on the other. `yardmaster-data` persists the mTLS
identity across restarts.

## 12. Backups

```bash
docker run --rm -v yardmaster-data:/data -v "$PWD":/backup busybox \
  tar czf /backup/yardmaster-data.tgz -C /data .
```

Losing `yardmaster-data` means re-pairing. The model volume is a cache.
