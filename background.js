/**
 * The content script cannot reach the mail host directly (mail.google.com's page context is subject
 * to CORS), so the send goes through here, where host_permissions applies. The password never
 * reaches the page: it is read from extension storage on this side.
 */

/**
 * Re-reads the From list from each server. The board decides who may send as what, so the list is
 * fetched rather than typed in, and refreshed whenever Gmail is opened.
 */
async function refreshSendAs() {
  const { accounts } = await chrome.storage.local.get("accounts");
  const list = accounts || [];
  let changed = false;
  for (const account of list) {
    try {
      const res = await fetch(`https://${account.host}/api/whoami`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: account.address, password: account.password }),
      });
      if (!res.ok) continue;
      const body = await res.json();
      const sendAs = Array.isArray(body.send_as) && body.send_as.length ? body.send_as : [account.address];
      if (JSON.stringify(sendAs) !== JSON.stringify(account.sendAs) || (body.name ?? null) !== (account.serverName ?? null)) {
        account.sendAs = sendAs;
        account.serverName = body.name ?? null;
        changed = true;
      }
    } catch {
      // Offline or the server is down: keep what is stored rather than emptying the list.
    }
  }
  if (changed) await chrome.storage.local.set({ accounts: list });
  return list;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "refresh") {
    void refreshSendAs().then((accounts) => reply({ ok: true, accounts })).catch((e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type !== "send") return false;
  void (async () => {
    try {
      const { accounts } = await chrome.storage.local.get("accounts");
      const account = (accounts || []).find((a) => a.address === msg.address);
      if (!account) throw new Error("このアドレスは拡張機能に登録されていません");

      const res = await fetch(`https://${account.host}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: account.address,
          password: account.password,
          // Which of the login's addresses to put in From; the server refuses anything else.
          from: msg.from || account.address,
          to: msg.to,
          cc: msg.cc,
          bcc: msg.bcc,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          // The compose panel reads picked files into base64; /api/send takes them as they are.
          attachments: msg.attachments,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      reply({ ok: true, sent: body.sent, copied: body.copied });
    } catch (e) {
      reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
  return true; // reply comes later
});
