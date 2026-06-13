import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  buildApprovedBrief,
  getCandidateBrief,
  getLedger,
  revoke,
} from "./src/vault.ts";

const DIST_DIR = path.join(import.meta.dirname, "dist");
const CONSENT_UI = "ui://nenu/consent-app.html";

/**
 * Creates the Nenu MCP server: one UI tool that opens the consent card, plus
 * the server tools the card calls back into. The same server is exposed to
 * Claude and ChatGPT — it is one MCP server, not two integrations.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "Nenu",
    version: "0.1.0",
  });

  // --- UI tool: open the consent-at-share card -----------------------------
  // The model can call this when a travel-relevant request comes up. It returns
  // NOTHING sensitive to the model — only a neutral status line. The actual
  // candidate fields travel in `structuredContent`, which the widget reads to
  // render the share / edit / decline card. Raw stays in the vault until the
  // user approves.
  registerAppTool(
    server,
    "get_travel_brief",
    {
      title: "Share travel preferences",
      description:
        "Use this whenever the user is planning travel (flights, hotels, " +
        "destinations, itineraries) or asks for travel help. Call it directly " +
        "and immediately — do NOT first ask the user whether to check their " +
        "preferences. This tool opens Nenu's own consent card, which is where " +
        "the user grants or declines permission per field, so calling it is " +
        "safe and shares nothing on its own. Calling it IS how you ask.",
      inputSchema: { purpose: z.string().optional() },
      _meta: { ui: { resourceUri: CONSENT_UI } },
    },
    async () => {
      const candidate = getCandidateBrief("travel");
      return {
        content: [
          {
            type: "text",
            text:
              "Nenu has a travel brief ready. Awaiting the user's field-level " +
              "consent in the card below — nothing is shared until they approve.",
          },
        ],
        structuredContent: {
          candidate,
          ledger: getLedger().filter((r) => !r.revoked),
        },
      };
    },
  );

  // --- Callback tool: the user approved a selection ------------------------
  // Invoked by the widget via app.callServerTool(). Enforces vault scope
  // server-side, logs each share to the ledger with provenance, and returns
  // ONLY the approved fields. The widget then injects this into model context.
  registerAppTool(
    server,
    "confirm_share",
    {
      title: "Confirm share selection",
      description:
        "Internal: called by the Nenu consent card with the fields the user " +
        "approved. Enforces vault scope and writes the audit ledger.",
      inputSchema: {
        domain: z.string(),
        approvedKeys: z.array(z.string()),
        edits: z.record(z.string()).optional(),
      },
      _meta: { ui: { resourceUri: CONSENT_UI } },
    },
    async ({ domain, approvedKeys, edits }) => {
      const brief = buildApprovedBrief(domain, approvedKeys, edits ?? {});
      return {
        content: [{ type: "text", text: brief.text }],
        structuredContent: { brief, ledger: getLedger().filter((r) => !r.revoked) },
      };
    },
  );

  // --- Callback tool: one-tap revoke --------------------------------------
  registerAppTool(
    server,
    "revoke_share",
    {
      title: "Revoke a previous share",
      description:
        "Internal: called by the Nenu consent card to revoke a previously " +
        "shared field by its ledger id.",
      inputSchema: { id: z.string() },
      _meta: { ui: { resourceUri: CONSENT_UI } },
    },
    async ({ id }) => {
      const ok = revoke(id);
      return {
        content: [
          { type: "text", text: ok ? `Revoked ${id}.` : `No ledger record ${id}.` },
        ],
        structuredContent: { ledger: getLedger().filter((r) => !r.revoked) },
      };
    },
  );

  // --- UI resource: the consent card itself --------------------------------
  registerAppResource(
    server,
    CONSENT_UI,
    CONSENT_UI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      const html = await fs.readFile(
        path.join(DIST_DIR, "consent-app.html"),
        "utf-8",
      );
      return {
        contents: [{ uri: CONSENT_UI, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );

  return server;
}
