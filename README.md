# AfterBirth AB-3389

ブラウザで動くアシッド・グルーヴボックス。TB-303 系ベースライン × 2、808 系 / 909 系ドラムマシン、ミキサー、エフェクトを Web Audio API だけで鳴らします。外部ライブラリなし、`index.html` 1 ファイル。

**▶ ブラウザで遊ぶ: https://verytired.github.io/afterbirth/**

![screenshot](docs/screenshot.png)

## 起動

```sh
open index.html   # またはブラウザにドラッグ
```

▶ を押すと音が出ます（ブラウザの仕様で最初のクリックまでは音声が止まっています）。Chrome / Edge 推奨。

## 構成

| ユニット | 内容 |
|---|---|
| **AB-303 #1 / #2** | SAW / SQUARE、TUNE / CUTOFF / RESO / ENV MOD / DECAY / ACCENT。16 ステップで音程・UP / DN・ACC（アクセント）・SLD（スライド） |
| **AB-808** | BD / SD / CH / OH / CP。全部シンセで生成、CH が OH をチョーク |
| **AB-909** | BD / SD / LT / HT / RS / CP / CH / OH / CR |
| **PATTERN** | 各マシン 32 パターン（1〜8 × A〜D）。再生中の切替は次の小節頭。パターンごとに SHUFFLE の ON / OFF |
| **MIX** | ミュート、PAN、DELAY センド、フェーダー、DIST / PCF / COMP のインサート |
| **MASTER** | メーター、マスターフェーダー、マスター COMP |
| **PCF** | パターンでフィルターを開閉するエフェクト。32 パターン、LP / BP、FREQ / Q / AMT / DEC |
| **DELAY** | テンポ同期（ステップ数、♪ / 3 連）、PAN、F.BACK |
| **DIST** | AMOUNT、SHAPE（ソフトクリップ〜ウェーブフォールド） |
| **COMP** | RATIO、THRES |

- ノブは上下ドラッグで回す、ダブルクリックで初期値。フォーカスして矢印キーでも動く
- TEMPO などの LED 表示は −/+、ホイール、上下ドラッグで変更
- パターンは localStorage に自動保存（ノブ・ミキサーの値は保存しない）

## Ableton Live と使う

### MIDI クロック同期（Live → AB）

1. 「Audio MIDI 設定」で IAC ドライバを有効にする
2. Live の環境設定 → Link/Tempo/MIDI で IAC の出力の **Sync** をオン
3. AB の **EXT SYNC** を押して MIDI アクセスを許可
4. Live を再生すると AB が追従（Start / Stop / Continue / ソングポジション対応、テンポは自動）

ずれる場合は Live 側の **MIDI Clock Sync Delay** で調整してください。

### オーディオを DAW に録る（AB → Live）

1. [BlackHole 16ch](https://github.com/ExistentialAudio/BlackHole) を入れる（`brew install blackhole-16ch`）
2. AB の **OUTPUT** で BlackHole 16ch を選ぶ（デバイス名を出すため初回だけマイク許可を求められます。録音はしません）
3. **MULTI OUT** をオン

| ch | 中身 |
|---|---|
| 1/2 | MASTER（DELAY・マスター COMP 込み） |
| 3/4 | AB-303 #1 |
| 5/6 | AB-303 #2 |
| 7/8 | AB-808 |
| 9/10 | AB-909 |

4. Live の入力デバイスを BlackHole 16ch にし、各トラックの入力を Ext. In 3/4 … に割り当てて録音

各マシンの個別出力はフェーダーとインサート（DIST / PCF / COMP）の後。DELAY とマスター COMP は 1/2 にだけ乗ります。出力先の切り替えは Chrome / Edge のみ対応。

## ライセンス

[MIT](LICENSE)

## 免責

ReBirth RB-338 にインスパイアされた非公式のファン作品です。Reason Studios（旧 Propellerhead Software）および Roland とは関係ありません。303 / 808 / 909 は機種の系統を示すためにだけ使っています。
