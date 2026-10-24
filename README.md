# Pikkles（ピクルス）

<!-- デモ動画ができたら、サムネイル画像と YouTube のリンクに差し替える -->
[![Pikkles デモ動画](https://jphacks.com/wp-content/uploads/2026/07/IMG_5316.png)](https://www.youtube.com/watch?v=piaNsc6ilBI)

## 製品概要
### 背景(製品開発のきっかけ、課題等）
イベントや新歓で初めて会った人とSNSを交換しても、数週間後には「どこで会った誰だっけ」となり、出会いが形に残りません。

### 製品説明（具体的な製品の説明）
撮ったモノと描いたイラストだけがステッカーになり、会ったその場でステッカーを1枚ずつ交換できるSNSです。交換は、2人それぞれのBlueskyのデータ置き場（PDS）に「この人と、この場面で会った」記録として残ります。集めたステッカーはシール帳に貼って飾れます。

### 特長
#### 1. 対面でしか手に入らないステッカー
他人のステッカーをシール帳に貼るには、会ってQRを読み合い、交換する必要があります。

#### 2. 交換が2人のPDSに残る
交換という2人の合意を、2人それぞれのPDSに書いた記録の組で表し、サーバーが照合して成立させます。

#### 3. 安心して日常を出せる
背景を消してモノだけにし、位置情報も消します。保存の前に公開されることを確認し、Blueskyのブロックも尊重します。

### 解決出来ること
<!-- 発表の台本と合わせて書く -->

### 今後の展望
<!-- 発表の台本と合わせて書く -->

### 注力したこと（こだわり等）
* 交換の成立を、サーバーのDBではなく2人のPDSにある記録の照合で決めたこと
* 

## 開発技術
### 活用した技術
#### API・データ
* AT Protocol（Bluesky）：OAuth ログイン、PDS への読み書き、サービス認証（`com.atproto.server.getServiceAuth`）
* 独自の Lexicon `com.kosora623.pikkles.*`（ステッカー、シール帳、交換、共同フィールド、ほしい）

#### フレームワーク・ライブラリ・モジュール
* フロント：TypeScript、React（Vite）、`@atproto/api`、`@atproto/oauth-client-browser`、qrcode。Vercel で公開
* サーバー：Python、FastAPI、WebSocket、`atproto`（JWT の検証・DID の解決）、rembg（u2netp）、Pillow。Render で公開

#### デバイス
* iPhone、Android端末

### 独自技術
#### ハッカソンで開発した独自機能・技術
* **対面交換を2人の PDS の記録の組で成立させる仕組み**（一番力を入れた部分）
  * 交換セッション、QR の合言葉（60秒で失効）、WebSocket での選択・確定の同期、2人の PDS から記録を読んで照合する成立判定、Bluesky のブロックの確認：[f0fad93](https://github.com/jphacks/tkb_2621/commit/f0fad93a7a59ccd1253631ff9543a09fd6a6a9f5)（[backend/app/exchange.py](backend/app/exchange.py)、[backend/app/pds.py](backend/app/pds.py)）
  * 交換画面：QR の表示、参加、選ぶ・確定、自分の PDS への記録と成立の通知：[8dac211](https://github.com/jphacks/tkb_2621/commit/8dac211b890853cd5ed9fb4cff142d74bddc06dc)（[frontend/src/components/ExchangeRoom.tsx](frontend/src/components/ExchangeRoom.tsx)）
* **ブラウザで得た JWT をサーバーが検証するサービス認証と did:web**：[a4d9d50](https://github.com/jphacks/tkb_2621/commit/a4d9d505c82c318eeddf19a09f97a0cd40cbbb35)（[backend/app/auth.py](backend/app/auth.py)）
* **撮影からステッカー化・公開の確認・PDS への保存**：[fc82fad](https://github.com/jphacks/tkb_2621/commit/fc82fad6b71cda34f07a5b0be3d7988c65b2238a)
* Bluesky の OAuth ログインと PDS の読み書き：[343448a](https://github.com/jphacks/tkb_2621/commit/343448aadc5c5ec5ec80473b39039972c669c747)

Hack Day 開始前に用意したのは開発環境（AGENTS.md、仕様書）だけで、プロダクトのコードはすべて Hack Day 中に書きました。
