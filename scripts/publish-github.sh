#!/usr/bin/env bash
#
# Публикация проекта в GitHub-репозиторий.
#
# Токен НЕ хранится в файле и НЕ попадает в историю команд:
# он читается из переменной окружения GITHUB_TOKEN или из ~/.config/qlik-analyzer/github-token
# (права 600). В remote токен не зашивается — используется временный remote через
# credential helper, который сам удаляется после push.
#
# Использование:
#   GITHUB_TOKEN=ghp_xxx ./scripts/publish-github.sh
#   ./scripts/publish-github.sh --with-tags
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_URL="https://github.com/Dvanuf/qlik_analyzer.git"
TOKEN_FILE="${HOME}/.config/qlik-analyzer/github-token"

WITH_TAGS=0
for arg in "$@"; do
  case "$arg" in
    --with-tags) WITH_TAGS=1 ;;
    *) echo "Неизвестный аргумент: $arg" >&2; exit 1 ;;
  esac
done

cd "$REPO_DIR"

# --- токен ---
TOKEN="${GITHUB_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(cat "$TOKEN_FILE")"
fi
if [ -z "$TOKEN" ]; then
  cat >&2 <<'EOF'
Не найден токен GitHub.

Создайте Personal Access Token (classic) с правом `repo`:
  https://github.com/settings/tokens

И передайте его одним из способов:

  GITHUB_TOKEN=ghp_xxx ./scripts/publish-github.sh          # только на время команды
  echo ghp_xxx > ~/.config/qlik-analyzer/github-token        # постоянно (файл: права 600)
EOF
  exit 1
fi

# --- проверка токена ---
echo "Проверка токена…"
if ! curl -fsS -H "Authorization: Bearer $TOKEN" https://api.github.com/user \
     | grep -q '"login"'; then
  echo "Токен не принят GitHub." >&2
  exit 1
fi

# --- push через временный credential helper (токен не остаётся в .git/config) ---
HELPER_SCRIPT="$(mktemp)"
cat > "$HELPER_SCRIPT" <<EOF
#!/usr/bin/env bash
case "\$1" in
  get) echo "username=x-access-token"; echo "password=$TOKEN" ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$HELPER_SCRIPT"
cleanup() {
  rm -f "$HELPER_SCRIPT"
  git config --local --unset-all credential.helper 2>/dev/null || true
}
trap cleanup EXIT

git config --local credential.helper "$HELPER_SCRIPT"

echo "Отправка коммитов…"
git push -u origin main

if [ "$WITH_TAGS" -eq 1 ]; then
  echo "Отправка тегов…"
  git push origin --tags
fi

echo
echo "Готово: https://github.com/Dvanuf/qlik_analyzer"
echo "Все артефакты сборок остались в desktop/release/ (в git не попадают — слишком большие)."
