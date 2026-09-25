# occt-wasm 保守ガイド — ローカル改変の一覧と再ビルド手順

このディレクトリは upstream [andymai/occt-wasm](https://github.com/andymai/occt-wasm)
のチェックアウトに**ローカル改変を積んだ状態**で運用している。
ビルド成果物は **fork のリリース資産**として配布し、
`polyscript-ts/packages/{core,cli}/package.json` が URL で直接参照する:
`https://github.com/polygoro/occt-wasm/releases/download/v<upstream>-psN/occt-wasm-<upstream>-psN.tgz`

ブランチは **`ps-v<upstream>`**。新版に追従するときは新しいタグから
`ps-v<新版>` を切り、旧ブランチのコミットを cherry-pick して
`v<upstream>-psN` のタグでリリースする。

> **ベースは upstream v5.3.5**(2026-09-25 に v5.3.0 から追従)。**OCCT は 8.0.1**(`polygoro/OCCT` の `ps-v6-geomlib` = e1421466)。
> Python OCP と同じ 7.9.3 に揃える当初方針は 2026-09-01 に放棄した。
> 経緯は `devel/archive/occt8-impact202609.md`、v1.7.0 からの追従計画と
> 既存 fix の要不要判定は `devel/occt-wasm-upgrade202609.md`。

vendoring は 2026-09-02 に終了した。ビルド成果物は fork のリリース資産として
配布する(§3 step 5)。当時の経緯は `devel/archive/occt-wasm-vendoring.md`。
本文書は**ビルドする人のための実務ガイド**: 何を変えているか、いつ再ビルドが
必要か、検証済みの手順、ハマりどころ。

追従前の状態(upstream v1.7.0 + fix9、vendor の `1.7.0-fix9-occ801.tgz` に対応)は
ブランチ `polyscript-fix9` に凍結してある。

---

## 1. ローカル改変の一覧(upstream v5.3.0 との差分)

### 1.1 ★ 改変は codegen 経由で入れる ★

`facade/generated/{kernel,bindings,wasi_exports}.cpp` と
`crate/src/kernel_generated.rs` は `cargo xtask codegen` の生成物。
**直接編集しないこと。** 追加・修正は次の2箇所に入れる:

| 入れる場所 | 何を書くか |
|---|---|
| `xtask/src/codegen/config.rs` | `MethodSpec`。ほとんどは `MethodKind::CustomBody`(C++ の本体をそのまま文字列で書く) |
| `xtask/src/codegen/emitter.rs` | テンプレート生成される種別(`SimpleShape` / `BooleanOp` / `FilletLike`)の挙動、および生成コードが使う static ヘルパー |

加えて手書きが要るのは:

- `facade/include/occt_kernel.h` — メソッド宣言(生成対象外)
- `ts/src/raw-types.ts` — Embind の生の型
- `ts/src/index.ts` — 公開ラッパー
- `ts/src/worker.ts` — Comlink プロキシ(PolyScript は未使用だが surface を揃える)

編集後は必ず:

```bash
cargo xtask codegen && cargo fmt --all
```

これで generated/ が再生成される。upstream CI の drift check と同じ手順。

> v1.7.0 系では generated/ を直接手編集していたため「codegen を実行してはいけない」
> という運用だった。v4.3.2 追従でこれを解消した。

### 1.2 改変の一覧

| ファイル | 改変 | 理由 |
|---|---|---|
| `xtask/src/codegen/config.rs` | `fillet2D()` 追加 | 2Dワイヤの角丸。upstream に `BRepFilletAPI_MakeFillet2d` の口はない。**上流 PR 候補** |
| 〃 | `wireFirstPointTangent()` 追加 | sweep 開始点の解析的 D1 接線 |
| 〃 | `transformShapeAx3()` 追加 | sweep の座標系変換を Python OCP の経路に一致させる |
| 〃 | `wireFirstPointTangent()` 追加 | sweep 開始点の解析的 D1 接線。upstream の `curveTangent` はパラメータを要求し点を返さない。**`ReturnType::VectorDouble`(6要素)** で返している — `ReturnType` に構造体を足さずに済むため |
| 〃 | `transformShapeAx3()` 追加 | sweep の座標系変換を Python OCP の経路(`gp_Trsf::SetTransformation(gp_Ax3, gp_Ax3)`)に一致させる |
| `facade/include/occt_kernel.h` / `ts/src/{raw-types,index,worker}.ts` | 上記 3 メソッドの宣言と TS ラッパー(`worker.ts` は `fillet2D` のみ。`wireFirstPointTangent` / `transformShapeAx3` は core が同期で呼ぶ) | |
| `ts/src/views.ts` | iso の視点基底を +X−Y+Z に | upstream は +X+Y+Z で、live ビューアや一般的な CAD と X/Y が入れ替わる。**上流 PR 候補** |
| `ts/src/{png,views,font5x7}.ts`、`test/png.test.ts` | PNG 出力と、SVG と共有する投影・レイアウト | SVG と同じ視点・レイアウトで PNG を書く。サムネイル用途では SVG(数千パス)が使えない。**上流 PR 候補** |
| `occt/`(submodule) | pin `e1421466` = `polygoro/OCCT` の `ps-v6-geomlib` | upstream v5.3.5 は `wasm-patches-v6`(c7f60ff、null curve ガード)を指すが、これは `wasm-patches-v5`(a9ee3e8、GeomLib flat-deviation 高速化)の**兄弟**で、両者とも 055a9a8 から分岐している。v6 をそのまま採ると gridfinity boolean の実測 約-20% を失うため、v6 に GeomLib のコミットを cherry-pick したブランチを使う |
| `occt/`(submodule の作業ツリー) | **OCCT 本体への patch**(`patches/0001-IntPatch-*.patch`、+52/−10、2 ファイル) | らせんツールの `cut` が、ツールが面境界を横切る角度によって**無言で無切削**になる(valid・1 solid・体積不変)。原因は交線計算(IntPatch)で面境界の頂点が失われ、中点分類で面内区間ごと捨てられること。submodule は commit せず作業ツリー改変のまま `COPY occt/` で Docker に入る。クリーンな checkout に戻したら `git -C occt apply ../patches/0001-*.patch`。上流 Open-Cascade-SAS/OCCT#1543 / PR #1544。調査・検証: `../devel/occt-helix-cut-bug202609.md` |
| 〃 | **OCCT 本体への patch その2**(`patches/0002-Contap-*.patch`、+3/−2、1 ファイル) | loft など U と V の節点数が大きく違う BSpline 面で、HLR の輪郭線(シルエット)が**無言で出ない**。`Contap_HContTool::SamplePoint` が内部サンプル格子の U/V 添字を取り違え、輪郭の始点探索が継ぎ目近くの細い帯(大半は定義域外)しか見ていなかった。当て方は 0001 と同じ(`git -C occt apply ../patches/0002-*.patch`)。上流未報告(草稿あり)。調査・検証: `../devel/occt-hlr-outline-bug202609.md`、回帰テスト `test/projection-outline.test.ts` |

**`transformShapeAx3` は19スカラー**で wasmtime の16引数上限を超えるため、
codegen が「npm-only(Rust crate から到達不可)」と警告する。upstream 自身の
`sweepFull` も同じ扱いで、Embind 経路(PolyScript が使う側)には影響しない。

### 1.3 v1.7.0 系から**削除**した改変

追従で不要になったもの。復活させないこと。

| 旧 fix | なぜ不要になったか |
|---|---|
| `sf_what()` shim | OCCT 8.0 で `Standard_Failure` が `std::exception` を継承。`e.what()` が直接使える |
| `HArray1OfPnt(2d)` エイリアス | 同上。8.0 固定なら `OCC_VERSION_HEX` 分岐が要らない |
| `Dockerfile` の `crate/` レイヤ | upstream 1.7.1 (c7c3894) で取り込み済み |
| `test/bench.test.ts` の 100ms→300ms | upstream #139 / #251 / #254 で catastrophic-only 化 + ランナー速度で正規化済み |
| `getBoundingBox` を `AddOptimal` に変更 | upstream 3.0.0 (#98) が同じ変更を実施 |
| `sweepPipeShell` の binormal 引数 | upstream `sweepAdvanced` / `sweepOriented` の `SweepMode.FixedUp` が同等 |

### 1.4 v5.3.5 追従で不要になったローカル改変(2026-09-25)

upstream が我々の PR を取り込んだので削除した:

| 改変 | 取り込み先 |
|---|---|
| `offsetWire2D()` の単一辺対応 | andymai#338(我々の PR)、v5.3.1 |
| `queryBatch` / `draftPrism` の bbox を `useTriangulation=false` 明示に | andymai#337(我々の PR)、v5.3.1 |

### 1.3 v5.3.0 追従で不要になったローカル改変(2026-09-18)

upstream が取り込んだので削除した:

| 改変 | 取り込み先 |
|---|---|
| `unwrapSingletonSolid`(fillet/chamfer の Compound) | andymai#288(我々の PR) |
| `Dockerfile` の COPY 漏れ | andymai#289(我々の PR) |
| `sectionPlane()` | andymai#332(我々の PR) |
| `ts/src/svg.ts` の投影 | andymai#333(我々の PR)。**upstream 版で iso の上下逆も直った** |
| `getBoundingBoxFast()` | andymai#318 の `getBoundingBox(shape, { precise, useTriangulation })` に統合。PolyScript 側は `{ precise: false, useTriangulation: false }` に移行 |
| `test/new-features.test.ts` の `const edges` 二重宣言 | 我々の e6d2edf が持ち込んだ自前バグ。v5 追従で消滅 |

v5.3.0 で入った上流修正のうち PolyScript に効くもの: **#308 `exportStl` バイナリが Uint8Array に**
(`devel/TODO.md` に記録していた破損の修正。PolyScript は ASCII しか使っていないので破壊的変更の影響なし。
`exportSTLBuffer` の手組みを upstream に委ねられる — 未実施)、#298 `-flto` 由来のヒープ破壊解消、
#307 WASM スタック 8MB、#300/#301 fillet/chamfer の結果検証、#290 `fuseAll` の n 項 union 化、
#317 反転面の法線修正。

## 2. 再ビルドが必要になるとき

| きっかけ | 対応 |
|---|---|
| facade に API を追加・修正した | 本手順で psN+1 を作る(OCCTレイヤはキャッシュされ**約3分**) |
| upstream occt-wasm の新版に追従する | §5 |
| OCCT submodule を動かした / `patches/` の OCCT patch を変えた / CMake フラグを変えた | フルビルド(**約50分**) |
| Emscripten/emsdk を更新したい | `Dockerfile` の base image を変更 → フルビルド |

コアの `.ts` だけの変更(packages/core 側)には再ビルド不要。
facade / codegen / ts-ラッパー / OCCT に触れたときだけ必要。

## 3. 再ビルド手順

前提: docker、buildx builder `occt-builder`(無ければ `devel/archive/occt-wasm-vendoring.md` §4.1)。

```bash
cd occt-wasm

# 1) OCCT submodule が正しい状態か確認
git -C occt rev-parse HEAD      # → e1421466b33a36609383f2988da61a0b3170cc0e
git -C occt describe --tags     # → V8_0_0_rc4-166-ge1421466b3
git -C occt diff --stat         # → IntPatch 2ファイル + Contap 1ファイル(patches/0001-*, 0002-* が当たっている)

# 2) config.rs / emitter.rs / occt_kernel.h / ts を編集(§1.2 の表に追記すること)
cargo xtask codegen && cargo fmt --all

# 3) WASM 抜きで通せるゲートを先に通す(50分待ってから型エラーに気づかない)
cargo fmt --all --check && cargo clippy --all-targets -- -D warnings
cargo test -p xtask
(cd ts && npm install && npx tsgo --noEmit && npx eslint src/)

# 4) ビルド(テストゲート込み。ログは必ずファイルに落とす)
VER=5.3.5
TAG=ps1   # ← 番号を上げる
DOCKER_BUILDKIT=1 docker buildx build --builder occt-builder \
    --progress=plain -t "occt-wasm:${VER}-${TAG}" --load . \
    > /tmp/occt-build-${VER}-${TAG}.log 2>&1
echo "exit=$?"

# 5) tgz を抽出
#    Dockerfile が `cd ts && npm run build` まで済ませているので、
#    コンテナ側では version を書き換えて pack するだけでよい。
CID=$(docker create "occt-wasm:${VER}-${TAG}" bash -c "
    set -e
    cd /workspace/ts
    sed -i 's|\"version\": \"${VER}\"|\"version\": \"${VER}-${TAG}\"|' package.json
    npm pack --pack-destination /tmp/
")
docker start -a "$CID"
docker cp "$CID:/tmp/occt-wasm-${VER}-${TAG}.tgz" /tmp/
docker rm "$CID"

# 6) fork にリリース(gh を polygoro に切り替えてから: gh auth switch --user polygoro)
git push polygoro "ps-v${VER}"
git -C occt push polygoro ps-v6-geomlib   # submodule の pin 先も fork に置く
git tag -a "v${VER}-${TAG}" -m "PolyScript build: upstream v${VER} + local facade patches" "ps-v${VER}"
git push polygoro "v${VER}-${TAG}"
gh release create "v${VER}-${TAG}" --repo polygoro/occt-wasm \
    --title "v${VER}-${TAG} — PolyScript build" \
    --notes "upstream v${VER} + PolyScript facade patches。内訳は MAINTENANCE.md 1.2" \
    "/tmp/occt-wasm-${VER}-${TAG}.tgz"

# 6b) PolyScript 側の参照を差し替えてインストール
cd ../polyscript-ts
URL="https://github.com/polygoro/occt-wasm/releases/download/v${VER}-${TAG}/occt-wasm-${VER}-${TAG}.tgz"
sed -i "s|https://github.com/polygoro/occt-wasm/releases/download/[^\"]*|$URL|" \
    packages/core/package.json packages/cli/package.json
pnpm install && make build

# 7) 検証(全部やる。回帰はPythonスナップショットとのトポロジー完全一致)
make test lint fulltest
make example
make binary-test   # 出荷バイナリで26例。wasm 同梱の検査を兼ねる

# 8) 記録
#    - 本文書 1.2 の表に改変を追記
#    - 性能に関わる変更なら devel/perf.md にも
```

## 4. ハマりどころ

- **ビルドログを `| tail` で受けない。** buildx の進捗はstderrに出るため、
  tail経由だと失敗時に「exit 1」しか残らず原因が消える。
  必ず `> log 2>&1` でファイルに落とす。
- **WASM 不要のゲートを先に通す**(§3 step 3)。C++ 以外のエラーで50分を
  溶かさない。C++ のコンパイルエラーだけは Docker ビルドでしか出ない。
- **`npm install` が `ts/package-lock.json` を書き換えることがある。**
  意図しない依存解決の変化を持ち込まないよう、差分が出たら
  `git checkout <upstream-tag> -- ts/package-lock.json` で戻す。
- **`test/new-features.test.ts` の fillet 例外テストは unwrap と衝突しない。**
  あれは compound を**入力**に渡して `TopoDS::Solid` キャストを落とすテスト。
  こちらの unwrap は**出力**側にしか効かない。
- **SIMD のフラグは Dockerfile ではなく `xtask/src/build.rs` にもある。**
  Dockerfile の `CMAKE_CXX_FLAGS` は OCCT ライブラリの分だけ。facade の
  コンパイル・リンクと `wasm-opt` は build.rs のフラグを使う。v1.7.0 系で
  Dockerfile から SIMD を外していたのに成果物に `f64x2.relaxed_madd` が
  残っていたのはこれが理由(= Safari/iOS でロードできない)。
  成果物の検証は `wasm-opt` に relaxed-simd 抜きの feature set で通すのが早い。
- **`ERR StepFile ...` のログはエラーではない。** STEPの異常系テストが
  意図的に出しているもの。
- **facadeのみの変更なら約3分。** 50分かかり始めたらOCCTレイヤの
  キャッシュが外れている(submodule や CMakeフラグに触れた)。意図
  したものか確認する。

## 5. upstream 追従の手順

1. `git fetch origin --tags` して CHANGELOG の ⚠ BREAKING CHANGES を読む
2. 新タグからブランチを切り、`git -C occt checkout <wasm-patches ブランチ>`
3. §1.2 の改変が upstream に入っていないか確認(入っていれば削除。§1.3 の要領)
4. `cargo xtask codegen && cargo fmt --all` で generated/ を再生成
5. **PolyScript 側の呼び出しを全数照合する**。`packages/*/src` の `oc.*` を
   列挙し、`ts/src/index.ts` のシグネチャと突き合わせる。v1.7.0→v4.3.2 では
   `shell`(符号反転 + tolerance 追加)、`loft`(ruled 追加)、
   `getBoundingBox`(useTriangulation 追加)が該当した。
   **符号や既定値の変更は型では捕まらない**ので、実装まで読むこと。
6. §3 の手順でビルド・検証

上流に返せる汎用のバグ修正は、
upstream に PR を出す価値がある(実績: andymai/occt-wasm#288、#289)。
`sectionPlane` も同様で、こちらは**バグ修正ではなく API 追加**として出した
(2026-09-17 の ps4 で追加、PR: andymai/occt-wasm#332)。
`ts/src/svg.ts` の投影修正(ps5)も汎用のバグ修正なので PR 候補(PR: andymai/occt-wasm#333)。

**上流 PR の名義は `polygoro`**(author / committer とも
`polygoro <225675153+polygoro@users.noreply.github.com>`)。`ps` に積んだコミットは
そのままでよく、**PR を出すときに `origin/main` から切ったブランチで作り直す**
(fork 固有の改変が PR に混ざるのも同時に防げる)。このリポジトリには
`.git/config` にローカル設定を入れてあるので普通にコミットすれば合う。
push 前に `git log -1 --format='%an %cn'` で確認すること。

## 6. 関連文書

- `devel/archive/occt-wasm-vendoring.md` — 旧 vendoring 方式の記録(2026-09-02 終了)
- `devel/occt-wasm-upgrade202609.md` — v1.7.0 → v4.3.2 追従計画と判定
- `devel/archive/occt8-impact202609.md` — OCCT 8.0.1 移行の実測
- `devel/perf.md` — 性能計測と bbox の精度/速度トレードオフの背景
- `devel/occt-wasm.md` — upstream の調査メモ
