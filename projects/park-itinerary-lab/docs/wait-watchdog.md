# 外部収集と夜間の完了確認

TDRouteの待ち時間収集を補うには、GitHub Actionsとは別の常時稼働Linuxホストで `scripts/park_wait_watchdog.py` を定期実行します。営業時間帯の各30分枠の途中で、両園のQueue-Timesの現在値を直接取得します。GitHubと通信する前に観測元の更新時刻と受信時刻をホストのディスクに保存するので、Actionsが遅れてもその時刻の観測を後から取り込めます。収集ホスト自体の停止中や、Queue-Timesから有効な現在値が取得できなかった枠は欠測になります。

## ホストに設置する

Python 3.12、cron、永続ディスクを使います。次の例はリポジトリをホームディレクトリの `TDRoute` に配置します。

~~~sh
git clone https://github.com/shogo-ishikawa/2026_3Q_M4Th4.git "$HOME/TDRoute"
install -d -m 700 "$HOME/.config/tdroute" "$HOME/.local/state/tdroute-waits"
(umask 077 && touch "$HOME/.config/tdroute/watchdog.env")
chmod 600 "$HOME/.config/tdroute/watchdog.env"
~~~

設定ファイルには次の2行を記入します。トークンはこのリポジトリだけを対象とし、`Contents: write`（観測の保存）と `Actions: write`（収集・夜間処理の起動）を付けます。外部ホストに保存し、Gitにはコミットしません。

~~~sh
export TDROUTE_GITHUB_TOKEN='ここをホスト上で設定'
TDROUTE_WATCHDOG="$HOME/TDRoute/projects/park-itinerary-lab/scripts/park_wait_watchdog.py"
~~~

## 時刻と通知を設定する

以下は **ホストのcronが日本時間で動いている場合** のユーザー用 `crontab -e` の例です。`MAILTO` は受け取り先に置き換え、ホストでcronのメール配送を有効にします。正常時の標準出力を捨て、失敗時の標準エラーを通知に使います。別の監視サービスを使うホストでは、同じコマンドの終了コードを監視できます。

~~~cron
SHELL=/bin/sh
MAILTO=operator@example.org
15,45 8-21 * * * . "$HOME/.config/tdroute/watchdog.env" && python3 "$TDROUTE_WATCHDOG" collect --spool-dir "$HOME/.local/state/tdroute-waits" >/dev/null
30 22 * * * . "$HOME/.config/tdroute/watchdog.env" && python3 "$TDROUTE_WATCHDOG" recover --spool-dir "$HOME/.local/state/tdroute-waits" >/dev/null
0 23 * * * . "$HOME/.config/tdroute/watchdog.env" && python3 "$TDROUTE_WATCHDOG" check --spool-dir "$HOME/.local/state/tdroute-waits" >/dev/null
~~~

UTCで動くcronでは3行の先頭をそれぞれ `15,45 0-12,23 * * *`、`30 13 * * *`、`0 14 * * *` に置き換えます。

| 日本時間 | 動作 |
| --- | --- |
| 08〜21時台の毎時15・45分 | 稼働中の施設の有効な掲示値を取得。未送信分をデータブランチの `backup-observations/YYYY-MM-DD.json` に保存し、観測が不足する場合は `collect` を起動します。通常のActionsもバックアップを取り込みます。 |
| 22:30 | 対象営業日の学習状況と両園の翌日予測を確認し、不足する場合に `recover` を起動します。 |
| 23:00 | 保存結果を再確認し、未完了ならエラーを返します。 |

`check` は公開データを読み取り、外部ホストを構成する前にもトークンなしで実行できます。導入時はまず手動でこの確認を行います。営業中は `collect` の実行後、データブランチでその日のバックアップと `observations.json` に園別の観測が入ったことを確認してください。GitHubに送れなかった観測はスプールに残すので、障害復旧時も同じディレクトリで再実行します。トークンの期限や権限のエラーは、設定を直してから再実行してください。

~~~sh
. "$HOME/.config/tdroute/watchdog.env"
python3 "$TDROUTE_WATCHDOG" check --spool-dir "$HOME/.local/state/tdroute-waits"
~~~

[収集Actions](https://github.com/shogo-ishikawa/2026_3Q_M4Th4/actions/workflows/park-wait-data.yml) · [データブランチ](https://github.com/shogo-ishikawa/2026_3Q_M4Th4/tree/park-wait-data) · [Queue-Timesの公開API](https://queue-times.com/en-US/pages/api)
