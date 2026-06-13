# Nenu — Consent-at-Share (MCP App)

A portable **MCP App** that renders Nenu's field-level **share / edit / decline**
card directly inside the chat, before any scoped brief leaves the vault. One MCP
server, exposed to **both Claude and ChatGPT** (and any MCP Apps host) — built on
the official [MCP Apps extension](https://modelcontextprotocol.io/docs/extensions/apps)
(`@modelcontextprotocol/ext-apps`), live since January 2026.

This closes the connector's transparency gap: instead of relying on the host's
generic "wants to use this tool" prompt, the user sees the actual fields, their
provenance, and their sensitivity, and decides per field — the same trust moment
the browser extension gives you, but delivered through the connector so it works
on desktop, web, and mobile MCP hosts.

## What it demonstrates (mapped to the capability briefing)

- **Raw stays in the vault.** The `get_travel_brief` tool returns *nothing
  sensitive to the model* — only a neutral status line. Candidate field values
  travel in `structuredContent`, which only the widget reads. The model sees data
  only after the user approves, via `updateModelContext`.
- **Server-side scope enforcement (the vault gate).** `confirm_share` validates
  every approved field against the vault's standing rule. A `blocked` field
  throws even if the widget asks for it — the host can only ever *further*
  restrict, never widen.
- **URL mode for the most sensitive fields.** `high`-sensitivity fields
  (passport, etc.) are masked in the card and never pass through the host; the
  ledger records them as shared `via nenu.co`.
- **Three-state vocabulary.** Each field carries `always_allow` / `needs_approval`
  / `blocked`, mirroring the host's own words.
- **Audit ledger + one-tap revoke.** Every share is logged with provenance and
  can be revoked from the card.

## Files

| File | Purpose |
|------|---------|
| `server.ts` | Registers the UI tool (`get_travel_brief`), callback tools (`confirm_share`, `revoke_share`), and the `ui://` consent resource. |
| `main.ts` | Entry point. Streamable HTTP transport (how Claude/ChatGPT connect) + stdio. |
| `src/vault.ts` | Dependency-free mock vault: fields, sensitivity, provenance, scope rules, ledger, scope enforcement. |
| `src/consent-app.ts` | The View logic — renders the card, calls back, injects approved context. |
| `consent-app.html` | The View shell + styling (light/dark aware). |
| `test/vault.test.ts` | Dependency-free tests for scope enforcement + ledger. |

## Run it

Requires Node 18+ (developed on Node 22).

```bash
npm install
npm run build        # bundles the View into dist/consent-app.html
npm run serve        # starts the MCP server on http://localhost:3001/mcp
```

Test the vault logic without installing anything:

```bash
node --experimental-strip-types test/vault.test.ts
```

### See the card render (local host harness)

```bash
git clone https://github.com/modelcontextprotocol/ext-apps.git
cd ext-apps && npm install && cd examples/basic-host && npm start
# open http://localhost:8080, point it at http://localhost:3001/mcp,
# call get_travel_brief, and the consent card renders in the sandbox.
```

### Connect it to Claude or ChatGPT

The server must be reachable over HTTPS (tunnel it for local dev, e.g.
`ngrok http 3001`, or deploy it). Then:

- **Claude** (web or desktop): Settings → Connectors → add a custom connector with
  the URL `https://<your-host>/mcp`. Enable it, then ask something travel-related;
  the model calls `get_travel_brief` and the card renders inline.
- **ChatGPT**: add it as an app/connector pointing at the same `/mcp` endpoint.

Because both hosts implement the MCP Apps standard, the *same* server and the
*same* widget run in both — no host-specific code.

## The consent flow

1. Model calls `get_travel_brief`. Server returns a neutral status line to the
   model + candidate fields (in `structuredContent`) to the widget.
2. The card renders each field with value (or "stays in vault" for URL-mode),
   provenance, sensitivity chip, and scope hint. Defaults are pre-selected.
3. User adjusts and clicks **Share selected** (or **Decline all**).
4. Widget calls `confirm_share` → server enforces scope, writes the ledger,
   returns only the approved brief.
5. Widget calls `updateModelContext` with *only* the approved fields. The model
   now has exactly what the user agreed to, and the card shows the ledger with
   **Revoke** buttons.

## Production notes / not-yet

- The vault is in-memory and single-user. Swap `src/vault.ts` for your real vault
  + identity resolution (the same-user-across-hosts problem is the real spine of
  portability — see the briefing's open question #3).
- `edits` is wired through `confirm_share` but the card doesn't yet expose an edit
  input; add an inline editor per row if you want true "edit" alongside
  share/decline.
- URL-mode currently just logs the redirect; wire it to a real nenu.co page that
  completes the share out-of-band for `high`-sensitivity fields.
- Auth: add OAuth on the `/mcp` endpoint (the host runs the sign-in) before
  exposing anything real.
