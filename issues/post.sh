#!/usr/bin/env bash
# 把 issues/<日期>/*.md 提交成 GitHub issue：查重（fp 指纹）→ 建缺的标签 → 建 issue → 正文标「已修」的顺手关。
# 用法：issues/post.sh issues/2026-09-23        （token 读 ~/Documents/SourceTree/Geek/.secrets/gh-token，不打印）
set -euo pipefail
DIR="${1:?用法: issues/post.sh <目录>}"
REPO="TestEngineerFish/umbra-design"
export GH_TOKEN="$(cat "$HOME/Documents/SourceTree/Geek/.secrets/gh-token")"
declare -A COLOR=([type:bug]=d73a4a [type:idea]=a2eeef [type:chore]=cfd3d7 [from:review]=0e8a16 [from:radar]=1d76db [from:user]=fbca04 [p0]=b60205 [p1]=e99695 [p2]=f9d0c4 [待拍板]=5319e7)
existing="$(gh api "repos/$REPO/labels?per_page=100" -q '.[].name')"
ensure_label() { grep -qx "$1" <<<"$existing" || { gh api -X POST "repos/$REPO/labels" -f name="$1" -f color="${COLOR[$1]:-ededed}" >/dev/null && existing+=$'\n'"$1"; }; }
for f in "$DIR"/*.md; do
  title="$(sed -n 's/^title: *//p' "$f" | head -1)"
  labels="$(sed -n 's/^labels: *//p' "$f" | head -1 | tr -d '[]' | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -v '^$')"
  body="$(awk 'BEGIN{n=0} /^---$/{n++; next} n>=2{print}' "$f")"
  fp="$(grep -o 'fp: [^ ]*' <<<"$body" | head -1)"
  if [ -n "$fp" ] && [ "$(gh api "search/issues?q=repo:$REPO+is:issue+%22$fp%22+in:body" -q '.total_count')" != "0" ]; then echo "跳过（已存在）: $title"; continue; fi
  args=(); while IFS= read -r l; do [ -n "$l" ] && { ensure_label "$l"; args+=(-f "labels[]=$l"); }; done <<<"$labels"
  num="$(gh api -X POST "repos/$REPO/issues" -f title="$title" -f body="$body" "${args[@]}" -q '.number')"
  echo "#$num $title"
  if grep -q '^状态：已修' <<<"$body"; then gh api -X PATCH "repos/$REPO/issues/$num" -f state=closed -f state_reason=completed >/dev/null; echo "  已关（正文标了已修）"; fi
done
