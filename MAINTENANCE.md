# occt-wasm 保守ガイド — ローカル改変の一覧と再ビルド手順

このディレクトリは upstream [andymai/occt-wasm](https://github.com/andymai/occt-wasm)
**v4.3.2** のチェックアウトに**ローカル改変を積んだ状態**で運用している。
ビルド成果物は `typescript/vendor/occt-wasm-4.3.2-psN.tgz` として同梱し、
`typescript/packages/core/package.json` が参照する。

> **OCCT は 8.0.1**(andymai fork の `wasm-patches-v5` = a9ee3e8)。
> Python OCP と同じ 7.9.3 に揃える当初方針は 2026-09-01 に放棄した。
> 経緯は `devel/occt8-impact202609.md`、v1.7.0 からの追従計画と
> 既存 fix の要不要判定は `devel/occt-wasm-upgrade202609.md`。

vendoring の経緯は `typescript/vendor/README.md` が正典。
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
| 〃 | `getBoundingBoxFast()` 追加 | `BRepBndLib::Add`(制御点ハル)版 bbox。upstream の `getBoundingBox` は 3.0.0 以降つねに `AddOptimal`。faceCenter / 貫通工具長で厳密版の15倍高速。`devel/perf.md` 参照 |
| `facade/include/occt_kernel.h` | 上記4メソッドの宣言 | |
| `ts/src/raw-types.ts` / `index.ts` / `worker.ts` | 上記4メソッドの TS ラッパー | |
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
| OCCT submodule を動かした / CMake フラグを変えた | フルビルド(**約50分**) |
| Emscripten/emsdk を更新したい | `Dockerfile` の base image を変更 → フルビルド |

コアの `.ts` だけの変更(packages/core 側)には再ビルド不要。
facade / codegen / ts-ラッパー / OCCT に触れたときだけ必要。

## 3. 再ビルド手順

前提: docker、buildx builder `occt-builder`(無ければ vendor/README.md §4.1)。

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

# 5) tgz を抽出して vendor へ
#    Dockerfile が `cd ts && npm run build` まで済ませているので、
#    コンテナ側では version を書き換えて pack するだけでよい。
CID=$(docker create "occt-wasm:4.3.2-${TAG}" bash -c "
    set -e
    cd /workspace/ts
    sed -i 's|\"version\": \"4.3.2\"|\"version\": \"4.3.2-${TAG}\"|' package.json
    npm pack --pack-destination /tmp/
")
docker start -a "$CID"
docker cp "$CID:/tmp/occt-wasm-4.3.2-${TAG}.tgz" ../typescript/vendor/
docker rm "$CID"

# 6) 切り替えとインストール
cd ../typescript
sed -i "s|occt-wasm-4.3.2-ps[0-9]*.tgz|occt-wasm-4.3.2-${TAG}.tgz|" \
    packages/core/package.json
pnpm install && make build

# 7) 検証(全部やる。回帰はPythonスナップショットとのトポロジー完全一致)
make test lint
(cd packages/core && EXAMPLE=1 npx vitest run test/regression.test.ts)
make example

# 8) 記録
#    - typescript/vendor/README.md §3 の表に psN を追記
#    - 本文書 §1.2 の表に改変を追記
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
upstream に PR を出す価値がある(`typescript/vendor/README.md` §7)。

## 6. 関連文書

- `typescript/vendor/README.md` — vendoring の正典(経緯、ロールバック)
- `devel/occt-wasm-upgrade202609.md` — v1.7.0 → v4.3.2 追従計画と判定
- `devel/occt8-impact202609.md` — OCCT 8.0.1 移行の実測
- `devel/perf.md` — 性能計測と `getBoundingBoxFast` 等の背景
- `devel/occt-wasm.md` — upstream の調査メモ
