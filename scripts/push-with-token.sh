#!/usr/bin/env bash
#
# Разовая публикация с Personal Access Token.
# Токен читается из переменной окружения GITHUB_TOKEN и передаётся git
# через временный credential helper — в .git/config он не остаётся.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${GITHUB_REPO:-Dvanuf/qlik_analisis}"
TOKEN="${GITHUB_TOKEN:?задайте GITHUB_TOKEN}"

cd "$REPO_DIR"

echo "1/4 Проверка токена…"
USER_JSON="$(curl -fsS -H "Authorization: Bearer ${TOKEN}" https://api.github.com/user)"
LOGIN="$(printf '%s' "$USER_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["login"])')"
echo "    авторизован как $LOGIN"

echo "2/4 Проверка/создание репозитория ${REPO}…"
CODE="$(curl -s -o /tmp/repo.json -w '%{http_code}' -H "Authorization: Bearer ${TOKEN}" \
  "https://api.github.com/repos/$REPO")"
if [ "$CODE" = "404" ]; then
  curl -fsS -X POST -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    -d '{"name":"qlik_analyzer","private":true,"description":"Анализ качества приложений Qlik Sense и QlikView: 45 правил, CLI и десктоп-приложение","auto_init":false}' \
    https://api.github.com/user/repos > /tmp/created.json
  echo "    репозиторий создан (private)"
else
  PRIVATE="$(python3 -c 'import json;print(json.load(open("/tmp/repo.json")).get("private"))')"
  echo "    репозиторий существует (private: $PRIVATE)"
fi

echo "3/4 Настройка remote и push…"
git remote set-url origin "https://github.com/$REPO.git"

HELPER="$(mktemp)"
cat > "$HELPER" <<EOF
#!/usr/bin/env bash
case "\$1" in
  get) echo "username=x-access-token"; echo "password=${TOKEN}" ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$HELPER"
cleanup() {
  rm -f "$HELPER"
  git config --local --unset-all credential.helper 2>/dev/null || true
}
trap cleanup EXIT

git config --local credential.helper "$HELPER"

git push -u origin main
git push origin --tags

echo "4/4 Готово"
