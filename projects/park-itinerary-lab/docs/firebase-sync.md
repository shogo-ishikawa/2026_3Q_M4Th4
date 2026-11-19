# Googleログインとしおり同期の初期設定

TDRoute専用のFirebaseプロジェクトを使います。Web版とホーム画面版のどちらも、プランの作成にはGoogleログインが必要です。使い方と精度レポートはログイン前にも読めます。名前を付けて保存したしおりは本人のアカウントに同期します。しおりを待ち時間の学習データに提供する処理はありません。

## Firebaseコンソール

1. [Firebaseコンソール](https://console.firebase.google.com/)で新しいプロジェクトを作ります。プランはSparkを選びます。Google Analyticsは任意で、この機能には不要です。
2. 「Authentication」からログイン方法の「Google」を有効にし、サポートメールを設定します。「Authentication」→「設定」→「承認済みドメイン」に `shogo-ishikawa.github.io` を追加します。ドメインはホスト名のみを入力します。配布ZIPの `run.py` からもログインを試す場合は、起動時に表示される `127.0.0.1` を追加します。ブラウザで `localhost` を使う開発環境は、その名前も追加してください。
3. 「Firestore Database」でデータベースを作成します。Standardエディションの `(default)` を本番モードで作り、日本向けには東京の `asia-northeast1` を選びます。保存場所は作成後に変更できません。しおりのコレクションは初回保存時に作られます。
4. 「プロジェクトの設定」→「全般」→「マイアプリ」でウェブアプリ（`</>`）を登録します。ウェブページは既存のGitHub Pagesで配信します。Firebase Hostingの追加は不要です。

## 管理者が確認できる情報

Firebase Authenticationの利用者一覧ではメールアドレス、利用者ID（UID）、ログイン方法、登録日時、最終ログイン日時を確認できます。Googleから提供された表示名やプロフィール写真のURLも、利用者レコードを読み取る権限があれば取得できます。

利用者の画面ではGoogleの表示名であいさつします。運営者本人の画面には「良い一日を！」と赤字の「管理者画面」を表示します。この表示はアカウントを見分けるためのもので、Firebase上のアクセス権はIAMが管理します。

[Firebase Authenticationの利用者管理](https://firebase.google.com/docs/auth/admin/manage-users?hl=ja) ／ [FirestoreのIAM権限](https://firebase.google.com/docs/firestore/security/iam?hl=ja)

## しおりのアクセス権

リポジトリのルートから次のコマンドを実行します。`YOUR_TDROUTE_PROJECT_ID` は作成したプロジェクトの「プロジェクト ID」に置き換えます。指定したプロジェクトの既定データベースにルールとインデックス設定が反映されます。

```sh
cd projects/park-itinerary-lab/firebase
npx --yes firebase-tools@15.36.0 login
npx --yes firebase-tools@15.36.0 deploy --only firestore:rules,firestore:indexes --project YOUR_TDROUTE_PROJECT_ID
```

[firestore.rules](../firebase/firestore.rules) はGoogleで認証した本人に `users/{uid}/plans` 配下の読み書きだけを許可します。しおりを削除すると本文を消し、他端末に削除を伝えるための版番号と空文字だけが残ります。[firestore.indexes.json](../firebase/firestore.indexes.json) は検索に使わないしおり本文をインデックスから除外します。

## 公開設定と動作確認

「マイアプリ」のSDK設定からウェブアプリの公開用 `firebaseConfig` を取り出し、[web/firebase-config.json](../web/firebase-config.json) へJSONで保存します。設定値を本番に取り込む前に、対象プロジェクトのルールを反映してください。ログインと配布にサービスアカウントJSON、管理者の秘密鍵、OAuthクライアントシークレットは使いません。

1. 公開候補版を承認済みのドメインで開き、ログイン前にはしおりを開けないことを確認します。
2. GoogleアカウントAでログインし、名前を付けてしおりを保存します。別の端末からAで開き、同じしおりを読み込めることを確認します。
3. ログアウト後に別のGoogleアカウントBでログインします。Aのしおりが一覧に現れないことを確認します。Aのしおりを削除した場合も、オンラインに戻ったAの別端末で削除が反映されることを確認します。

## ルールのテスト

Node.js 24とJava 21を使用します。先ほどの `firebase` フォルダで実行してください。公式のFirestore Emulatorでテスト専用のアカウントとしおりを作り、読み書きの許可・拒否、版番号、本文サイズの上限を確認します。

```sh
npm ci
npx --yes firebase-tools@15.36.0 emulators:exec --only firestore --project demo-tdroute 'node --test firestore-rules.test.mjs'
```

配布版のFirebase SDKで2端末の同期を確認するテストもあります。ChromeとPlaywrightを用意してから次を実行します。テスト用のGoogle認証情報を発行するのはローカルのAuth Emulatorです。

```sh
npx --yes firebase-tools@15.36.0 emulators:exec --only auth,firestore --project demo-tdroute-check 'python ../tests-web/firebase_emulator_browser.py --credential'
```

無料枠の利用状況はFirebaseコンソールの「Firestore Database」→「使用状況」で確認できます。[Firestoreの無料枠](https://firebase.google.com/docs/firestore/quotas?hl=ja) ／ [Googleログイン](https://firebase.google.com/docs/auth/web/google-signin?hl=ja) ／ [Firestoreの保存場所](https://firebase.google.com/docs/firestore/locations?hl=ja) ／ [Firebaseのウェブ用APIキー](https://firebase.google.com/docs/projects/api-keys?hl=ja)
