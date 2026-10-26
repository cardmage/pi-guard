# pi-guard

English | [한국어](./README.ko.md)

A [Pi](https://pi.dev) extension that checks every URL in the agent's final answer and catches hallucinated citations.

LLMs cannot know from memory alone whether an arbitrary URL resolves—they can only judge whether it looks plausible. `pi-guard` therefore **checks URLs over HTTP first** and asks an LLM **only** when HTTP is inconclusive (403/429 bot blocks, 5xx errors, timeouts, network failures).

When a cited URL does not exist (`404`, `410`, or `ENOTFOUND` on HTTP, or `NOT_EXISTS` from the verifier model):
- **`rewrite`** (default): appends a feedback message and asks the agent to rewrite the answer without the fabricated link (up to `maxRewrites` times per user prompt, then degrades to `warn`).
- **`warn`**: shows a warning notification and leaves the answer as-is.

## Install

```bash
pi install npm:pi-guard
```

Try it for a single session without installing:

```bash
pi -e npm:pi-guard
# or from a local checkout:
pi -e ./
```

Requires **Node.js ≥ 22.19.0** (same as Pi). Runs on Windows, macOS, and Linux.

## How it works

On `agent_before_settle` (when a run finishes with `outcome === "completed"`):

1. **Extract** `http://` and `https://` URLs from the last assistant message (markdown links, `<autolinks>`, and bare URLs). Trailing punctuation, unbalanced parentheses, and CJK particles attached to ASCII paths are stripped; fragments are removed and duplicates are collapsed.
2. **Filter out URLs that should never be checked**:
   - Private/local hosts: `localhost`, `127.*`, `10.*`, `172.16–31.*`, `192.168.*`, `169.254.*`, `::1`, `fc00::/7`, `fe80::/10`, single-label hosts, `*.local`, `*.internal`, `*.corp`, `*.lan`.
   - Reserved example domains (RFC 2606 / RFC 6761): `example.com/.net/.org`, `*.test`, `*.example`, `*.invalid`, `*.localhost`.
   - Hosts or URL path prefixes matching `bypassDomains` (e.g. `"*.mycompany.com"`, `"github.com/private-repo"`).
   - Code blocks and inline code spans (when `skipCodeBlocks: true`).
3. **HTTP check** (`HEAD`, falling back to `GET` with immediate body cancel):
   - `2xx` / `3xx → 2xx` → `OK`
   - `404`, `410`, DNS `ENOTFOUND` → `NOT_FOUND` (fail)
   - `401`, `403`, `429`, `5xx`, timeouts, TLS/proxy/network errors → `UNCERTAIN`
4. **LLM fallback**: all `UNCERTAIN` URLs are judged in a single call (`EXISTS` | `NOT_EXISTS` | `UNKNOWN`). `UNKNOWN` and any model/auth/parse error fail open so the session never gets stuck.

## Configuration

Create `~/.pi/agent/pi-guard.json` (or `%USERPROFILE%\.pi\agent\pi-guard.json` on Windows; respects `PI_CODING_AGENT_DIR`). Run `/reload` in Pi after editing. If the file is absent, all defaults apply.

```json
{
  "enabled": true,
  "mode": "rewrite",
  "maxRewrites": 1,
  "maxUrls": 20,
  "skipCodeBlocks": true,
  "bypassDomains": [
    "*.mycompany.com",
    "jira.mycompany.io"
  ],
  "verifier": {
    "provider": null,
    "model": null,
    "thinking": "low",
    "systemPrompt": null,
    "timeoutMs": 30000
  },
  "http": {
    "enabled": true,
    "timeoutMs": 8000,
    "concurrency": 5,
    "userAgent": null,
    "proxy": "env",
    "noProxy": [],
    "useSystemCa": true
  }
}
```

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Enable or disable the extension. |
| `mode` | `"rewrite"` | `"rewrite"` asks the agent to fix the answer; `"warn"` only notifies. |
| `maxRewrites` | `1` | Max rewrite requests per user prompt before degrading to `"warn"`. |
| `maxUrls` | `20` | Max URLs checked per answer. |
| `skipCodeBlocks` | `true` | Ignore URLs inside fenced and inline code. |
| `bypassDomains` | `[]` | Domains or path prefixes to skip (`"foo.com"` matches apex + subdomains; `"*.foo.com"` matches subdomains only; `"github.com/org/repo"` matches only that path prefix). |
| `verifier.provider` / `verifier.model` | `null` | Model used for `UNCERTAIN` URLs. `null` uses the current session model (`ctx.model`). Falls back to `ctx.model` with a warning if not found or unauthenticated. |
| `verifier.thinking` | `"low"` | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"`. Omitted when `"off"` or unsupported by the model. |
| `verifier.systemPrompt` | `null` | Replaces the built-in verifier system prompt when set. |
| `verifier.timeoutMs` | `30000` | Timeout for the verifier LLM call. |
| `http.enabled` | `true` | Set `false` to skip HTTP and judge all URLs with the LLM. |
| `http.timeoutMs` | `8000` | Per-URL HTTP timeout. |
| `http.concurrency` | `5` | Max concurrent HTTP checks. |
| `http.userAgent` | `null` | Custom `User-Agent` (`null` uses a browser-like default). |
| `http.proxy` | `"env"` | `"env"` (use `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`), `"none"` (always direct), or an explicit proxy URL (`http://`, `https://`, `socks5://`). |
| `http.noProxy` | `[]` | Hosts that bypass an explicit `http.proxy` URL (e.g. `[".corp.com", "10.0.0.1:8080"]`). In `"env"` mode, use `NO_PROXY`. |
| `http.useSystemCa` | `true` | Trust the OS certificate store in addition to Node's bundled CAs (for corporate TLS-inspecting proxies). |

## Corporate proxies & TLS inspection

By default (`"proxy": "env"`, `"useSystemCa": true`), the extension reads standard proxy environment variables and trusts root certificates installed in the Windows Certificate Store, macOS Keychain, or Linux system bundle.

### Setting proxy environment variables

**Windows (PowerShell — current session):**
```powershell
$env:HTTPS_PROXY = "http://proxy.corp.com:8080"
$env:HTTP_PROXY  = "http://proxy.corp.com:8080"
$env:NO_PROXY    = "localhost,127.0.0.1,.corp.com"
```

**Windows (persist for your user account):**
```powershell
setx HTTPS_PROXY "http://proxy.corp.com:8080"
setx NO_PROXY "localhost,127.0.0.1,.corp.com"
```

**macOS / Linux (`~/.zshrc` or `~/.bashrc`):**
```bash
export HTTPS_PROXY="http://proxy.corp.com:8080"
export HTTP_PROXY="http://proxy.corp.com:8080"
export NO_PROXY="localhost,127.0.0.1,.corp.com"
```

Alternatively, set `"http": { "proxy": "http://proxy.corp.com:8080", "noProxy": [".corp.com"] }` in `pi-guard.json`. Avoid putting `user:password@` in `pi-guard.json` since it is stored in plain text—prefer environment variables when authentication is required.

> **Notes**
> - OS auto-proxy settings (Windows Internet Options / macOS Network settings) and PAC/WPAD scripts are not read automatically; configure an explicit proxy URL or environment variable.
> - `socks5://` proxy support in Undici is experimental.

## Development

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run check     # both
```
