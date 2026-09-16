const $ = (id) => document.getElementById(id);

const load = async () => (await chrome.storage.local.get("accounts")).accounts || [];
const save = (accounts) => chrome.storage.local.set({ accounts });

function show(text, isError) {
  $("msg").textContent = text;
  $("msg").className = isError ? "error" : "";
}

/** mail.<domain>, the name the proxy is served under. Overridable in the details section. */
const hostFor = (address) => `mail.${address.split("@")[1] || ""}`;

/** Two hosts ship with the extension; any other one is asked for on the click that adds it. */
async function ensurePermission(host) {
  const origins = [`https://${host}/*`];
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

async function render() {
  const accounts = await load();
  const list = $("list");
  list.textContent = "";
  if (!accounts.length) {
    const li = document.createElement("li");
    li.textContent = "まだありません";
    list.appendChild(li);
    return;
  }
  for (const a of accounts) {
    const li = document.createElement("li");
    const who = document.createElement("div");
    who.className = "who";
    const head = document.createElement("div");
    head.textContent = a.address;
    who.appendChild(head);

    const bits = [];
    const extra = (a.sendAs || []).filter((x) => x !== a.address);
    if (extra.length) bits.push(`${extra.join("、")} でも送信可`);
    if (a.signature) bits.push("署名あり");
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = bits.length ? bits.join(" · ") : a.host;
    who.appendChild(sub);

    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "削除";
    del.addEventListener("click", async () => {
      await save((await load()).filter((x) => x.address !== a.address));
      show(`${a.address} を削除しました`, false);
      void render();
    });
    li.append(who, del);
    list.appendChild(li);
  }
}

$("add").addEventListener("click", async () => {
  const address = $("address").value.trim().toLowerCase();
  const password = $("password").value;
  const signature = $("signature").value.replace(/\r\n/g, "\n").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return show("メールアドレスの形式が不正です", true);
  if (!password) return show("パスワードを入れてください", true);

  const typed = $("host").value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const host = typed || hostFor(address);

  if (!(await ensurePermission(host))) return show(`${host} への接続を許可してください`, true);

  // Check the credentials now rather than at the first send, when a real message is at stake, and
  // take the From list and display name from the server at the same time: the board decides those.
  show("確認中…", false);
  let sendAs = [address];
  let serverName = null;
  try {
    const res = await fetch(`https://${host}/api/whoami`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) return show(body.error || "アドレスかパスワードが違います", true);
    if (!res.ok) return show(`サーバーの応答が想定外です (HTTP ${res.status})`, true);
    if (Array.isArray(body.send_as) && body.send_as.length) sendAs = body.send_as;
    serverName = body.name ?? null;
  } catch (e) {
    return show(`${host} に接続できません: ${e instanceof Error ? e.message : String(e)}`, true);
  }

  const accounts = (await load()).filter((x) => x.address !== address);
  accounts.push({ address, host, password, signature, sendAs, serverName });
  await save(accounts);
  $("password").value = "";
  show(`${address} を登録しました（差出人 ${sendAs.length} 件）`, false);
  void render();
});

// Enter in either field submits, so it is two fields and a keystroke.
for (const id of ["address", "password"]) {
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("add").click();
  });
}

void render();
