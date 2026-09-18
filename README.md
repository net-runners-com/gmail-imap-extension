# gmail-imap-extension

Gmail の作成画面から独自ドメインのアドレスで送る Chrome 拡張。Gmail の Web は 2027 年 1 月に
第三者 SMTP の「別のアドレスから送信」を失うので、そこに依存しない経路を用意するためのもの。

送信先のサーバーは [mailrelay](https://github.com/net-runners-com/mailrelay) の IMAP/SMTP
プロキシ、アカウントとパスワードの管理は [mailist](https://github.com/net-runners-com/mailist)。
この拡張は入口だけを担当する。

## 何をするか

- Gmail の**「作成」を横取りする。**Gmail 自身の作成画面は開かず、この拡張の作成パネルが出る。
  `pointerdown` / `mousedown` / `mouseup` / `click` と `c` ショートカットを capture 段階で奪う。
- パネルは Gmail の作成画面に合わせてある。ヘッダーの最小化・破棄、宛先行の Cc/Bcc 切り替え、
  下のツールバー（Aa 書式設定 / 📎 添付 / 🔗 リンク / 🙂 絵文字 / 🖼 画像 / 🖊 署名 / ⋮ その他）、
  丸い送信ボタン。違うのは色だけ。書式設定は太字・斜体・下線・取り消し線・箇条書き・
  番号付きリスト・引用・インデント・書式消去。本文は HTML で送る。

  **Gmail にあってこちらに作れないものが 3 つある。** Google Drive の添付（Drive Picker と
  そのための OAuth が必要）、情報保護モード（Google のサーバーが期限付きリンクを持つ仕組み）、
  送信日時の指定（サーバー側に予約送信の仕組みが必要）。それ以外は同じ。
- Gmail 自身の作成画面も残してある。そちらを使った場合は差出人の選択と送信ボタンを足す形になる。
- 送信後、上流 Gmail の送信済みフォルダに控えを IMAP APPEND で置く。Gmail で送信履歴が追える。

Gmail の作成画面を飾るのではなく置き換える理由は 2 つ。Gmail が自分で送ってしまう事故が
原理的に起きない。下書きの残骸も出ない。

**宛先の読み取りに注意が要る。**`textarea[name="to"]` は今の Gmail に存在しない。実際は
`aria-label`（「To の宛先」「Cc」「Bcc」）だけが手がかりの `input` で、確定した宛先は
`span[email="..."]` のチップになり、打ちかけの文字は `input.value` に残る。両方読まないと
打ちかけの宛先が黙って落ちる。チップがどの行のものかは、その行の input を含み他の行の
input を含まない最小の祖先を辿って判定する。

**Gmail は Trusted Types を強制している**（実測: `innerHTML` に代入すると
`This document requires 'TrustedHTML' assignment` で例外）。だから DOM は
`createElement` と `append` だけで組んでいる。`innerHTML` を使うと動かない。

## 入れ方

ビルドは要らない。フォルダがそのまま拡張機能。

**[最新版をダウンロード](https://github.com/net-runners-com/gmail-imap-extension/releases/latest)**（GitHub アカウントは要らない）

1. zip を落として展開する
2. `chrome://extensions` →「デベロッパーモード」をオン
3. 「パッケージ化されていない拡張機能を読み込む」で展開したフォルダを選ぶ
4. ツールバーのアイコンから**メールアドレスとパスワードだけ**入れて追加

`git clone` して、そのフォルダを読み込んでもいい。

サーバー名はアドレスのドメインに `mail.` を付けて決める（`h.takeuchi@jmy-nexus.com` →
`mail.jmy-nexus.com`）。違う名前を使っている場合だけ詳細設定で上書きする。表示名はサーバー側の
設定を使うので入力欄はない。

同梱していないホストに繋ぐ場合、追加を押した時点で Chrome が接続許可を尋ねる
（`optional_host_permissions`）。許可すればそのドメインでも動く。

**差出人の一覧は自分では設定しない。**登録時とその後 Gmail を開くたびに
`POST /api/whoami` で取得する。管理画面で `info@` を共有に変えれば、次に Gmail を開いた
時点で作成画面の差出人に出る。サーバーが落ちていても保存済みの一覧で動き続ける
（空にして送れなくする方が困るため）。

自分のアドレスには表示名が付き、共有アドレスは名前なしで出る。共有アドレスに個人名が
付くと受信者が誰の名義か判断できないため。

パスワードはメールアプリ（IMAP/SMTP）と同じもの。登録時にサーバーへ問い合わせて検証するので、
実際に送るときまで誤りに気づかない事態にならない。

## 仕組み

```
作成パネル → content.js（宛先・件名・本文・添付を集める）
           → background.js（host_permissions で CORS を回避）
           → https://<サーバー>/api/send
           → Resend で配送 + 上流 Gmail の送信済みへ APPEND
```

| ファイル | 役割 |
|---|---|
| `content.js` | 作成ボタンの横取り、作成パネル、Gmail 作成画面の差出人切り替え |
| `background.js` | 差出人一覧の取得と送信。パスワードを読むのはここだけ |
| `options.js` | アドレスとパスワードの登録。`/api/whoami` で検証 |

パスワードは拡張機能のストレージにあり、`background.js` だけが読む。ページ側（content.js）には
渡らないので、Gmail のページ上のスクリプトから触れない。

## 制約

- **Gmail 自身の作成画面から送る場合、添付は取れない。** Gmail の添付は Google のサーバー上に
  あり DOM から取り出せない。この拡張の作成パネルを使えば添付は送れる（ローカルのファイルを
  読んで base64 で API に渡す）。
- Gmail の DOM は難読化されている。`role` と `name` 属性だけに依存する作りにしてあるが、
  Google の変更で壊れる可能性は残る。壊れると差出人メニューに項目が出なくなるので気づける。
- Gmail 自身の作成画面を使うと下書きが Gmail 側に残る。Mailrelay 送信は Gmail の送信処理を
  通らないため、閉じるときに Gmail が下書きとして保存することがある。作成パネル側では起きない。

## 履歴

元は [mailrelay](https://github.com/net-runners-com/mailrelay) の `extension/` にあった。
そこには `src/` 以下に TypeScript の旧実装（本文に宛先ブロックを書いて `send@` に送る方式）も
残っているが、その設計は使っていないのでこのリポジトリには持ってきていない。
