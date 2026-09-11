<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Yardmaster on a Framework Desktop (Ryzen AI Max+ 395 / Strix Halo), Fedora 43/44

Target: AMD Ryzen AI Max+ 395 (16 × Zen 5), Radeon 8060S iGPU (RDNA 3.5,
`gfx1100` per `rocminfo` on this host), 128 GB LPDDR5x unified memory,
Fedora 43/44, Docker + Portainer.

## Topology — three containers, zero manual steps

| Service | What it runs | Reach it at |
| --- | --- | --- |
| `ollama` (`ollama/ollama:rocm`) | the engine, GPU-accelerated on the 8060S; **owns the network namespace** | `127.0.0.1:11434` in-namespace |
| `yardmaster` | PAIR broker + Ollama proxy (`:11435`) + **the interim router** (`:4000`, autorouting) + **the Console** (`:8770`) + a LAN bridge (`:11430 → :4000`) | Console on **`:8770`** (`${YM_BIND}`) |
| `yardmaster-harness` | **`dsh web`** (`:3080`, loopback) auto-pointed at the router, behind a Basic-Auth reverse proxy (`:3081`) | Harness on **`:3080`** (`${YM_BIND}`) |

The two Yardmaster containers `network_mode: service:ollama`, so all published
ports are declared on `ollama`. Each self-chowns its named volume and drops to
uid 10001 (`user: "0:0"` in the stack) — no init container.

Published ports (on `ollama`):

| Host port | → | Purpose |
| --- | --- | --- |
| `11435` | LAN bridge → `127.0.0.1:4000` router | inference clients (OpenAI/Ollama API, **autorouting**) |
| `8770` | Console | `${YM_BIND}` |
| `3080` | Harness auth proxy → `dsh` | `${YM_BIND}` |

The router binds `127.0.0.1:4000` (not published). Inference clients reach it on
host `:11435` via the LAN bridge. Set `YM_ROUTER_BIND=0.0.0.0` to also serve it
directly — cloud egress then becomes reachable from the LAN, gated by `[egress]
allow_remote` + an explicit OpenRouter model id. The PAIR proxy still runs on
`:11435` in-namespace for cluster peers (mTLS).

> **`dsh` binds `127.0.0.1` only** (it runs model-generated code and refuses
> `0.0.0.0`). The Basic-Auth reverse proxy (part of `yardmaster-harness`)
> publishes it and also proxies its WebSocket.

Stack file:
[`../deploy/portainer/examples/framework-strix-halo.stack.yml`](../deploy/portainer/examples/framework-strix-halo.stack.yml).
Env template: [`../deploy/portainer/.env.example`](../deploy/portainer/.env.example).

### Authentication — ON by default

One admin credential (scrypt hash at
`/data/Nvidia Corporation/Personal AI Router/console-auth.json` on the
`yardmaster-data` volume, survives restarts) protects **both** the Console and
the Harness. With no credential configured, the Console serves a one-time setup
page and refuses everything else; the Harness proxy returns `503`. `dsh` keeps
its own launch-token + signed cookie underneath.

| Env var | Effect |
| --- | --- |
| *(none)* | first hit on `:8770` → setup page; pick a username + password |
| `YM_AUTH_USER` + `YM_AUTH_PASS` (or `YM_AUTH_PASS_FILE`) | pre-seed the credential from the stack env instead |
| `YM_AUTH_DISABLED=1` | turn auth off entirely — **loopback dev only** |

Do the first-run setup from the host with `YM_BIND=127.0.0.1`, then set
`YM_BIND=0.0.0.0` and redeploy to expose the LAN.

### LAN access

| Env var | Set to |
| --- | --- |
| `YM_BIND` | `0.0.0.0` to publish `:8770` + `:3080` on all interfaces (default `127.0.0.1`) |
| `YM_LAN_HOST` | your Framework LAN IP, e.g. `10.116.2.145` — added to `dsh`'s `--trusted-host` so a LAN browser on `http://<ip>:3080` isn't rejected |

### What works today

Verified on this host (Fedora 43, Docker 29.8): ROCm inference; the Console
(config edit + Validate + backend probes + first-run auth); the Harness
auto-configured to route through Yardmaster.

**Autorouting** is live via the interim **`YM_DATAPLANE_MODE=router`** (the
default in this stack): a Node data plane that routes a request to a
`[targets.*]` by matching model `id`, else the `[routes.default]` route
(`passthrough` / `escalation`), across local Ollama, LAN vLLM, and OpenRouter —
with `[egress]` enforcement, streaming, and per-request rows in the Console
**Metrics** tab. See
[ADR-0027](decisions/0027-interim-node-router.md).

**Not the router (still [#36](https://github.com/pakgrou-porg/yardmaster/issues/36)
→ [#26](https://github.com/pakgrou-porg/yardmaster/issues/26)):** Switchyard
learned model-selection / `plan_execute`, PAIR GPU-pressure placement, tiers, the
`stage_router` / `llm_classifier` route types, the `:4000` Anthropic wire
protocol, cost estimation. When the Rust `yardmaster-dataplane` lands it is a
drop-in swap (`yardmaster.toml` + the metrics schema are unchanged).

---

## 1. BIOS — give the iGPU memory

Reboot → BIOS → set the iGPU / UMA framebuffer:

| BIOS wording (varies) | Set to |
| --- | --- |
| "UMA Frame Buffer Size" / "iGPU Memory" / "Dedicated Graphics Memory" | **≥ 48 GB** (64–96 GB for 70B-class models) |
| "UMA Mode" | `UMA_SPECIFIED` / `Dedicated` (not `Auto`) |

Leave 16–32 GB for the OS + router. Verify after boot:
`rocminfo | grep -A2 'Pool 1' | grep Size`.

---

## 2. Fedora 43/44 host prep

```bash
# --- Docker CE ---
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"        # log out / back in

# --- SELinux: let containers use the GPU device nodes ---
sudo setsebool -P container_use_devices on

# --- firewalld ---
sudo firewall-cmd --permanent --add-port=11435/tcp     # the Yardmaster proxy (inference)
sudo firewall-cmd --permanent --add-service=mdns
# Only if you set YM_BIND=0.0.0.0 to reach the web UIs from the LAN:
#   sudo firewall-cmd --permanent --add-port=8770/tcp   # Console
#   sudo firewall-cmd --permanent --add-port=3080/tcp   # Harness
# Prefer a source-scoped rule on a shared LAN, e.g.:
#   sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" \
#     source address="10.116.2.0/24" port port="8770" protocol="tcp" accept'
# Never open 14318 (node telemetry).
sudo firewall-cmd --reload

# --- render / video GIDs (put them in the stack's group_add) ---
sudo usermod -aG render,video "$USER"
getent group render video               # 39 (video) / 105 (render) on this host

# --- Portainer ---
docker volume create portainer_data
docker run -d --name portainer --restart unless-stopped -p 9443:9443 \
  -v /var/run/docker.sock:/var/run/docker.sock -v portainer_data:/data \
  portainer/portainer-ce:latest
```

Open `https://<framework-ip>:9443`, set the admin password.

---

## 3. `yardmaster.toml` — local engines + OpenRouter

Start from [`../deploy/portainer/yardmaster.toml.example`](../deploy/portainer/yardmaster.toml.example).
You can paste/edit it in the Console (Config tab, saves to the data volume) or
bind-mount it (see the commented mount in the stack).

- **Local Ollama and LAN vLLM** providers need **no API key** — just a
  `base_url`. Private-range hosts may use plain `http`.
- **OpenRouter** is the only keyed provider. Its key comes from the
  `OPENROUTER_API_KEY` environment variable (the stack passes it into the
  `yardmaster` service) and is **never written to the file**. `[egress]
  allow_remote = true` is required for the `locality = "remote"` targets to load;
  default routing is still `[routes.default] → local`, so the OpenRouter models
  are used **only when a request names their slug**.

The shipped example already contains the six OpenRouter targets
(`openai/gpt-5.6-terra`, `openai/gpt-6-astra`, `qwen/qwen3.8-max-0902`,
`deepseek/deepseek-v4-flash-vision-exp`, `qwen/qwen3.8-flash`,
`anthropic/claude-sonnet-5`), local `llama3.2:latest` + `deepseek-r1:32b`, and
two LAN vLLM nodes. Adjust addresses / model ids to your network. The Console's
**Validate** button catches schema mistakes.

---

## 4. Deploy the stack in Portainer

1. **Stacks → Add stack → Repository**
   - URL `https://github.com/pakgrou-porg/yardmaster`, ref `refs/heads/main`
   - Compose path `deploy/portainer/examples/framework-strix-halo.stack.yml`
2. **Environment variables** (or an `.env` next to the compose file):

   | Name | First deploy | Later |
   | --- | --- | --- |
   | `YM_BIND` | *(leave unset → 127.0.0.1)* | `0.0.0.0` for LAN |
   | `YM_LAN_HOST` | — | `10.116.2.145` (your IP) |
   | `YM_HARNESS_DEFAULT_MODEL` | `deepseek-r1:32b` (default) | any model Yardmaster can route — fallback for `[harness].default_model` |
   | `OPENROUTER_API_KEY` | your key | — |
   | `YM_AUTH_USER` / `YM_AUTH_PASS` | *(optional)* leave unset to use the browser setup page | — |

3. **Deploy.** The first build compiles the Go workers + bundles the Console
   (`runtime-proxy` target) from the repo — a few minutes, then cached. The Rust
   `rust-build` stage is **not** used by this target; ignore it.
4. Confirm `group_add` in the stack matches `getent group video render` (step 2).

Redeploy after changing any `YM_*` variable.

---

## 5. First-run setup and smoke test

Run these on the Framework host (`YM_BIND` still `127.0.0.1`):

```bash
# 1. all three containers up
docker ps --format '{{.Names}}\t{{.Status}}' | grep yardmaster

# 2. create the admin login (or set YM_AUTH_USER/PASS in the stack instead)
curl -s -X POST http://127.0.0.1:8770/api/setup \
  -d '{"user":"admin","password":"<pick-8+-chars>"}'
#   -> {"ok": true}

# 3. Console now requires that login
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8770/api/status          # 401
curl -s -u admin:<pw> http://127.0.0.1:8770/api/status | grep '"auth"'             # "configured"

# 4. Harness proxy requires it too; with it, you reach dsh's token exchange
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/                    # 401
curl -s -o /dev/null -w '%{http_code}\n' -u admin:<pw> http://127.0.0.1:3080/      # 303 (dsh)

# 5. the router loaded your config
curl -s http://127.0.0.1:11435/healthz            # {"mode":"router","config_ok":true,"targets":N}
curl -s http://127.0.0.1:11435/v1/models          # every model id in yardmaster.toml

# 6. autorouting — the response headers show where it went
curl -s -D- -o /dev/null http://127.0.0.1:11435/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"llama3.2:latest","messages":[{"role":"user","content":"say hi"}]}'
#   x-yardmaster-target: <target>   x-yardmaster-provider: <provider>   x-yardmaster-locality: lan

# 7. the capability registry (ADR-0028) discovered your targets and wrote
#    the Harness's model list
curl -s http://127.0.0.1:11435/v1/capabilities | python3 -m json.tool | head -40
#   -> records[] with reachability:"validated", applied[] listing the ids
#      it wrote into cordis.patch.yml, applied_default: the Harness's default
docker exec yardmaster-harness sh -c 'grep -E "id:|model:" /dshhome/profiles/web/cordis.patch.yml'
#   id: "deepseek-r1:32b" (and friends)
#   model: "deepseek-r1:32b"
```

Then open **`http://127.0.0.1:8770`** in a browser, log in, and check:

- **Config** — paste/edit `yardmaster.toml`, **Validate**, **Save** (writes the
  bind-mounted file if present, else the data-volume copy).
- **Backends** — live up/down + latency for every provider + the local engine.
- **Agent** — the Harness embedded in an iframe (tokened URL, host-rewritten to
  match how you reached the Console). It is **also** at
  `http://<host>:3080` directly for a full-window session; both prompt for the
  same admin login.

### Open it to the LAN

Set `YM_BIND=0.0.0.0` and `YM_LAN_HOST=<framework-ip>`, redeploy, open the
firewalld ports (step 2). Browse `http://<framework-ip>:8770`. The browser will
prompt once for `:8770` and once for `:3080` (different ports) — same
credentials. For TLS / SSO, keep `YM_BIND=127.0.0.1` and put a real reverse
proxy in front.

---

## 6. Point clients at the router

Host `:11435` is the LAN entry point (LAN bridge → the router). It **autoroutes
by model id**:

```bash
# a local model -> the local Ollama
curl http://<framework-ip>:11435/v1/chat/completions \
  -H 'content-type: application/json' -d '{
  "model": "llama3.2:latest",
  "messages": [{"role": "user", "content": "hello"}] }'

# a LAN vLLM model id -> that node (add the target to yardmaster.toml first)
curl http://<framework-ip>:11435/v1/chat/completions \
  -H 'content-type: application/json' -d '{
  "model": "gemma-4-12b-utility",
  "messages": [{"role": "user", "content": "hello"}] }'

# an OpenRouter model -> the cloud (needs OPENROUTER_API_KEY + [egress] allow_remote)
curl http://<framework-ip>:11435/v1/chat/completions \
  -H 'content-type: application/json' -d '{
  "model": "anthropic/claude-sonnet-5",
  "messages": [{"role": "user", "content": "hello"}] }'

# Ollama-style also works
curl http://<framework-ip>:11435/api/chat -d '{
  "model": "llama3.2:latest",
  "messages": [{"role": "user", "content": "hello"}], "stream": false }'
```

A model id that matches no `[targets.*]` follows `[routes.default]`. Add
`-D-` to any request to see the `x-yardmaster-target` / `-provider` /
`-locality` decision headers. Per-request rows land in the Console **Metrics**
tab.

Pull local models with `docker exec yardmaster-ollama ollama pull <name>` (use
real names from <https://ollama.com/library>). At minimum pull the Harness
default:

```bash
docker exec yardmaster-ollama ollama pull deepseek-r1:32b     # ~19 GB, the YM_HARNESS_DEFAULT_MODEL default
docker exec yardmaster-ollama ollama pull llama3.2:latest     # ~2 GB, a fast smoke-test model
```

`deepseek-r1:32b` is a reasoning model — its replies include `<think>…</think>`
blocks. Fine for chat; if you want terser agent behaviour set
`[harness].default_model` in `yardmaster.toml` (or `YM_HARNESS_DEFAULT_MODEL`)
to a non-reasoning model you have pulled.

---

## 7. The Harness, routed through Yardmaster

The `yardmaster` service's **capability registry** (ADR-0028) discovers models
from `[targets.*]` in `yardmaster.toml`, probes each provider's `/v1/models`,
and writes a managed region into
`$DSH_HOME/profiles/web/cordis.patch.yml` (between `# BEGIN yardmaster-managed`
/ `# END yardmaster-managed` markers) configuring `@deepseek-ai/dsh-llm-pi-ai`
with a `yardmaster` provider route (`baseURL: http://127.0.0.1:4000/v1`) and
`agent-default-model`. It reconciles on every config change and every 60s
(`YM_CAPABILITIES_RECONCILE_S`), so `dsh` sends every request through the
Yardmaster router with **no manual config**, and a Console **Save** takes
effect within a reconcile cycle — no restart. `yardmaster-harness` itself no
longer generates any of this; it only scaffolds the dsh profile on first boot.

- **Change the default**: set `[harness].default_model` in `yardmaster.toml`
  (wins), or `YM_HARNESS_DEFAULT_MODEL` in the stack env (fallback), and
  either Save in the Console or redeploy.
- **Steer which models the Harness offers**: `[harness.policy]`
  (`deny_glob`, `min_context_window`, `rank_by_locality`) and
  `[harness.overrides."<model-id>"]` (`enabled`, `rank`, `context_window`,
  `capabilities.*`, `default`) in `yardmaster.toml` — see the commented
  example in
  [`yardmaster.toml.example`](../deploy/portainer/yardmaster.toml.example).
  An override always wins over policy for that id.
- **Inspect the live registry**: `GET /v1/capabilities` on the router
  (`:11435` or `:4000` inside the container) — every discovered model with its
  `reachability`/`policy`/`rank`, the currently-applied list and default, and
  any `pending_ops` awaiting approval (destructive changes — removals not
  caused by an override, or default changes not caused by explicit config —
  are held, not auto-applied; see ADR-0028). Approve them with
  `POST /v1/capabilities/apply`.
- Content outside the managed region (including the `cordis.user.yml` merge
  used for MCP servers below) is never touched by the pipeline.
- `DSH_HOME` is the dedicated `yardmaster-harness` volume, so the signed-cookie
  secret, sessions, and credentials persist across restarts.

`dsh web` accepts only `--host` / `--port` / `--trusted-host` / `--no-open`. It
does **not** accept `--set`.

### Adding tools to the Harness (MCP)

dsh has an **MCP client** (`@deepseek-ai/dsh-mcp-client`). Extra plugin entries
go in **`$DSH_HOME/profiles/web/cordis.user.yml`** on the `yardmaster-harness`
volume — the entrypoint appends that file verbatim after its managed block on
every boot and never rewrites it.

**Brave Search** (replaces dsh's built-in `web_search`, which needs a DeepSeek
key). The Brave MCP server is bundled in the image; you only supply the key.

1. Set `BRAVE_API_KEY` in the stack env (or `.env`) and redeploy.
2. Write the overlay onto the volume:
   ```bash
   docker run --rm -i -v yardmaster-harness:/dshhome alpine sh -c \
     'mkdir -p /dshhome/profiles/web && cat > /dshhome/profiles/web/cordis.user.yml && chown -R 10001:10001 /dshhome/profiles'
   ```
   then paste and Ctrl-D:
   ```yaml
   - insert:
       - id: mcp-brave
         name: '@deepseek-ai/dsh-mcp-client'
         config:
           serverName: brave
           transport: stdio
           command: brave-search-mcp-server     # bundled; or: npx -y @brave/brave-search-mcp-server
           args: []
           env:
             BRAVE_API_KEY: !!js process.env.BRAVE_API_KEY
   - id: web-search-deepseek
     disabled: true
   ```
3. `docker restart yardmaster-harness`. The agent gets `mcp__brave__brave_web_search`
   (and `brave_news_search`, `brave_local_search`, …); the broken `web_search`
   is gone.

Any MCP server works the same way — `npx -y <package>` for stdio servers (npm/npx
are in the image; the cache persists on the volume), or `transport:
streamable-http` + `url:` for a service. `cordis.user.yml` is merged once
(idempotently, marker-guarded) by `harness-entrypoint.sh` on boot and lives
entirely outside the capability registry's managed region
([ADR-0028](decisions/0028-capability-registry-pipeline.md)) — the two never
collide.

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
| `OLLAMA_CONTEXT_LENGTH` | `16384` | **required** — without it Ollama auto-picks a ~256k context / ~56 GB KV cache and this iGPU returns fluent-but-wrong gibberish. Raise only if long-context output stays coherent. |
| `OLLAMA_KEEP_ALIVE` | `30m` or `-1` | keep big models resident |
| `OLLAMA_MAX_LOADED_MODELS` | `3` | planner + worker + judge hot at once |
| `OLLAMA_NUM_PARALLEL` | `2` | concurrent slots; `× OLLAMA_CONTEXT_LENGTH` = KV cells |
| `OLLAMA_FLASH_ATTENTION` | `1` | faster, less memory for long context |
| `OLLAMA_KV_CACHE_TYPE` | `q8_0` (optional) | big context without a big cache |

---

## 10. Troubleshooting

| Symptom | Fix |
| --- | --- |
| **Coherent-looking but nonsensical model output** (word salad, leaking `<\|...` tokens); `2+2` ≠ `4` even direct to Ollama | Ollama's auto context is too large for this iGPU. `docker exec yardmaster-ollama ollama ps` will show a multi-GB model / 131072 context. Set `OLLAMA_CONTEXT_LENGTH: "16384"` on `ollama` and redeploy. If it persists, add `HSA_OVERRIDE_GFX_VERSION: "11.0.0"` and/or `OLLAMA_FLASH_ATTENTION: "0"`. |
| `ollama ps` shows `100% CPU` / "no compatible GPUs" | `rocminfo` reports the 8060S as `gfx1100`, natively supported. If a build still falls back to CPU, try `HSA_OVERRIDE_GFX_VERSION: "11.0.0"` on `ollama`. |
| Console **Config** has no OpenRouter fields / no API-key box | the Config tab is a **raw `yardmaster.toml` editor** — paste [`yardmaster.toml.example`](../deploy/portainer/yardmaster.toml.example) (it has `[providers.openrouter]` + the model targets), Validate, Save. The key is **not** a field: set `OPENROUTER_API_KEY` in the stack env; the file references it via `api_key_env`. |
| OpenRouter targets missing after redeploy | your old `yardmaster.toml` on the `yardmaster-data` volume persists across redeploys — it is not overwritten by the example. Replace it via the Console Config tab. |
| ROCm sees only a few GB VRAM | raise the BIOS UMA carve-out (§1) |
| `permission denied` on `/dev/kfd` | `sudo setsebool -P container_use_devices on`; confirm `group_add` = `getent group video render` |
| `rocminfo` errors on a syscall | uncomment `security_opt: [seccomp=unconfined]` on `ollama` |
| Console shows the setup page again after a redeploy | the `yardmaster-data` volume was recreated — the credential lives there. Re-run setup, or set `YM_AUTH_USER`/`YM_AUTH_PASS` in the stack. |
| `403` at `:8770` / can't reach the setup page | you set `YM_AUTH_DISABLED=1` **and** something else 403'd, or you hit `/api/*` before setup — open `/` in a browser first. |
| Harness browser: `503 ... set an admin username/password in the Console first` | do the first-run setup on `:8770` (or set `YM_AUTH_USER`/`YM_AUTH_PASS`). The proxy shares that credential. |
| Harness browser: `Blocked request. This host is not allowed` | `dsh`'s trust fence — set `YM_LAN_HOST` to the exact IP you type in the URL bar and redeploy (or add `YM_HARNESS_TRUSTED_HOSTS="a:3080 b:3080"`). |
| `yardmaster-harness` crash-loops: `provider "yardmaster" resolves no models` | the `yardmaster` service hasn't reconciled yet, or none of your `[targets.*]` probed as `validated`. Check `GET /v1/capabilities`; confirm `yardmaster-harness:/dshhome` is mounted **rw** on the `yardmaster` service (not `:ro`); `docker restart yardmaster-harness` after the registry has applied at least one entry. |
| `yardmaster-harness` crash-loops: `cordis.patch.yml must be a top-level YAML array` | the capability registry's write-gate should prevent this (`dsh --dump-config` gates every write; a bad write reverts from `.lkg`) — if you still hit it, something hand-edited the file outside the managed region. Reset it: `docker run --rm -v yardmaster-harness:/dshhome alpine sh -c 'printf "[]\n" > /dshhome/profiles/web/cordis.patch.yml'` then `docker restart yardmaster yardmaster-harness` (the registry rewrites its region on the next reconcile). |
| `GET /v1/capabilities` shows a model stuck `pending_ops` and never applied | destructive changes (a removal not caused by an operator override, or a default change not caused by explicit `[harness]`/`[routes.default]` config) are held for approval by design (ADR-0028, additive-only auto-apply). Review the op, then `POST /v1/capabilities/apply` (or fix `yardmaster.toml` so the change becomes operator-driven and reconcile again). |
| router: `model "X" matches no target and there is no [routes.default]` | add a `[targets.*]` with `id = "X"`, or a `[routes.default]` — then Save in the Console (the router hot-reloads). |
| router: `provider "openrouter": OPENROUTER_API_KEY is not set` | set `OPENROUTER_API_KEY` in the stack env and redeploy. |
| router: `all upstreams failed` for a LAN vLLM model | check the `base_url` in `yardmaster.toml` and that `curl <base_url>/models` works from the `yardmaster` container. |
| `curl :11435/healthz` shows `mode: proxy` (not `router`) | `YM_DATAPLANE_MODE` isn't `router` — set it in the stack env and redeploy. |
| Metrics tab still empty | the router writes a row per request — send one; confirm `YM_METRICS_DB` points into `/data` and the volume is writable. |
| Console **Agent** iframe shows a loopback URL from a LAN browser | old image — rebuild; the current `/api/agent` rewrites the host from your request. |
| `nvidia-smi unavailable` / `detected 0 GPU(s)` in logs | expected on AMD — PAIR's GPU telemetry is NVIDIA-only. Does not affect the engine's GPU use. [#48](https://github.com/pakgrou-porg/yardmaster/issues/48). |
| a container exits and the whole unit restarts | by design — `yardmaster` supervises broker + console + bridge; `yardmaster-harness` supervises `dsh` + the auth proxy. Check `docker logs <name>` for which child died. |
| "container name already in use" on redeploy | `docker rm -f yardmaster yardmaster-ollama yardmaster-harness` (and any leftovers from an older revision: `yardmaster-init yardmaster-console yardmaster-lan-shim yardmaster-harness-shim yardmaster-harness-proxy`) then redeploy. |
| Portainer build fails in `rust-build` | not used by `target: runtime-proxy` — don't change the target. Tracked by [#36](https://github.com/pakgrou-porg/yardmaster/issues/36). |

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

---

## 12. Backups

```bash
docker run --rm -v yardmaster-data:/data -v "$PWD":/backup busybox \
  tar czf /backup/yardmaster-data.tgz -C /data .
```

`yardmaster-data` holds the pairing identity, `yardmaster.toml`, the metrics DB,
and the admin credential — losing it means re-pairing and re-running setup.
`yardmaster-harness` holds the `dsh` session state. The model volume is a cache.
