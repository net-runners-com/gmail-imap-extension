/**
 * Two ways into Mailrelay from Gmail, because Gmail opens compose windows for two different reasons.
 *
 *  - 作成 (new mail) is taken over: the click is swallowed before Gmail sees it and our own panel
 *    opens instead. Owning the whole window means Gmail can never send the message itself, no stray
 *    draft is left behind, and attachments work.
 *  - A compose window Gmail opens anyway (reply, forward, an existing draft) is decorated: the domain
 *    addresses are added to Gmail's own 差出人 menu, and choosing one arms Gmail's own send button to
 *    go through Mailrelay. Replies keep their quoted thread that way.
 *
 * Gmail's markup is generated, so every lookup is by role, aria attribute, or the name attribute
 * Gmail has kept for years (to/cc/bcc/subjectbox), never by class name. Gmail also enforces Trusted
 * Types, so the DOM is built with createElement/append only — an innerHTML assignment throws.
 */

let accounts = [];
/** One choice per address a login may send as. The board decides the list; it is fetched, not typed. */
let senders = [];
let panel = null;
const ARMED = new WeakMap(); // Gmail compose dialog → the chosen sender
let sending = false;

/* ---------- finding things in Gmail ---------- */

const composeWindows = () =>
  [...document.querySelectorAll('div[role="dialog"]')].filter((d) => d.querySelector('input[name="subjectbox"]'));

/**
 * Reading recipients out of Gmail's compose window.
 *
 * There is no textarea[name="to"] any more: the visible field is an input whose only stable handle
 * is its aria-label ("To の宛先" / "Cc" / "Bcc"), and a committed recipient becomes a chip,
 * span[email="..."], while text the user has typed but not committed stays in the input's value.
 * Both have to be read, or a half-typed address is silently dropped.
 */
function recipientInputs(box) {
  return [...box.querySelectorAll("input")].filter((n) => /宛先|(^|\s)Cc(\s|$)|(^|\s)Bcc(\s|$)|(^|\s)To(\s|$)/i.test(n.getAttribute("aria-label") || ""));
}

const rowKind = (input) => {
  const a = input.getAttribute("aria-label") || "";
  return /Bcc/i.test(a) ? "bcc" : /Cc/i.test(a) ? "cc" : "to";
};

/** The smallest ancestor holding this input's chips and no other recipient row's. */
function rowScope(box, input, inputs) {
  let node = input;
  while (node.parentElement && node.parentElement !== box) {
    const parent = node.parentElement;
    if ([...parent.querySelectorAll("input")].filter((n) => inputs.includes(n)).length > 1) break;
    node = parent;
    if (node.querySelector("[email]")) break;
  }
  return node;
}

function recipients(box) {
  const out = { to: "", cc: "", bcc: "" };
  const inputs = recipientInputs(box);
  for (const input of inputs) {
    const scope = rowScope(box, input, inputs);
    const chips = [...scope.querySelectorAll("[email]")].map((n) => {
      const email = n.getAttribute("email");
      const text = (n.textContent || "").trim();
      return text && text !== email ? `${text} <${email}>` : email;
    });
    const typed = String(input.value || "").trim().replace(/[,;]$/, "");
    if (typed && !chips.some((c) => c.includes(typed))) chips.push(typed);
    out[rowKind(input)] = chips.join(", ");
  }
  return out;
}

const bodyElement = (box) => box.querySelector('div[g_editable="true"], div[contenteditable="true"][role="textbox"]');

const composeOf = (node) => (node instanceof Element ? composeWindows().find((b) => b.contains(node)) : undefined);

/** Gmail's 作成 / Compose control in the left rail. */
function isComposeControl(el) {
  const node = el.closest?.('[role="button"], [gh="cm"], div[jsaction]');
  if (!node) return null;
  if (node.getAttribute("gh") === "cm") return node;
  const text = `${node.getAttribute("aria-label") || ""} ${node.getAttribute("data-tooltip") || ""} ${node.textContent || ""}`.slice(0, 60);
  return /^\s*(作成|Compose)\s*$/.test(node.textContent || "") || /(^|\s)(作成|Compose)(\s|$)/.test(text) ? node : null;
}

/** Gmail's send button, excluding the schedule-send split arrow. */
function sendButton(box) {
  return [...box.querySelectorAll('div[role="button"]')].find((b) => {
    const t = `${b.getAttribute("data-tooltip") || ""} ${b.getAttribute("aria-label") || ""}`;
    return /送信|Send/.test(t) && !/オプション|options|Schedule|予定|後で/i.test(t);
  });
}

/** Gmail's From control: the popup trigger in the compose header that shows an address. */
function fromControl(box) {
  return [...box.querySelectorAll('[aria-haspopup], [role="button"]')].find(
    (el) => /@/.test(el.textContent || "") && !el.closest('[role="menu"]') && (el.textContent || "").length < 120,
  );
}

/* ---------- shared helpers ---------- */

const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};

function toast(text, ok) {
  const t = el("div", `mr-toast${ok ? "" : " mr-toast-error"}`, text);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ok ? 4000 : 9000);
}

function closeCompose(box) {
  const close = [...box.querySelectorAll('div[role="button"], img')].find((b) =>
    /閉じる|Close|保存して閉じる/.test(`${b.getAttribute("aria-label") || ""} ${b.getAttribute("data-tooltip") || ""}`),
  );
  if (close) close.click();
}

async function post(payload) {
  try {
    return await chrome.runtime.sendMessage({ type: "send", ...payload });
  } catch (e) {
    // The script in an open Gmail tab is orphaned when the extension is reloaded or updated.
    // Chrome's own wording ("Extension context invalidated.") does not say what to do about it.
    const m = e instanceof Error ? e.message : String(e);
    if (/context invalidated|Extension context|Receiving end does not exist/i.test(m)) {
      throw new Error("拡張機能が更新されました。Gmail のタブを再読み込みしてから、もう一度送信してください。");
    }
    throw e;
  }
}

/* ---------- our own compose panel (作成) ---------- */

function row(label, input) {
  const r = el("div", "mr-row");
  r.append(el("span", "mr-label", label), input);
  return r;
}

/** Reads the picked files into base64, which is what the API takes. */
function readFiles(list) {
  return Promise.all(
    [...list].map(
      (file) =>
        new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onerror = () => reject(new Error(`${file.name} を読めません`));
          r.onload = () => {
            const s = String(r.result);
            resolve({ filename: file.name, content: s.slice(s.indexOf(",") + 1), content_type: file.type || undefined, dataUrl: s });
          };
          r.readAsDataURL(file);
        }),
    ),
  );
}

const closePanel = () => {
  panel?.remove();
  panel = null;
};

/** A toolbar button: an icon that keeps focus in the body so execCommand applies to the selection. */
function tool(label, title, onClick) {
  const b = el("button", "mr-tool", label);
  b.type = "button";
  b.title = title;
  b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the caret where it is
  b.addEventListener("click", (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}

const EMOJI = ["😀", "😅", "🙏", "🙌", "👍", "🎉", "✅", "⚠️", "📎", "📅", "🔥", "💡", "❤️", "😭", "🤝", "🚀"];

function openPanel() {
  closePanel();
  if (!senders.length) {
    toast("Mailrelay にアドレスが登録されていません。拡張機能のアイコンから登録してください。", false);
    return;
  }
  panel = el("div", "mr-panel");

  /* header: title, minimise, close — the three controls Gmail puts there */
  const head = el("div", "mr-head");
  const title = el("span", "mr-title", "新規メッセージ · Mailrelay");
  const min = el("button", "mr-icon", "—");
  min.type = "button";
  min.title = "最小化";
  min.addEventListener("click", () => panel.classList.toggle("mr-min"));
  const close = el("button", "mr-icon", "✕");
  close.type = "button";
  close.title = "破棄";
  close.addEventListener("click", closePanel);
  head.append(title, el("span", "mr-spacer"), min, close);

  /* fields */
  const from = el("select", "mr-from");
  senders.forEach((sender, i) => {
    const o = el("option", null, sender.label);
    o.value = String(i);
    from.append(o);
  });
  const to = el("input", "mr-input");
  to.placeholder = "宛先";
  const cc = el("input", "mr-input");
  const bcc = el("input", "mr-input");
  const subject = el("input", "mr-input");
  subject.placeholder = "件名";

  const body = el("div", "mr-body");
  body.contentEditable = "true";
  body.setAttribute("role", "textbox");
  body.setAttribute("aria-label", "メッセージ本文");

  const ccRow = row("Cc", cc);
  const bccRow = row("Bcc", bcc);
  ccRow.hidden = true;
  bccRow.hidden = true;
  const ccToggle = el("button", "mr-cc", "Cc Bcc");
  ccToggle.type = "button";
  ccToggle.addEventListener("click", () => {
    ccRow.hidden = !ccRow.hidden;
    bccRow.hidden = ccRow.hidden;
  });
  const toRow = row("宛先", to);
  toRow.append(ccToggle);

  /* attachments, kept in a visible list like Gmail's chips */
  const attached = [];
  const chips = el("div", "mr-chips");
  const picker = el("input", "mr-hidden-file");
  picker.type = "file";
  picker.multiple = true;

  function renderChips() {
    chips.textContent = "";
    attached.forEach((a, i) => {
      const chip = el("span", "mr-chip");
      const x = el("button", "mr-chip-x", "✕");
      x.type = "button";
      x.addEventListener("click", () => {
        attached.splice(i, 1);
        renderChips();
      });
      chip.append(el("span", null, a.filename), x);
      chips.append(chip);
    });
  }

  picker.addEventListener("change", async () => {
    try {
      const files = await readFiles(picker.files);
      for (const f of files) attached.push(f);
      renderChips();
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
    }
    picker.value = "";
  });

  /* inline images go into the body rather than the attachment list */
  const imagePicker = el("input", "mr-hidden-file");
  imagePicker.type = "file";
  imagePicker.accept = "image/*";
  imagePicker.multiple = true;
  imagePicker.addEventListener("change", async () => {
    const files = await readFiles(imagePicker.files);
    for (const f of files) {
      const img = document.createElement("img");
      img.src = f.dataUrl;
      img.style.maxWidth = "100%";
      insertNode(img);
    }
    imagePicker.value = "";
  });

  /** Puts a node at the caret inside the body, or at the end when there is no caret there. */
  function insertNode(node) {
    body.focus();
    const sel = window.getSelection();
    if (sel && sel.rangeCount && body.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      body.append(node);
    }
  }

  const cmd = (name, value) => {
    body.focus();
    document.execCommand(name, false, value);
  };

  /* formatting row, shown by Aa like Gmail's */
  const format = el("div", "mr-format");
  format.hidden = true;
  format.append(
    tool("B", "太字", () => cmd("bold")),
    tool("I", "斜体", () => cmd("italic")),
    tool("U", "下線", () => cmd("underline")),
    tool("S", "取り消し線", () => cmd("strikeThrough")),
    tool("•", "箇条書き", () => cmd("insertUnorderedList")),
    tool("1.", "番号付きリスト", () => cmd("insertOrderedList")),
    tool("❝", "引用", () => cmd("formatBlock", "blockquote")),
    tool("⇤", "インデント解除", () => cmd("outdent")),
    tool("⇥", "インデント", () => cmd("indent")),
    tool("✕", "書式を消去", () => cmd("removeFormat")),
  );

  /* emoji picker */
  const emoji = el("div", "mr-emoji");
  emoji.hidden = true;
  for (const e of EMOJI) {
    const b = el("button", "mr-emoji-btn", e);
    b.type = "button";
    b.addEventListener("mousedown", (ev) => ev.preventDefault());
    b.addEventListener("click", () => {
      insertNode(document.createTextNode(e));
      emoji.hidden = true;
    });
    emoji.append(b);
  }

  /* the more menu */
  const more = el("div", "mr-menu");
  more.hidden = true;
  const discard = el("button", "mr-menu-item", "下書きを破棄");
  discard.type = "button";
  discard.addEventListener("click", closePanel);
  const plain = el("button", "mr-menu-item", "書式をすべて消去");
  plain.type = "button";
  plain.addEventListener("click", () => {
    body.textContent = body.innerText;
    more.hidden = true;
  });
  more.append(discard, plain);

  /* footer: send plus the same set of tools Gmail shows, minus the three that need Google */
  const send = el("button", "mr-send", "送信");
  send.type = "button";
  const status = el("span", "mr-status");

  const chosen = () => senders[Number(from.value)] ?? senders[0];
  const loginOf = () => chosen()?.login;
  const signature = accounts.find((a) => a.address === loginOf())?.signature || "";
  const sigButton = tool("🖊", "署名を挿入", () => {
    const sig = accounts.find((a) => a.address === loginOf())?.signature;
    if (!sig) {
      status.textContent = "署名が登録されていません（拡張機能の設定で追加）";
      return;
    }
    const wrap = document.createElement("div");
    wrap.append(document.createElement("br"), document.createTextNode("--"), document.createElement("br"));
    for (const line of sig.split("\n")) {
      wrap.append(document.createTextNode(line), document.createElement("br"));
    }
    insertNode(wrap);
  });

  const foot = el("div", "mr-foot");
  foot.append(
    send,
    tool("Aa", "書式設定", () => {
      format.hidden = !format.hidden;
    }),
    tool("📎", "ファイルを添付", () => picker.click()),
    tool("🔗", "リンクを挿入", () => {
      const url = prompt("リンク先の URL");
      if (!url) return;
      const a = document.createElement("a");
      a.href = url;
      a.textContent = window.getSelection()?.toString() || url;
      insertNode(a);
    }),
    tool("🙂", "絵文字", () => {
      emoji.hidden = !emoji.hidden;
    }),
    tool("🖼", "画像を挿入", () => imagePicker.click()),
    sigButton,
    tool("⋮", "その他", () => {
      more.hidden = !more.hidden;
    }),
    status,
  );

  send.addEventListener("click", async () => {
    if (!to.value.trim() && !cc.value.trim() && !bcc.value.trim()) {
      status.textContent = "宛先を入れてください";
      return;
    }
    send.disabled = true;
    status.textContent = "送信中…";
    try {
      // from.value is the index into `senders`, not an address: the account that authenticates is
      // the sender's login, and the address that goes in From is the one chosen here.
      const sender = senders[Number(from.value)] ?? senders[0];
      const res = await post({
        address: sender.login,
        from: sender.address,
        to: to.value,
        cc: cc.value,
        bcc: bcc.value,
        subject: subject.value,
        html: body.innerHTML,
        text: body.innerText,
        attachments: attached.map(({ filename, content, content_type }) => ({ filename, content, content_type })),
      });
      if (res?.ok) {
        closePanel();
        toast(`${sender.address} から送信しました${res.copied ? "（送信済みに保存）" : "（送信済みへの保存は失敗）"}`, true);
      } else {
        send.disabled = false;
        status.textContent = res?.error || "不明なエラー";
      }
    } catch (e) {
      send.disabled = false;
      status.textContent = e instanceof Error ? e.message : String(e);
    }
  });

  const form = el("div", "mr-form");
  form.append(row("差出人", from), toRow, ccRow, bccRow, row("件名", subject), format, body, chips, emoji, more);

  panel.append(head, form, foot, picker, imagePicker);
  document.body.appendChild(panel);
  if (signature) sigButton.click();
  to.focus();
}

/* ---------- decorating a compose window Gmail opened (reply, forward, draft) ---------- */

async function sendArmed(box, sender) {
  if (sending) return;
  const body = bodyElement(box);
  const data = {
    address: sender.login,
    from: sender.address,
    ...recipients(box),
    subject: box.querySelector('input[name="subjectbox"]')?.value || "",
    html: body ? body.innerHTML : "",
    text: body ? body.innerText : "",
  };
  if (!data.to && !data.cc && !data.bcc) {
    toast("宛先を入れてください", false);
    return;
  }
  sending = true;
  const btn = sendButton(box);
  const original = btn?.textContent;
  if (btn) btn.textContent = "送信中…";
  try {
    const res = await post(data);
    if (res?.ok) {
      toast(`${sender.address} から送信しました${res.copied ? "（送信済みに保存）" : "（送信済みへの保存は失敗）"}`, true);
      closeCompose(box);
    } else {
      if (btn) btn.textContent = original;
      toast(`送信できませんでした: ${res?.error || "不明なエラー"}`, false);
    }
  } finally {
    sending = false;
  }
}

function arm(box, sender) {
  ARMED.set(box, sender);
  const control = fromControl(box);
  if (control) {
    const label = sender.label;
    const leaves = [...control.querySelectorAll("*")].filter((n) => !n.children.length && /@/.test(n.textContent || ""));
    for (const n of leaves) n.textContent = label;
    if (!leaves.length) control.textContent = label;
  }
  const btn = sendButton(box);
  if (btn) btn.classList.add("mailrelay-armed");
  toast(`差出人を ${sender.address} にしました。送信は Mailrelay を通ります。`, true);
}

function disarm(box) {
  ARMED.delete(box);
  sendButton(box)?.classList.remove("mailrelay-armed");
}

/** Adds the domain addresses to a 差出人 menu Gmail has just opened. */
function decorateMenu(menu) {
  if (menu.getAttribute("data-mailrelay") || !senders.length) return;
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  // Only the From menu lists an address; other Gmail menus must be left alone.
  if (!items.length || !items.some((i) => /@/.test(i.textContent || ""))) return;
  const box = composeOf(menu) || composeWindows()[composeWindows().length - 1];
  if (!box) return;
  menu.setAttribute("data-mailrelay", "1");

  const template = items[0];
  for (const sender of senders) {
    const item = template.cloneNode(false);
    item.removeAttribute("id");
    item.className = `${template.className} mailrelay-menuitem`;
    item.setAttribute("role", "menuitem");
    item.textContent = `${sender.label} — Mailrelay`;
    item.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        arm(box, sender);
        menu.style.display = "none";
      },
      true,
    );
    template.parentElement.appendChild(item);
  }
  for (const item of items) item.addEventListener("click", () => disarm(box), true);
}

/* ---------- interception ---------- */

/**
 * Gmail binds on several event types, so each is swallowed in the capture phase. Letting one through
 * would open Gmail's own compose on top of ours, or send an armed message from the Gmail address.
 */
function intercept(event) {
  if (!senders.length || !(event.target instanceof Element)) return;

  // 作成 → our panel.
  if (isComposeControl(event.target)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "click") openPanel();
    return;
  }

  // An armed compose window → Mailrelay instead of Gmail.
  const box = composeOf(event.target);
  const sender = box && ARMED.get(box);
  if (!sender) return;
  const btn = sendButton(box);
  if (!btn || !btn.contains(event.target)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.type === "click") void sendArmed(box, sender);
}

for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
  document.addEventListener(type, intercept, true);
}

document.addEventListener(
  "keydown",
  (event) => {
    if (!senders.length) return;
    // Cmd/Ctrl+Enter sends an armed compose window.
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      const box = composeOf(event.target);
      const sender = box && ARMED.get(box);
      if (!sender) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void sendArmed(box, sender);
      return;
    }
    // "c" is Gmail's compose shortcut, unless the user is typing.
    if (event.key === "c" && !event.metaKey && !event.ctrlKey && !event.altKey && !panel) {
      const t = event.target;
      if (t instanceof Element && (t.matches("input, textarea, select") || t.closest('[contenteditable="true"]'))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openPanel();
    }
  },
  true,
);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && panel) closePanel();
});

/* ---------- wiring ---------- */

new MutationObserver((records) => {
  if (!senders.length) return;
  for (const r of records) {
    for (const node of r.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches?.('[role="menu"]')) decorateMenu(node);
      for (const menu of node.querySelectorAll?.('[role="menu"]') || []) decorateMenu(menu);
    }
  }
  // Gmail rebuilds the toolbar, which drops the marker class; put it back.
  for (const box of composeWindows()) {
    if (!ARMED.get(box)) continue;
    const btn = sendButton(box);
    if (btn && !btn.classList.contains("mailrelay-armed")) btn.classList.add("mailrelay-armed");
  }
}).observe(document.body, { childList: true, subtree: true });

function buildSenders() {
  senders = [];
  for (const account of accounts) {
    const list = Array.isArray(account.sendAs) && account.sendAs.length ? account.sendAs : [account.address];
    for (const address of list) {
      // The display name belongs to the login's own address; a shared one goes out bare.
      const name = address === account.address ? account.serverName || "" : "";
      senders.push({ login: account.address, address, name, label: name ? `${name} <${address}>` : address });
    }
  }
}

async function refresh() {
  const stored = await chrome.storage.local.get("accounts");
  accounts = Array.isArray(stored.accounts) ? stored.accounts : [];
  buildSenders();
  // Ask the servers for the current list; storage.onChanged brings the answer back here.
  try {
    const res = await chrome.runtime.sendMessage({ type: "refresh" });
    if (res?.ok && Array.isArray(res.accounts)) {
      accounts = res.accounts;
      buildSenders();
    }
  } catch {
    // The service worker may be asleep; the stored list still works.
  }
}

chrome.storage.onChanged.addListener(async () => {
  const stored = await chrome.storage.local.get("accounts");
  accounts = Array.isArray(stored.accounts) ? stored.accounts : [];
  buildSenders();
});
void refresh();
