<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Yardmaster on a Framework Desktop (Ryzen AI Max+ 395 / Strix Halo), Fedora 43/44

Target: AMD Ryzen AI Max+ 395 (16 × Zen 5), Radeon 8060S iGPU (RDNA 3.5,
`gfx1100` per `rocminfo` on this host), 128 GB LPDDR5x unified memory, Fedora 43/44, Docker + Portainer.

Three containers, one shared network namespace:

| Service | What | Reach it at |
| --- | --- | --- |
| `ollama` (`ollama/ollama:rocm`) | the engine, GPU-accelerated on the 8060S | `127.0.0.1:11434` (in-namespace) |
| `yardmaster` (`--target runtime-proxy`) | the broker + Ollama proxy | loopback `:11435` in-namespace |
| `yardmaster-lan-shim` (`socat`) | loopback→LAN bridge for the proxy | **host `:11435`** — point LAN clients here |
| `yardmaster-console` | config editor + backend health + metrics + embedded dsh | **`:8770`** — Framework loopback |

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
# do NOT open 8770 (console), 14318 (telemetry) or 3080 (dsh) to the LAN
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

## 6. The Console

Open **`http://127.0.0.1:8770`** on the Framework (or tunnel it — do not expose
to the LAN without auth).

- **Config** — paste/edit `yardmaster.toml`, **Validate**, **Save**. Saves to
  the bind-mounted file if writable, else the data-dir copy.
- **Backends** — live up/down + latency + model list for `local_ollama`,
  `asus_util`, `susa`, … This is your "is Yardmaster seeing the backends" view
  today.
- **Metrics** — empty until the data plane writes events; the schema is in
  place.
- **Agent** — the embedded DeepSeek Harness Web UI (see next).

---

## 7. DeepSeek Harness, routed through Yardmaster

Until the `dsh-yardmaster` adapter has a data plane to talk to, run `dsh` with
its **built-in OpenAI adapter pointed at the Yardmaster proxy**, so Yardmaster
still does the placement/failover across your Ollama node(s):

```bash
# on the Framework
npx @deepseek-ai/dsh@0.1.2-rc.1 web --no-open \
  --set llm.openai.baseURL=http://127.0.0.1:11435/v1 \
  --set llm.openai.apiKey=sk-unused \
  --set agent.defaultModel.provider=openai \
  --set agent.defaultModel.model=llama3.2
# -> http://127.0.0.1:3080  ->  shows up in the Console's Agent tab
```

(Exact `--set` keys depend on the pinned dsh version; `--dump-config` lists
them. When `YM_DATAPLANE_MODE=dataplane` exists, switch to
`dsh --profile yardmaster-web` and the adapter handles tiers + correlation.)

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
| `nvpair-node-info: detected 0 GPU(s)` / `nvidia-smi unavailable` | expected on AMD — PAIR's telemetry is NVIDIA-only. Does **not** affect the engine's GPU use; only the scheduler's GPU-pressure / `vram_aware` signals, which don't matter for a single node. Tracked in [#48](https://github.com/pakgrou-porg/yardmaster/issues/48). |
| SELinux `AVC` denial on a bind mount | add `:Z` (or `:z`) to that mount (the stack already has it on `yardmaster.toml`) |
| Portainer build fails in `rust-build` | expected until [#36](https://github.com/pakgrou-porg/yardmaster/issues/36) — the stack uses `target: runtime-proxy`, which skips it; don't change the target |
| "container name already in use" on redeploy | `docker rm -f yardmaster yardmaster-ollama yardmaster-console yardmaster-init` then redeploy (Portainer + explicit `container_name`) |

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
