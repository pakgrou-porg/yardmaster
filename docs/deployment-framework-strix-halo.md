<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Yardmaster on a Framework Desktop (Ryzen AI Max+ 395 / Strix Halo), Fedora 44

Target box: AMD Ryzen AI Max+ 395 (16 × Zen 5), Radeon 8060S iGPU (RDNA 3.5,
`gfx1151`), 128 GB LPDDR5x unified memory, Fedora 44. Deployed with Docker +
Portainer.

This runs two containers on the one machine:

- **`yardmaster-ollama`** — `ollama/ollama:rocm`, GPU-accelerated on the 8060S,
  on `127.0.0.1:11435`.
- **`yardmaster`** — the router, host networking, fronting the LAN on
  `11434` / `1234` and forwarding to the engine.

Stack file: [`../deploy/portainer/examples/framework-strix-halo.stack.yml`](../deploy/portainer/examples/framework-strix-halo.stack.yml).

> **Status.** The `yardmaster` container builds with `target: runtime-proxy`
> (Go workers only) — a working PAIR-style router **without** Switchyard model
> selection or the `:4000` Anthropic ingress. The full data plane lands with
> [#36](https://github.com/pakgrou-porg/yardmaster/issues/36) /
> [#26](https://github.com/pakgrou-porg/yardmaster/issues/26); see
> [#46](https://github.com/pakgrou-porg/yardmaster/issues/46). If all you want
> today is fast local inference on the Framework, the `yardmaster-ollama`
> service alone gets you there and you can add the router layer later.

---

## 1. BIOS — give the iGPU enough memory

On Strix Halo the amount of VRAM ROCm sees is driven by the firmware carve-out.
Reboot into BIOS and set the iGPU / UMA framebuffer:

| BIOS wording (varies) | Set to |
| --- | --- |
| "UMA Frame Buffer Size" / "iGPU Memory" / "Dedicated Graphics Memory" | **at least 48 GB**, 64–96 GB if you want 70B-class models |
| "UMA Mode" | `UMA_SPECIFIED` / `Dedicated` (not `Auto`) |

Linux `amdgpu` can also lend system RAM to the GPU via GTT, but current
ROCm/Ollama sizing on `gfx1151` keys off the dedicated carve-out, so set it
generously — you have 128 GB. Leave enough for the OS and the router
(16–32 GB is plenty).

Verify after boot:

```bash
sudo dnf install -y rocminfo    # or run rocminfo inside the container later
rocminfo | grep -A3 -i 'gfx1151\|Marketing Name'
# and the pool size:
rocminfo | grep -A2 'Pool 1' | grep Size
```

---

## 2. Fedora 44 prerequisites

### 2.1 Docker CE

Portainer's stack semantics (`network_mode: host`, compose build targets) are
smoothest on Docker CE.

```bash
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"      # log out/in for this to take effect
```

If Docker CE has no Fedora 44 build yet, either point the repo at the Fedora 41
packages (they work) or use **podman** instead:

```bash
sudo dnf -y install podman podman-docker podman-compose
systemctl --user enable --now podman.socket
export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock
```

Podman works with Portainer and the stack files; the `:Z` SELinux relabel and
`--device` passthrough behave the same. Rootless podman + `/dev/kfd` needs
`--group-add keep-groups` semantics — prefer the root podman socket
(`sudo systemctl enable --now podman.socket`, `DOCKER_HOST=unix:///run/podman/podman.sock`)
for GPU work.

### 2.2 SELinux (enforcing by default on Fedora)

Allow containers to use the GPU device nodes, and expect to relabel bind mounts:

```bash
sudo setsebool -P container_use_devices on
```

- Named volumes (what this stack uses for data and models) are relabeled
  automatically.
- Any **bind mount** you add (e.g. a pinned `yardmaster.toml`) needs a `:ro,Z`
  (private) or `:ro,z` (shared) suffix in the compose `volumes:` short syntax,
  or SELinux will deny the read. The stack file has a commented example.
- If something is still denied: `sudo ausearch -m avc -ts recent` and, as a last
  resort for debugging only, `--security-opt label=disable` on the offending
  service.

### 2.3 firewalld

Open the ingress ports for other machines on your LAN, and mDNS for discovery:

```bash
sudo firewall-cmd --permanent --add-port=11434/tcp    # Ollama-compatible ingress
sudo firewall-cmd --permanent --add-port=1234/tcp     # OpenAI-compatible ingress
sudo firewall-cmd --permanent --add-port=4000/tcp     # Anthropic + /health + /metrics (after #36)
sudo firewall-cmd --permanent --add-service=mdns
sudo firewall-cmd --reload
```

Do **not** open `14318` (PAIR node telemetry, plaintext) or `3080` (dsh Web UI)
to the LAN.

### 2.4 render / video groups

Add yourself (for host-side `rocminfo` / `amdgpu_top`) — the container gets
access via `group_add` in the stack:

```bash
sudo usermod -aG render,video "$USER"
getent group render video      # note the GIDs; if group_add by name fails in
                               # the stack, put these numbers there instead
```

### 2.5 Portainer

```bash
docker volume create portainer_data
docker run -d --name portainer --restart unless-stopped \
  -p 9443:9443 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v portainer_data:/data \
  portainer/portainer-ce:latest
```

Open `https://<framework-ip>:9443` and set the admin password.

---

## 3. Deploy the stack

### Option A — from the Git repository (recommended)

1. Portainer → **Stacks → Add stack → Repository**.
2. Repository URL `https://github.com/pakgrou-porg/yardmaster`, reference
   `refs/heads/main`, Compose path
   `deploy/portainer/examples/framework-strix-halo.stack.yml`.
3. **Environment variables** (all optional): `NVPAIR_LOG_LEVEL`,
   `OPENROUTER_API_KEY`, `VENICE_API_KEY`, `KIE_API_KEY`.
4. **Deploy the stack.** The first deploy builds the `yardmaster` image
   (`target: runtime-proxy`) from the repo — a few minutes for the Go toolchain
   layer, then cached.

### Option B — web editor

Paste the stack file, set variables, deploy. Portainer clones the repo for the
build context automatically only in Option A; in the editor you must have the
repo checked out on the host and point `build.context` at it, or switch the
`yardmaster` service to a prebuilt image once one is published
([#46](https://github.com/pakgrou-porg/yardmaster/issues/46)).

---

## 4. Pull a model and point a client

```bash
docker exec -it yardmaster-ollama ollama pull qwen4:12b
docker exec -it yardmaster-ollama ollama pull qwen4:72b       # fits easily in 128 GB

# through Yardmaster (host networking -> port 11434 on the Framework's LAN IP):
curl http://<framework-ip>:11434/api/chat -d '{
  "model": "qwen4:12b",
  "messages": [{"role":"user","content":"one sentence on unified memory"}]
}'
```

Any Ollama or OpenAI-compatible client on the LAN can now target
`http://<framework-ip>:11434` (or `:1234/v1`) unchanged.

---

## 5. Add routing config (optional, and once the data plane lands)

Create `/etc/yardmaster/yardmaster.toml`, uncomment the bind mount in the stack
(`:ro,Z`), redeploy. Start from
[`../deploy/portainer/yardmaster.toml.example`](../deploy/portainer/yardmaster.toml.example):
point a `[providers.local_ollama]` at `http://127.0.0.1:11435` and define your
routes / tiers per [routing.md](routing.md) and [plan-execute.md](plan-execute.md).
Validate before redeploying:

```bash
docker run --rm -v /etc/yardmaster/yardmaster.toml:/config/yardmaster.toml:ro,Z \
  --entrypoint /opt/yardmaster/bin/yardmaster-dataplane \
  yardmaster:proxy-local dry-run --config /config/yardmaster.toml
```

(The `dry-run` subcommand exists once the Rust data plane is in the image — #36.)

---

## 6. Confirm the GPU is doing the work

```bash
# GPU visible to ROCm inside the engine container:
docker exec -it yardmaster-ollama rocminfo | grep -i 'gfx1151\|Marketing Name'

# model loaded on GPU, not CPU:
docker exec -it yardmaster-ollama ollama ps      # look for "100% GPU"

# live utilisation on the host:
sudo dnf install -y amdgpu_top && amdgpu_top      # or: radeontop
```

If `ollama ps` shows `100% CPU`, the model did not offload — see Troubleshooting.

---

## 7. Tuning for 128 GB unified memory

Set on the `ollama` service (the stack has sane defaults):

| Variable | Suggested | Why |
| --- | --- | --- |
| `OLLAMA_KEEP_ALIVE` | `30m` or `-1` | keep big models resident; you have the RAM |
| `OLLAMA_MAX_LOADED_MODELS` | `3` | a planner + a worker + a judge tier at once |
| `OLLAMA_NUM_PARALLEL` | `4` | Yardmaster fans subagents out; let the engine batch |
| `OLLAMA_FLASH_ATTENTION` | `1` | faster, less memory for long context |
| `OLLAMA_KV_CACHE_TYPE` | `q8_0` (optional) | big context windows without a big cache |

With the router in front, prefer a `plan_execute` route: a 70B planner tier and
a 12B–14B worker tier both stay hot in memory, and Yardmaster picks per turn.

---

## 8. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `ollama ps` shows `100% CPU`; logs say "no compatible GPUs" | Set `HSA_OVERRIDE_GFX_VERSION: "11.5.1"` on the `ollama` service and restart. If still failing, try `"11.0.0"`. |
| ROCm sees only a few GB of VRAM | Raise the BIOS UMA / iGPU memory carve-out (section 1). |
| `permission denied` on `/dev/kfd` | `sudo setsebool -P container_use_devices on`; confirm `group_add: [video, render]` maps to real GIDs (section 2.4). |
| `rocminfo` in the container errors on a syscall | Uncomment `security_opt: [seccomp=unconfined]` on the `ollama` service. |
| Other LAN machines cannot reach `:11434` | firewalld (section 2.3); confirm `yardmaster` is `network_mode: host` and bound to the LAN interface. |
| SELinux `AVC` denials in `ausearch` for a bind mount | add `:Z` (or `:z`) to that mount in the stack. |
| Portainer build fails in the `rust-build` stage | Expected until [#36](https://github.com/pakgrou-porg/yardmaster/issues/36); the stack uses `target: runtime-proxy` which skips it. If you edited the target, revert. |
| Model loads but is very slow | Check `amdgpu_top` for VRAM spillover to GTT; lower the quant or raise the BIOS carve-out. Vulkan (`ollama` Vulkan backend or a `llama.cpp` Vulkan container) is a reliable fallback on Strix Halo. |

---

## 9. Add a second node

Deploy the same stack on another machine on the LAN (any OS Yardmaster
supports). Pair them with the six-digit PIN — until the headless pairing helper
lands ([#46](https://github.com/pakgrou-porg/yardmaster/issues/46)) use the
bundled TUI:

```bash
docker exec -it yardmaster /opt/yardmaster/bin/nvpair-tui
```

Read the PIN on one node, enter it on the other. The mTLS cluster forms and the
`yardmaster-data` volume on each node persists the identity across restarts.
Yardmaster then places requests across both nodes' engines.

## 10. Backups

```bash
docker run --rm -v yardmaster-data:/data -v "$PWD":/backup busybox \
  tar czf /backup/yardmaster-data.tgz -C /data .
```

Losing `yardmaster-data` means re-pairing. The Ollama model volume is just a
cache — re-pull if lost.
