# occt-wasm 保守ガイド — ローカル改変の一覧と再ビルド手順

このディレクトリは upstream [andymai/occt-wasm](https://github.com/andymai/occt-wasm)
**v4.3.2** のチェックアウトに**ローカル改変を積んだ状態**で運用している。
ビルド成果物は **fork のリリース資産**として配布し、
`typescript/packages/{core,cli}/package.json` が URL で直接参照する:
`https://github.com/polygoro/occt-wasm/releases/download/v4.3.2-psN/occt-wasm-4.3.2-psN.tgz`

パッチを積んだブランチは **`ps`**。upstream の新版に追従するときもこのブランチを
rebase し、`v<upstream>-psN` のタグでリリースする。

> **OCCT は 8.0.1**(andymai fork の `wasm-patches-v5` = a9ee3e8)。
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

## 1. ローカル改変の一覧(upstream v4.3.2 との差分)

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
| `xtask/src/codegen/emitter.rs` | `unwrapSingletonSolid()` ヘルパーの生成 + `FilletLike` が `store(unwrapSingletonSolid(maker.Shape()))` を吐くよう変更 | `BRepFilletAPI_MakeFillet/MakeChamfer::Shape()` は単一 solid 入力でも Compound を返す。次の `TopoDS::Solid(...)` キャストが `Standard_TypeMismatch` で落ち、連鎖 fillet/chamfer が WASM trap になる。**upstream 未修正**(v4.3.2 でも `store(maker.Shape())` のまま) |
| `xtask/src/codegen/config.rs` | 同じ unwrap を `CustomBody` 側5件にも適用: `chamferDistAngle` / `filletVariable` / `filletBatch` / `filletWithHistory` / `chamferWithHistory` | 上と同じ。`FilletLike` は `fillet` / `chamfer` の2件のみ |
| 〃 | `fillet2D()` 追加 | 2Dワイヤの角丸(PolyScript の 2D fillet)。upstream に `BRepFilletAPI_MakeFillet2d` の口はない |
| 〃 | `wireFirstPointTangent()` 追加 | sweep 開始点の解析的 D1 接線。upstream の `curveTangent` はパラメータを要求し点を返さない。**`ReturnType::VectorDouble`(6要素)** で返している — `ReturnType` に構造体を足さずに済むため |
| 〃 | `transformShapeAx3()` 追加 | sweep の座標系変換を Python OCP の経路(`gp_Trsf::SetTransformation(gp_Ax3, gp_Ax3)`)に一致させる |
| 〃 | `getBoundingBoxFast()` 追加 | `BRepBndLib::Add`(制御点ハル)版 bbox。upstream の `getBoundingBox` は 3.0.0 以降つねに `AddOptimal`。faceCenter / 貫通ツール長で厳密版の15倍高速。`devel/perf.md` 参照 |
| 〃 | `getBoundingBoxFast()` を `BRepBndLib::Add(shape, box, Standard_False)` に(**ps2**, 2026-09-05) | `useTriangulation` 既定 true だと、`tessellate()` が形状に書き込んだ三角形からの bbox を返す。同じ面の中心がプレビュー前後で最大 0.06 動き、セレクタの選択とカーネル呼び出しのメモ化(引数キー)がプレビューのたびに壊れていた(07_keyboard_case: 同一ソース再ビルド 72/72 → 41/72)。`devel/perf.md` 2026-09-05 参照 |
| 〃 | `sectionPlane()` 追加(**ps4**, 2026-09-17) | `BRepAlgoAPI_Section` の平面オーバーロード。upstream の `section(a, b)` はツール側も shape なので、平面で切るには対象を覆う大きさの面を bbox から算出して作る必要があり、小さいと**無言で部分的な断面**になる。`gp_Pln` は無限平面なのでサイズ計算が不要。`Approximation` は既定(off)のままなので解析幾何が保たれ、円柱の断面は半径が厳密な円エッジ1本で返る(メッシュ断面は r=20 で面積 −0.32%、直径 −0.05mm)。テストは `test/facade-cad-features.test.ts`。**upstream に PR を出す前提の追加**(`devel/` の検討記録: 2026-09-17) |
| `ts/src/svg.ts` | 投影を画面座標に落とす式の修正(**ps5**, 2026-09-17) | `projectEdges` はHLRの結果を**ビュー平面**(xはxAxis方向、yはgp_Ax2の縦、zは常に0)で返すのに、レンダラがワールド基底との内積を取り直していた。screen-upがXY平面内のワールド軸でないビューがすべて潰れる: front/back/left/right は線1本、iso はせん断、正しかったのは top/bottom だけ。テストは構造(ラベル・破線・NaN無し)しか見ていなかったので通っていた。`test/svg.test.ts` に全ビューの二軸方向の広がりとアスペクト比の検査を追加。**upstream に PR を出す前提** |
| `facade/include/occt_kernel.h` | 上記5メソッドの宣言 | |
| `ts/src/raw-types.ts` / `index.ts` / `worker.ts` | 上記5メソッドの TS ラッパー(`worker.ts` は `sectionPlane` / `fillet2D` / `getBoundingBoxFast` のみ。`halfSpace` / `wireFirstPointTangent` / `transformShapeAx3` は未追加) | |
| `Dockerfile` | 高価なレイヤの後ろに `COPY README.md ./` / `COPY examples/` / `COPY benchmarks/` を追加 | standalone Dockerfile がこれらを入れないため `test/static-server.test.ts` が2件落ち、`ts` の `prepack`(`cp ../README.md README.md`)も失敗する。upstream に出せる修正 |
| `occt/`(submodule の作業ツリー) | **OCCT 本体への patch**(**ps3**, 2026-09-16): `IntPatch_ImpPrmIntersection::Perform` でシーム分割後の walking line 片に制限頂点を再付与、`IntPatch_RstInt::PutVertexOnLine` の閉曲面 2D 比較を周期を法とした差に | らせんツールの `cut` が、ツールが面境界を横切る角度によって**無言で無切削**になる(valid・1 solid・体積不変)。原因は交線計算(IntPatch)で面境界の頂点が失われ、中点分類で面内区間ごと捨てられること。patch 本体は `patches/0001-IntPatch-*.patch`(+52/−10、2 ファイル)。submodule は commit せず作業ツリー改変のまま `COPY occt/` で Docker に入る。クリーンな checkout に戻したら `git -C occt apply ../patches/0001-*.patch`。調査・検証・上流報告草稿: `../devel/occt-helix-cut-bug202609.md` |
| `test/new-features.test.ts` | 「単一辺の開 wire の offset」テスト内で `const edges` が二重宣言されていたのを `resultEdges` に | esbuild の parse error で `cd ts && npx vitest run` のゲートが落ち、Docker ビルド全体が失敗していた(e6d2edf で入り、ps2 のビルド後だったので気づかれなかった) |
| `occt/`(submodule) | `origin/wasm-patches-v5`(a9ee3e8) | OCCT 8.0.1 + WASM例外互換パッチ + GeomLib flat-deviation fast path。upstream main の pin(055a9a8)より**1コミット先行**しており、この1コミットが gridfinity boolean 約-20%を担う |

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
git -C occt rev-parse HEAD      # → a9ee3e80c57f77665147896d3b22a09c05fec6c5
git -C occt describe --tags     # → V8_0_0_rc4-165-ga9ee3e80c5

# 2) config.rs / emitter.rs / occt_kernel.h / ts を編集(§1.2 の表に追記すること)
cargo xtask codegen && cargo fmt --all

# 3) WASM 抜きで通せるゲートを先に通す(50分待ってから型エラーに気づかない)
cargo fmt --all --check && cargo clippy --all-targets -- -D warnings
cargo test -p xtask
(cd ts && npm install && npx tsgo --noEmit && npx eslint src/)

# 4) ビルド(テストゲート込み。ログは必ずファイルに落とす)
TAG=ps2   # ← 番号を上げる
DOCKER_BUILDKIT=1 docker buildx build --builder occt-builder \
    --progress=plain -t "occt-wasm:4.3.2-${TAG}" --load . \
    > /tmp/occt-build-${TAG}.log 2>&1
echo "exit=$?"

# 5) tgz を抽出
#    Dockerfile が `cd ts && npm run build` まで済ませているので、
#    コンテナ側では version を書き換えて pack するだけでよい。
CID=$(docker create "occt-wasm:4.3.2-${TAG}" bash -c "
    set -e
    cd /workspace/ts
    sed -i 's|\"version\": \"4.3.2\"|\"version\": \"4.3.2-${TAG}\"|' package.json
    npm pack --pack-destination /tmp/
")
docker start -a "$CID"
docker cp "$CID:/tmp/occt-wasm-4.3.2-${TAG}.tgz" /tmp/
docker rm "$CID"

# 6) fork にリリース(gh を polygoro に切り替えてから: gh auth switch --user polygoro)
git push polygoro ps
git tag -a "v4.3.2-${TAG}" -m "PolyScript build: upstream v4.3.2 + local facade patches" ps
git push polygoro "v4.3.2-${TAG}"
gh release create "v4.3.2-${TAG}" --repo polygoro/occt-wasm \
    --title "v4.3.2-${TAG} — PolyScript build" \
    --notes "upstream v4.3.2 + PolyScript facade patches。内訳は MAINTENANCE.md 1.2" \
    "/tmp/occt-wasm-4.3.2-${TAG}.tgz"

# 6b) PolyScript 側の参照を差し替えてインストール
cd ../typescript
URL="https://github.com/polygoro/occt-wasm/releases/download/v4.3.2-${TAG}/occt-wasm-4.3.2-${TAG}.tgz"
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

`unwrapSingletonSolid` は他ユーザーにも有益な汎用のバグ修正なので、
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
- `devel/perf.md` — 性能計測と `getBoundingBoxFast` 等の背景
- `devel/occt-wasm.md` — upstream の調査メモ
