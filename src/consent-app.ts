import { App } from "@modelcontextprotocol/ext-apps";

// --- Types mirrored from the server (kept local so the View is standalone) --
interface CandidateField {
  key: string;
  label: string;
  value: string | null;
  masked: boolean;
  sensitivity: "low" | "medium" | "high";
  source: string;
  rule: "always_allow" | "needs_approval" | "blocked";
  defaultShare: boolean;
}
interface CandidateBrief {
  domain: string;
  title: string;
  fields: CandidateField[];
}
interface LedgerRecord {
  id: string;
  fieldLabel: string;
  source: string;
  channel: "host" | "nenu_url";
}

const $ = (id: string) => document.getElementById(id)!;
const rowsEl = $("rows");
const subEl = $("sub");
const footEl = $("foot");
const pickerEl = $("picker");
const resultEl = $("result");

const app = new App({ name: "Nenu Consent Card", version: "0.1.0" });

let current: CandidateBrief | null = null;

// The host delivers the get_travel_brief result here. We read the candidate
// fields from structuredContent — the model never received the raw values.
app.ontoolresult = (result: any) => {
  const data = result?.structuredContent;
  if (data?.candidate) {
    current = data.candidate as CandidateBrief;
    renderPicker(current);
  }
};

function ruleHint(rule: CandidateField["rule"]): string {
  if (rule === "always_allow") return "Standing rule: normally shared automatically";
  if (rule === "needs_approval") return "Needs your approval";
  return "Blocked";
}

function renderPicker(brief: CandidateBrief) {
  subEl.textContent = `${brief.title} — choose what leaves your vault. Nothing is shared until you approve.`;
  rowsEl.innerHTML = "";

  for (const f of brief.fields) {
    const row = document.createElement("label");
    row.className = "row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = f.defaultShare;
    cb.dataset.key = f.key;

    const mid = document.createElement("div");
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = f.label;

    const val = document.createElement("div");
    if (f.masked || f.value === null) {
      val.className = "value masked";
      val.textContent = "Stays in vault — shared securely via nenu.co, never through this chat";
    } else {
      val.className = "value";
      val.textContent = f.value;
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `Source: ${f.source}`;

    const hint = document.createElement("div");
    hint.className = "rulehint";
    hint.textContent = ruleHint(f.rule);

    mid.append(label, val, meta, hint);

    const chip = document.createElement("span");
    chip.className = `chip ${f.sensitivity}`;
    chip.textContent = f.sensitivity;

    row.append(cb, mid, chip);
    rowsEl.append(row);
  }

  footEl.textContent =
    "Every share is logged to your Nenu ledger with its source, and can be revoked anytime.";
}

function selectedKeys(): string[] {
  return [...rowsEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.key!)
    .filter(Boolean);
}

$("share").addEventListener("click", async () => {
  if (!current) return;
  const approvedKeys = selectedKeys();

  if (approvedKeys.length === 0) {
    await declineAll();
    return;
  }

  const res: any = await app.callServerTool({
    name: "confirm_share",
    arguments: { domain: current.domain, approvedKeys },
  });
  const brief = res?.structuredContent?.brief;
  const ledger: LedgerRecord[] = res?.structuredContent?.brief?.ledger ?? [];

  // Inject ONLY the approved brief into the model's context.
  const text =
    brief?.text ??
    res?.content?.find((c: any) => c.type === "text")?.text ??
    "Shared selected fields.";
  await app.updateModelContext({ content: [{ type: "text", text }] });

  // updateModelContext only STAGES context; per the MCP Apps spec it does not
  // trigger a model turn (the host defers it until the next user message). On
  // its own that left Claude idle after the user clicked Share, and a later
  // "continue" arrived without the staged brief, so the model reported no
  // selection. sendMessage delivers an explicit user turn now, which both wakes
  // the model and carries the just-staged context, so the assistant resumes.
  await app.sendMessage({
    role: "user",
    content: [
      {
        type: "text",
        text: "I approved the fields above from my Nenu vault. Please continue with my request using them.",
      },
    ],
  });

  renderResult(text, ledger);
});

$("decline").addEventListener("click", declineAll);

async function declineAll() {
  await app.updateModelContext({
    content: [
      {
        type: "text",
        text: "The user declined to share any travel preferences from their Nenu vault.",
      },
    ],
  });
  // Same reason as the share path: stage the decline, then send a turn so the
  // model actually resumes (here, proceeding without any vault context).
  await app.sendMessage({
    role: "user",
    content: [
      {
        type: "text",
        text: "I declined to share anything from my Nenu vault. Please continue without it.",
      },
    ],
  });
  renderResult("You declined. Nothing left your vault.", []);
}

function renderResult(summary: string, ledger: LedgerRecord[]) {
  pickerEl.classList.add("hidden");
  resultEl.classList.remove("hidden");
  resultEl.innerHTML = "";

  const h = document.createElement("h2");
  h.textContent = "Done";
  const p = document.createElement("p");
  p.style.whiteSpace = "pre-wrap";
  p.style.margin = "0 0 10px";
  p.textContent = summary;
  resultEl.append(h, p);

  for (const rec of ledger) {
    const row = document.createElement("div");
    row.className = "led";
    const left = document.createElement("div");
    const lab = document.createElement("div");
    lab.textContent =
      rec.fieldLabel + (rec.channel === "nenu_url" ? "  (via nenu.co)" : "");
    lab.style.fontWeight = "600";
    const src = document.createElement("div");
    src.className = "src";
    src.textContent = `Source: ${rec.source}`;
    left.append(lab, src);

    const btn = document.createElement("button");
    btn.textContent = "Revoke";
    btn.addEventListener("click", async () => {
      await app.callServerTool({ name: "revoke_share", arguments: { id: rec.id } });
      btn.textContent = "Revoked";
      btn.disabled = true;
      await app.updateModelContext({
        content: [{ type: "text", text: `The user revoked: ${rec.fieldLabel}.` }],
      });
    });

    row.append(left, btn);
    resultEl.append(row);
  }
}

app.connect();
