export function dashboardHtml(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentBridge Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #1d252c;
      --muted: #5f6b76;
      --line: #d7dde4;
      --accent: #176b87;
      --accent-strong: #0f4e62;
      --danger: #a13b3b;
      --warn: #9a6500;
      --ok: #2f6f4e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.45;
    }
    header {
      background: #ffffff;
      border-bottom: 1px solid var(--line);
      padding: 14px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      position: sticky;
      top: 0;
      z-index: 2;
    }
    h1, h2 {
      margin: 0;
      letter-spacing: 0;
    }
    h1 {
      font-size: 18px;
      font-weight: 700;
    }
    h2 {
      font-size: 14px;
      font-weight: 700;
    }
    main {
      width: min(1480px, 100%);
      margin: 0 auto;
      padding: 18px;
      display: grid;
      grid-template-columns: minmax(280px, 380px) minmax(0, 1fr);
      gap: 16px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      min-width: 0;
    }
    .section-head {
      min-height: 44px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .section-body {
      padding: 14px;
      min-width: 0;
    }
    .stack {
      display: grid;
      gap: 16px;
      align-content: start;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
    }
    .kv {
      display: grid;
      grid-template-columns: 112px minmax(0, 1fr);
      gap: 8px 12px;
      align-items: start;
    }
    .label {
      color: var(--muted);
      font-size: 12px;
    }
    .value {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    button {
      border: 1px solid var(--line);
      background: #ffffff;
      color: var(--text);
      border-radius: 5px;
      padding: 7px 10px;
      min-height: 32px;
      cursor: pointer;
      font: inherit;
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #ffffff;
    }
    button.primary:hover { background: var(--accent-strong); }
    button.danger { color: var(--danger); }
    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    pre {
      margin: 0;
      max-height: 360px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
    }
    .status {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--line);
      color: var(--muted);
      background: #f8fafb;
      font-size: 12px;
      max-width: 100%;
      overflow-wrap: anywhere;
    }
    .status.ok { color: var(--ok); border-color: #b9d6c6; background: #f3faf5; }
    .status.warn { color: var(--warn); border-color: #e5cf9f; background: #fff9ec; }
    .status.danger { color: var(--danger); border-color: #e0b7b7; background: #fff4f4; }
    .approval {
      border-top: 1px solid var(--line);
      padding: 12px 0;
      display: grid;
      gap: 8px;
    }
    .approval:first-child { border-top: 0; padding-top: 0; }
    .approval:last-child { padding-bottom: 0; }
    .empty {
      color: var(--muted);
    }
    .wide { grid-column: 1 / -1; }
    @media (max-width: 920px) {
      header { align-items: flex-start; flex-direction: column; }
      main { grid-template-columns: 1fr; padding: 12px; }
      .grid { grid-template-columns: 1fr; }
      .kv { grid-template-columns: 96px minmax(0, 1fr); }
    }
  </style>
</head>
<body>
  <header>
    <h1>AgentBridge Dashboard</h1>
    <div class="toolbar">
      <button id="refresh" class="primary" type="button">Refresh</button>
      <button id="createPrompt" type="button">Send to Codex</button>
      <button id="createReview" type="button">Ask ChatGPT Review</button>
    </div>
  </header>
  <main>
    <div class="stack">
      <section>
        <div class="section-head"><h2>Session</h2><span id="daemonStatus" class="status">loading</span></div>
        <div class="section-body kv">
          <div class="label">Goal</div><div id="goal" class="value"></div>
          <div class="label">Status</div><div id="status" class="value"></div>
          <div class="label">Branch</div><div id="branch" class="value"></div>
          <div class="label">Next</div><div id="nextAction" class="value"></div>
          <div class="label">Tests</div><div id="tests" class="value"></div>
        </div>
      </section>
      <section>
        <div class="section-head"><h2>Changed Files</h2><span id="changedCount" class="status">0</span></div>
        <div class="section-body"><pre id="changedFiles"></pre></div>
      </section>
      <section>
        <div class="section-head"><h2>Pending Approvals</h2><span id="approvalCount" class="status">0</span></div>
        <div class="section-body" id="approvals"></div>
      </section>
    </div>
    <div class="grid">
      <section>
        <div class="section-head"><h2>ChatGPT Plan</h2></div>
        <div class="section-body"><pre id="plan"></pre></div>
      </section>
      <section>
        <div class="section-head"><h2>Codex Progress</h2></div>
        <div class="section-body"><pre id="progress"></pre></div>
      </section>
      <section>
        <div class="section-head"><h2>Codex Task</h2></div>
        <div class="section-body"><pre id="task"></pre></div>
      </section>
      <section>
        <div class="section-head"><h2>Codex Result</h2></div>
        <div class="section-body"><pre id="result"></pre></div>
      </section>
      <section class="wide">
        <div class="section-head"><h2>Project Context</h2></div>
        <div class="section-body"><pre id="context"></pre></div>
      </section>
    </div>
  </main>
  <script>
    window.AGENTBRIDGE_TOKEN = ${JSON.stringify(token)};
  </script>
  <script>
    const token = window.AGENTBRIDGE_TOKEN;
    const $ = (id) => document.getElementById(id);

    async function api(path, options = {}) {
      const response = await fetch(path, {
        method: options.method || "GET",
        headers: {
          "Authorization": "Bearer " + token,
          "Content-Type": "application/json"
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Request failed");
      return data;
    }

    function setText(id, value) {
      $(id).textContent = value || "";
    }

    function statusClass(value) {
      if (!value) return "status";
      if (String(value).includes("failed") || String(value).includes("rejected")) return "status danger";
      if (String(value).includes("pending") || String(value).includes("unknown")) return "status warn";
      return "status ok";
    }

    async function loadDashboard() {
      $("daemonStatus").textContent = "loading";
      $("daemonStatus").className = "status warn";
      const [session, repo, tests, context, plan, progress, task, result, approvals] = await Promise.all([
        api("/session"),
        api("/repo/status"),
        api("/tests/latest"),
        api("/context").catch(() => ({ context: "No project context captured yet." })),
        api("/chatgpt/plan"),
        api("/codex/progress"),
        api("/codex/task"),
        api("/codex/result"),
        api("/approvals?status=pending")
      ]);

      const s = session.session;
      setText("goal", s.user_goal);
      setText("status", s.status);
      setText("branch", s.active_branch);
      setText("nextAction", s.next_action);
      setText("tests", tests.status);
      setText("changedFiles", repo.changed_files.length ? repo.changed_files.join("\\n") : "No changed files.");
      setText("changedCount", String(repo.changed_files.length));
      setText("context", context.context);
      setText("plan", plan.plan);
      setText("progress", progress.progress);
      setText("task", task.task);
      setText("result", result.result);
      $("status").className = statusClass(s.status);
      $("daemonStatus").textContent = "running";
      $("daemonStatus").className = "status ok";
      renderApprovals(approvals.approvals || []);
    }

    function renderApprovals(items) {
      $("approvalCount").textContent = String(items.length);
      $("approvalCount").className = items.length ? "status warn" : "status ok";
      if (!items.length) {
        $("approvals").innerHTML = '<div class="empty">No pending approvals.</div>';
        return;
      }
      $("approvals").innerHTML = items.map((item) => \`
        <div class="approval">
          <div><strong>\${item.action}</strong> <span class="status \${item.risk === "high" ? "danger" : "warn"}">\${item.risk}</span></div>
          <div class="label">\${item.id}</div>
          <pre>\${item.command || item.reason || ""}</pre>
          <div class="toolbar">
            <button type="button" data-approve="\${item.id}" class="primary">Approve</button>
            <button type="button" data-reject="\${item.id}" class="danger">Reject</button>
          </div>
        </div>\`).join("");
    }

    $("refresh").addEventListener("click", () => loadDashboard().catch(showError));
    $("createPrompt").addEventListener("click", async () => {
      await api("/codex/prompt", { method: "POST", body: {} });
      await loadDashboard();
    });
    $("createReview").addEventListener("click", async () => {
      await api("/review", { method: "POST", body: {} });
      await loadDashboard();
    });
    $("approvals").addEventListener("click", async (event) => {
      const approve = event.target?.dataset?.approve;
      const reject = event.target?.dataset?.reject;
      if (approve) await api("/approve", { method: "POST", body: { id: approve } });
      if (reject) await api("/reject", { method: "POST", body: { id: reject } });
      if (approve || reject) await loadDashboard();
    });

    function showError(error) {
      $("daemonStatus").textContent = error.message;
      $("daemonStatus").className = "status danger";
    }

    loadDashboard().catch(showError);
  </script>
</body>
</html>`;
}
