---
name: discord-communication
description: This skill should be used when the user asks to "communicate via Discord", "send a message to Discord", "check Discord for instructions", "ask a question on Discord", "notify on Discord", "share a file on Discord", "離席する", "離席モード", "Discord で待機して", "Discord待機", or when Claude Code needs to reach the user who is away from the terminal.
version: 3.0.0
---

# Discord Communication Bridge

Discord 専用チャンネルを通じてユーザーとやりとりするためのスキル。
HTTP API サーバー (`localhost:13456`) 経由で Discord Bot と通信する。

## 前提条件

サーバーが別プロセスで起動済みであること。
起動していない場合は `discord-bridge start` で起動を促す。

## ヘルパースクリプト

`$CLAUDE_PLUGIN_ROOT/skills/discord-comm/scripts/` にラッパースクリプトを用意。
Bash ツールで直接実行する。

## 使用方法

### ヘルスチェック

```bash
bash $CLAUDE_PLUGIN_ROOT/skills/discord-comm/scripts/discord-status.sh
```

### 通知（一方向）

```bash
bash $CLAUDE_PLUGIN_ROOT/skills/discord-comm/scripts/discord-notify.sh "ビルド完了しました" success
bash $CLAUDE_PLUGIN_ROOT/skills/discord-comm/scripts/discord-notify.sh "エラーが発生しました" error
```

レベル: `info`（既定）, `success`, `warning`, `error`

### 質問（返答待ち）

```bash
bash $CLAUDE_PLUGIN_ROOT/skills/discord-comm/scripts/discord-ask.sh "続行しますか？"
bash $CLAUDE_PLUGIN_ROOT/skills/discord-comm/scripts/discord-ask.sh "どの方法で進めますか？" 300 "方法A" "方法B" "方法C"
```

### メッセージ取得

```bash
bash $CLAUDE_PLUGIN_ROOT/skills/discord-comm/scripts/discord-messages.sh
bash $CLAUDE_PLUGIN_ROOT/skills/discord-comm/scripts/discord-messages.sh 20 true
```

### メッセージ待機 (SSE)

```bash
bash $CLAUDE_PLUGIN_ROOT/skills/discord-comm/scripts/discord-wait.sh
bash $CLAUDE_PLUGIN_ROOT/skills/discord-comm/scripts/discord-wait.sh 21600
```

デフォルトタイムアウト: 6時間 (21600秒)。SSE接続でメッセージをリアルタイム受信する。

### ファイル送信

```bash
bash $CLAUDE_PLUGIN_ROOT/skills/discord-comm/scripts/discord-send-file.sh /path/to/file.png "スクリーンショット"
```

## パターン

### 長時間タスク

1. `discord-notify.sh` (info) で開始を通知
2. 定期的に `discord-messages.sh` で指示変更を確認
3. `discord-notify.sh` (success) で完了通知
4. 判断が必要な場合は `discord-ask.sh`

### エラー発生時

1. `discord-notify.sh` (error) でエラー報告
2. `discord-ask.sh` で対応方針を確認
3. タイムアウト時は返答が来るまで再度 `discord-ask.sh` を呼んで待機する

### 待機モード

1. `discord-notify.sh` で状況をまとめて報告
2. `discord-wait.sh` で次の指示を待つ
3. 受信した指示を実行

## 離席モード（Discord 待受ループ）

ユーザーが「離席する」「Discord で待機して」等と言った場合、以下のループに入る。

### 開始手順

1. ヘルスチェックでサーバー接続を確認
2. Discord に「離席モード開始」を通知
3. ループ開始

### ループ動作

以下を繰り返す。**タイムアウトしても勝手に終了せず、再度待機する。**

```
loop:
  1. discord-wait.sh (timeout: 21600) でメッセージを待つ（SSE接続、6時間）
     ※ SSE接続時にサーバーが自動で「クライアント接続」をDebug通知する
     レスポンス形式: {"status":"received","messages":[...]} （配列で複数件返る可能性あり）
  2. タイムアウトした場合 → 1 に戻る
  3. メッセージを受信した場合:
     a. 全メッセージを確認し、最新のメッセージを指示として扱う
     b. ただし「戻ったよ」「終了」「おわり」「bye」等の終了指示が含まれていれば → ループ終了
     c. 「やめて」「中断」「ストップ」等のキャンセル指示が含まれていれば → その前の指示は無視
     d. それ以外なら → 最新のメッセージを指示として処理を実行（下記「処理中の動作ルール」参照）
  4. 処理完了後 → 1 に戻る
```

### 処理中の動作ルール

離席モードではターミナルが見えないため、**すべての発言・思考・行動を Discord に送る。**

#### 全出力転送

通常ターミナルに表示するテキスト出力は、すべて `discord-notify.sh` で Discord にも送る。

- ※ 指示の受信・伝達は中継サーバーが自動通知するため手動通知は不要
- 指示の解釈と対応方針 → `"〇〇と解釈。△△で対応します"` (info) **← 必須**
- 処理の各ステップ → `"〇〇を実行中..."` (info)
- ツール実行結果の要約 → `"コンパイル結果: エラー0件"` (info)
- 判断・方針の説明 → `"〇〇のため、△△の方法で進めます"` (info)
- 処理完了 → 結果のまとめ (success) **← 必須**
- エラー発生 → エラー内容 (error) → `discord-ask.sh` で対応を確認

メッセージは簡潔にまとめつつ、何をしているか追えるレベルの粒度で送る。
1つのツール実行ごとに1通知が目安。ただし連続する軽微な操作はまとめてよい。

#### 定期的なメッセージキューチェック（割り込み検知）

処理中、ユーザーが Discord で新しい指示・変更・中断を送る可能性がある。
**各ステップの合間に必ず `discord-messages.sh` でキューをチェック**し、新着メッセージがないか確認する。

```
チェックタイミング（必須）:
  - ツール実行の前（Bash, Edit, Write 等を呼ぶ直前）
  - 長いループの各イテレーション
  - 判断ポイント（次に何をするか考える時）
  - サブタスクの完了ごと（コンパイル確認後、コミット後など）
```

新着メッセージがあった場合の対応:
- 中断指示（「止まって」「ストップ」「stop」「中断」「待って」「やめて」）→ 処理を安全な状態で止め、`discord-notify.sh` (warning) で「中断しました。現在の状態: 〇〇」を報告し、`discord-wait.sh` で次の指示を待つ
- 指示変更・追加 → 現在の処理を完了させるか中断するかを判断し、新しい指示を処理する
- その他のメッセージ → 処理完了後に対応（緊急でなければ後回しでよい）

#### ユーザー判断が必要な場合

- `discord-ask.sh` で質問し、選択肢を提示する
- 破壊的な操作（git push, ファイル削除等）は必ず確認を取る
- 不明確な指示は処理を始める前に明確化する

### 終了時

1. 離席モード中に行った作業のまとめを作成する
2. そのまとめを Discord に `discord-notify.sh` で送信する
3. 同じまとめをターミナルにもテキスト出力する
4. Discord に「離席モード終了。ターミナルに戻ります。」を通知し、通常のターミナル入力待ちに戻る。

### 待機中の通知頻度制限

離席モードのループ中、**タスクがない待機状態のステータス通知は3時間に1回まで**とする。

- 待機ループに入った直後の「待機開始」通知は送ってよい
- その後、**タスクなしで待機し続ける間**は discord-notify.sh を呼ばない（ログ上のポーリングは継続）
- 2時間以上タスクなしが続いた場合のみ「引き続き待機中」と1回通知し、再び2時間サイレント
- タスクを処理した場合は完了通知を送り、待機復帰時にタイマーをリセット
- この制限は **待機中のステータス通知のみ** に適用。タスク処理中の通知には適用しない

### 注意事項

- 離席モード中もターミナルの作業ディレクトリは維持される
- 1回の指示で処理が完結するよう心がける
- Discord のメッセージ上限（2000文字）を超える場合は分割して送信する
## Codex Worker 自動委譲ルール

あなた（Claude Code）はDiscordで受け取ったタスクを、自分で処理するかCodex Workerに委譲するか自律判断する。

### 自分で処理するタスク（ccが担当）
- 戦略・企画・ビジョン策定
- ユーザーへの質問・確認が必要な判断
- DAILY.md / PLAN.md / SPEC.md の更新
- Web検索が必要な調査
- 機密情報を含む作業（API鍵・パスワード等）
- ファイルの書き込み・編集（Codexはread-onlyサンドボックス）
- git操作（commit, push, PR作成等）

### Codexに委譲するタスク
- コード実装・リファクタ・バグ修正
- コードレビュー・品質チェック
- 文書の構造化・分析・要約
- 下書き作成（Markdown）
- 翻訳・英文チェック
- データ分析・レポート作成
- 技術比較・PoC検討
- テスト作成

### 委譲方法
以下のBashコマンドでCodex Workerにタスクを送る：
```bash
bash $CLAUDE_PLUGIN_ROOT/skills/discord-comm/scripts/discord-delegate.sh "タスク内容" [1-5]
```
- 番号(1-5)を省略するとbridge-codexに送る
- 複数タスクがある場合は番号を分けて並列委譲する（例: 1に分析、2にレビュー）
- Codexはread-onlyサンドボックスで動作するため、ファイル書き込みが必要な場合は結果を受け取って自分で書き込む

### 委譲の流れ
1. タスクを受信
2. cc処理 or codex委譲を判断
3. codex委譲の場合: discord-delegate.sh でタスク送信→結果を待つ
4. 結果をDiscordで報告（discord-notify.sh）
5. ファイル書き込みが必要なら自分で実行

### 並列委譲の例
大きなタスクは分割して複数のCodex Workerに同時に投げる：
```bash
# Worker 1にコード実装、Worker 2にテスト作成を同時に依頼
bash $CLAUDE_PLUGIN_ROOT/skills/discord-comm/scripts/discord-delegate.sh "関数Xを実装して" 1 &
bash $CLAUDE_PLUGIN_ROOT/skills/discord-comm/scripts/discord-delegate.sh "関数Xのテストを書いて" 2 &
wait
```
