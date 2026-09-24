#!/usr/bin/env bash
# 把 issues/<日期>/*.md 提交成 GitHub issue：查重（fp 指纹）→ 建缺的标签 → 建 issue → 正文标「已修」的顺手关。
# 用法：issues/post.sh issues/2026-09-23   加 --dry-run 只看会提什么，不真提
#
# 认证：优先用 `gh auth` 自己的登录态（`gh auth status` 看；scope 里有 repo 就够建 issue）。
# 只有在 gh 没登录时才回退到 ~/Documents/SourceTree/Geek/.secrets/gh-token 那个文件。
# 2026-09-24 之前反过来了 —— 硬读那个文件，而文件里的 PAT 缺 Issues 权限，于是一直提不上去，
# 明明 gh 早就登录且权限够。**别让一条舍近求远的取值方式冒充「权限不足」。**
set -euo pipefail
DIR="${1:?用法: issues/post.sh <目录> [--dry-run]}"
DRY=""; [ "${2:-}" = "--dry-run" ] && DRY=1
REPO="TestEngineerFish/umbra-studio"
TOKEN_FILE="$HOME/Documents/SourceTree/Geek/.secrets/gh-token"
if gh auth status >/dev/null 2>&1; then
  :   # 用 gh 自己的登录态，什么都不用设
elif [ -r "$TOKEN_FILE" ]; then
  export GH_TOKEN="$(cat "$TOKEN_FILE")"
else
  echo "既没 gh auth 登录，也没有 $TOKEN_FILE —— 先跑一次 gh auth login" >&2; exit 1
fi
# 先确认真能建 issue，别跑到一半才发现权限不够
gh api "repos/$REPO" -q '.has_issues' | grep -qx true || { echo "仓库 $REPO 没开 Issues" >&2; exit 1; }
# 标签颜色。**别用关联数组** —— macOS 自带的是 bash 3.2，`declare -A` 在那儿直接崩
# （报的还是一句莫名其妙的 `type: unbound variable`，因为 [type:bug] 里的 type 被当成变量展开）。
# 这就是这个脚本一直没跑成的真正原因，跟 token 权限没关系（2026-09-24 查清）。
label_color() {
  case "$1" in
    type:bug)    echo d73a4a ;; type:idea)  echo a2eeef ;; type:chore) echo cfd3d7 ;;
    from:review) echo 0e8a16 ;; from:radar) echo 1d76db ;; from:user)  echo fbca04 ;;
    p0)          echo b60205 ;; p1)         echo e99695 ;; p2)         echo f9d0c4 ;;
    待拍板)      echo 5319e7 ;; *)          echo ededed ;;
  esac
}
existing="$(gh api "repos/$REPO/labels?per_page=100" -q '.[].name')"

# 查重：**一次**把现有 issue 的正文全拉下来，在本地比指纹。
# 原来是每条发一次 `gh api search/issues`，两个毛病：慢、撞 search API 的限速；
# 更糟的是**查重失败时会假装「已存在」** —— 实测那些请求全挂了（PROTOCOL_ERROR），
# 输出为空，而判据写的是 `!= "0"`，空串也 != "0"，于是十一条全被「跳过（已存在）」，
# 而仓库里一条 issue 都没有。查不到就要停下说话，不能默默当成「有了」（`doc/04` §2.7 同形）。
all_bodies="$(gh issue list -R "$REPO" --state all --limit 300 --json body -q '.[].body' 2>/dev/null)" || {
  echo "拉不到现有 issue 列表，没法查重 —— 先看 gh auth status / 网络，别盲提" >&2; exit 1; }
ensure_label() { grep -qx "$1" <<<"$existing" || { gh api -X POST "repos/$REPO/labels" -f name="$1" -f color="$(label_color "$1")" >/dev/null && existing="$existing
$1"; }; }
for f in "$DIR"/*.md; do
  title="$(sed -n 's/^title: *//p' "$f" | head -1)"
  labels="$(sed -n 's/^labels: *//p' "$f" | head -1 | tr -d '[]' | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -v '^$')"
  body="$(awk 'BEGIN{n=0} /^---$/{n++; next} n>=2{print}' "$f")"
  fp="$(grep -o 'fp: [^ ]*' <<<"$body" | head -1)"
  if [ -n "$fp" ] && grep -qF "$fp" <<<"$all_bodies"; then echo "跳过（已存在）: $title"; continue; fi
  if [ -n "$DRY" ]; then echo "会提: $title  [${labels//$'\n'/, }]"; continue; fi
  args=(); while IFS= read -r l; do [ -n "$l" ] && { ensure_label "$l"; args+=(-f "labels[]=$l"); }; done <<<"$labels"
  num="$(gh api -X POST "repos/$REPO/issues" -f title="$title" -f body="$body" "${args[@]}" -q '.number')"
  echo "#$num $title"
  if grep -q '^状态：已修' <<<"$body"; then gh api -X PATCH "repos/$REPO/issues/$num" -f state=closed -f state_reason=completed >/dev/null; echo "  已关（正文标了已修）"; fi
done
