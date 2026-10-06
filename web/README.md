# LinkedIn MCP — портал подключения

Подпроект в этой папке использует исходное ядро из `../src`, без копии сценариев LinkedIn. Сайт служит для входа, управления пользователями и выдачи персональной конфигурации. Поиск, профили, сообщения и приглашения доступны **только через MCP**.

Пользователь получает учётную запись от администратора, входит на сайт, авторизуется в собственном браузере LinkedIn на сервере, создаёт MCP-ключ и добавляет URL + Bearer-ключ в настройки агента. Пользователю не нужно устанавливать этот проект, Node.js или Docker.

## Запуск на сервере

Подробный сценарий для Ubuntu с командами и ожидаемыми результатами: [пошаговая инструкция ниже](#пошагово-ubuntu-сервер-и-домен).

Нужны Linux x86_64, Docker Engine и Docker Compose. Образ устанавливает Google Chrome; сборка на ARM в этой конфигурации не поддерживается. Можно использовать домен либо IP, а внешний порт выбрать свободный. Без домена см. [доступ по IP](#доступ-по-ip-без-домена). У каждого Compose-проекта свои сеть и том; жёстко заданного имени контейнера нет.

Из корня всего репозитория:

```sh
cp web/.env.example web/.env
```

Измените `web/.env`:

```dotenv
WEB_PUBLIC_URL=https://linkedin.your-domain.com
WEB_ADMIN_USER=admin
WEB_ADMIN_PASSWORD=<уникальный случайный пароль от 16 символов>
WEB_EXTERNAL_PORT=3081
WEB_BIND_ADDRESS=127.0.0.1
WEB_MAX_BROWSERS=8
```

Затем:

```sh
docker compose --project-name linkedin-mcp --env-file web/.env -f web/compose.yaml up -d --build
```

На сервере будет доступен `127.0.0.1:3081`; внутренний порт — `3000`. Это позволяет разместить приложение рядом с другими контейнерами. Для второй установки задайте другой project name и внешний порт. Образ использует [браузер и зависимости Playwright](https://playwright.dev/docs/browsers).

Для доменного режима настройте существующий Nginx по [примеру](deploy/nginx.conf.example), заменив домен, порт и пути к TLS-сертификатам. `WEB_PUBLIC_URL` должен точно совпадать с адресом, который видят пользователи, включая протокол и нестандартный порт. Приложение использует корневой путь `/` домена или IP, а не подпуть `/linkedin/`.

Если Nginx тоже находится в Docker, подключите его к сети этого Compose-проекта и проксируйте на `http://linkedin-mcp:3000`. `127.0.0.1` внутри контейнера Nginx указывает на сам Nginx, а не на хост. При использовании общей внешней сети можно добавить её через собственный Compose override; публиковать дополнительный порт не требуется. Если на одной общей сети размещены несколько экземпляров, назначьте им разные сетевые aliases.

Порт HTTP приложения по умолчанию опубликован только на loopback. Снаружи доступен Nginx с HTTPS. Публичная административная панель защищена логином и паролем. MCP требует отдельный персональный ключ.

## Доступ по IP без домена

Можно выбрать один из двух режимов:

| Режим | Адрес портала | Домен и DNS | TLS |
| --- | --- | --- | --- |
| HTTPS по IP | `https://IP:8443` | Не требуются | Сертификат для IP на Nginx |
| Прямой HTTP по IP | `http://IP:3081` | Не требуются | Нет; нужен `WEB_ALLOW_HTTP_IP=true` |

`WEB_PUBLIC_URL` задаёт один основной адрес для портала и MCP. Открывайте портал по этому же адресу, включая протокол и порт: проверка Origin сравнивает запросы с ним. Персональные аккаунты, ключи и сессии LinkedIn работают в обоих режимах.

### Прямой HTTP по IP

Для HTTP пароли портала, ввод при входе в LinkedIn и MCP-ключи передаются без шифрования. Используйте этот режим в доверенной сети/VPN или для временного тестирования; для публичной работы ниже есть HTTPS по IP. Некоторые агенты разрешают удалённый MCP только по HTTPS.

Все команды этого раздела выполняются **в Bash через SSH на Ubuntu**. Docker должен быть установлен; если его нет, выполните шаг 4 основной инструкции. Для новой установки скачайте проект:

```bash
sudo apt-get update
sudo apt-get install -y git curl openssl
mkdir -p "$HOME/apps"
git clone https://github.com/RusAbk/linkedin_mcp.git "$HOME/apps/linkedin-mcp"
```

Если репозиторий уже есть, вместо `git clone` обновите его:

```bash
cd "$HOME/apps/linkedin-mcp"
git status --short
git pull --ff-only origin main
```

**1. Задайте IP и порт.** Замените `203.0.113.10` реальным адресом сервера:

```bash
SERVER_IP='203.0.113.10'
APP_PORT='3081'
APP_DIR="$HOME/apps/linkedin-mcp"
COMPOSE_PROJECT='linkedin-mcp'
cd "$APP_DIR"
sudo ss -ltnp "sport = :$APP_PORT"
```

При новой установке порт должен быть свободен. Если занят другим приложением, выберите другой `APP_PORT`. Если на нём уже работает этот же Compose-проект, его обновление использует тот же порт.

**2. Создайте начальный пароль, если конфигурации ещё нет.**

```bash
if [ ! -e web/.env ]; then
  umask 077
  ADMIN_PASSWORD="$(openssl rand -hex 24)"
  cat > web/.env <<EOF
WEB_ADMIN_USER=admin
WEB_ADMIN_PASSWORD=$ADMIN_PASSWORD
WEB_MAX_BROWSERS=8
EOF
  chmod 600 web/.env
  printf 'Логин: admin\nПароль: %s\n' "$ADMIN_PASSWORD"
  unset ADMIN_PASSWORD
fi
```

Сохраните напечатанный пароль. У существующей установки файл и пароль администратора сохраняются.

**3. Включите HTTP по IP и публикацию отдельного порта.** Функция ниже меняет только указанные настройки; пароль и остальные строки сохраняются:

```bash
set_web_setting() {
  setting_key="$1"
  setting_value="$2"
  if grep -q "^$setting_key=" web/.env; then
    sed -i "s|^$setting_key=.*|$setting_key=$setting_value|" web/.env
  else
    printf '%s=%s\n' "$setting_key" "$setting_value" >> web/.env
  fi
}
set_web_setting WEB_PUBLIC_URL "http://$SERVER_IP:$APP_PORT"
set_web_setting WEB_ALLOW_HTTP_IP true
set_web_setting WEB_BIND_ADDRESS 0.0.0.0
set_web_setting WEB_EXTERNAL_PORT "$APP_PORT"
chmod 600 web/.env
grep -E '^(WEB_PUBLIC_URL|WEB_ALLOW_HTTP_IP|WEB_BIND_ADDRESS|WEB_EXTERNAL_PORT)=' web/.env
```

Ожидается ваш IP, выбранный порт, `WEB_ALLOW_HTTP_IP=true` и `WEB_BIND_ADDRESS=0.0.0.0`. Флаг по умолчанию выключен и разрешает только буквальные IPv4/IPv6-адреса; HTTP для доменных имён этим флагом не включается.

**4. Соберите и запустите контейнер.**

```bash
sudo docker compose --project-name "$COMPOSE_PROJECT" --env-file web/.env -f web/compose.yaml up -d --build
sudo docker compose --project-name "$COMPOSE_PROJECT" --env-file web/.env -f web/compose.yaml ps
curl --fail "http://127.0.0.1:$APP_PORT/healthz"
printf '\n'
```

Ожидается `{"ok":true}`. Nginx для этого режима не нужен, а уже работающие сайты и их порты 80/443 не меняются.

**5. Разрешите внешний доступ к выбранному TCP-порту в панели хостинга.** Можно ограничить источники своей сетью/VPN. При активном UFW:

```bash
sudo ufw allow "$APP_PORT/tcp"
```

Опубликованные Docker-порты могут проходить мимо правил UFW; внешние ограничения задавайте также в firewall хостинга или правилах Docker. Подробнее — [сетевые ограничения Docker на Ubuntu](https://docs.docker.com/engine/install/ubuntu/#firewall-limitations).

Проверка с вашего компьютера, в PowerShell:

```powershell
curl.exe --fail http://203.0.113.10:3081/healthz
```

Замените IP и порт на свои. Ожидается `{"ok":true}`.

**6. Откройте портал и подключите MCP.** В браузере: `http://ВАШ_IP:ПОРТ`. После входа и авторизации в LinkedIn создайте ключ. MCP URL будет `http://ВАШ_IP:ПОРТ/mcp`.

Кнопка копирования конфигурации учитывает ограничения HTTP: если автоматическое копирование запрещено, портал покажет выделенную конфигурацию для Ctrl+C / Cmd+C. При выходе, отзыве и замене ключа это поле очищается.

Для IPv6 URL записывается со скобками, например `http://[2001:db8::10]:3081`; при публикации Docker-порта на IPv6 задайте `WEB_BIND_ADDRESS=[::]`. Адрес и IPv6-подключение хоста должны быть настроены.

### HTTPS по IP

Для обычного публичного использования можно получить доверенный сертификат без домена: [Let’s Encrypt поддерживает IP-сертификаты](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability). Они короткоживущие — примерно шесть дней, поэтому нужно автоматическое продление. Для команд ниже требуется Certbot **5.4+** с webroot-поддержкой IP: [официальный пример](https://letsencrypt.org/2026/03/11/shorter-certs-certbot).

Этот маршрут рассчитан на публичный IPv4 и Nginx на хосте. Порт приложения остаётся локальным, порт HTTPS выбирается отдельно: пример использует `8443`, чтобы сосуществовать с сайтами на 443. Для IP некоторые TLS-клиенты не отправляют SNI, поэтому отдельный свободный HTTPS-порт даёт предсказуемый выбор сертификата.

Сначала скачайте/обновите проект, установите Docker и создайте `web/.env` как в предыдущем разделе. Задайте переменные и определите `set_web_setting` из пункта 3, но HTTP-публикацию включать не требуется:

```bash
SERVER_IP='203.0.113.10'
APP_PORT='3081'
IP_HTTPS_PORT='8443'
APP_DIR="$HOME/apps/linkedin-mcp"
COMPOSE_PROJECT='linkedin-mcp'
ACME_ROOT="/var/www/$COMPOSE_PROJECT-acme"
CERT_NAME="$COMPOSE_PROJECT-ip"
cd "$APP_DIR"

set_web_setting WEB_PUBLIC_URL "https://$SERVER_IP:$IP_HTTPS_PORT"
set_web_setting WEB_ALLOW_HTTP_IP false
set_web_setting WEB_BIND_ADDRESS 127.0.0.1
set_web_setting WEB_EXTERNAL_PORT "$APP_PORT"

sudo docker compose --project-name "$COMPOSE_PROJECT" --env-file web/.env -f web/compose.yaml up -d --build
curl --fail "http://127.0.0.1:$APP_PORT/healthz"
```

Ожидается `{"ok":true}`. Установите/используйте Nginx на хосте по шагу 8 основной инструкции. В firewall хостинга разрешите TCP 80 и выбранный HTTPS-порт 8443; проверьте, что он свободен:

```bash
sudo ss -ltnp "sport = :$IP_HTTPS_PORT"
sudo install -d -m 0755 "$ACME_ROOT/.well-known/acme-challenge"
```

Добавьте **отдельный** HTTP-виртуальный хост для IP. Его ACME-путь нужен для выпуска и продления сертификата:

```bash
sudo tee "/etc/nginx/sites-available/$COMPOSE_PROJECT-ip" >/dev/null <<EOF
server {
    listen 80;
    server_name $SERVER_IP;
    location ^~ /.well-known/acme-challenge/ {
        root $ACME_ROOT;
        default_type text/plain;
    }
    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
    }
}
EOF
if [ ! -e "/etc/nginx/sites-enabled/$COMPOSE_PROJECT-ip" ] && [ ! -L "/etc/nginx/sites-enabled/$COMPOSE_PROJECT-ip" ]; then
  sudo ln -s "/etc/nginx/sites-available/$COMPOSE_PROJECT-ip" "/etc/nginx/sites-enabled/$COMPOSE_PROJECT-ip"
fi
sudo nginx -t
```

После успешной проверки:

```bash
sudo systemctl reload nginx
curl --fail "http://$SERVER_IP/healthz"
```

Для проверки извне выполните `curl.exe --fail http://ВАШ_IP/healthz` с вашего Windows-компьютера. Ожидается `{"ok":true}`.

Установите Certbot по шагу 11 основной инструкции либо используйте существующую установку. Задайте его путь и проверьте версию:

```bash
CERTBOT_BIN='/snap/bin/certbot'
"$CERTBOT_BIN" --version
```

Для другого способа установки задайте соответствующий путь. Версия должна быть не ниже 5.4. Выпустите сертификат через webroot, сохраняя Nginx и другие сайты работающими:

```bash
sudo "$CERTBOT_BIN" certonly --webroot --webroot-path "$ACME_ROOT" \
  --preferred-profile shortlived --ip-address "$SERVER_IP" --cert-name "$CERT_NAME"
```

Пройдите диалог email и условий сертификата. После успешного выпуска настройте оба виртуальных хоста в том же отдельном файле:

```bash
sudo tee "/etc/nginx/sites-available/$COMPOSE_PROJECT-ip" >/dev/null <<EOF
server {
    listen 80;
    server_name $SERVER_IP;
    location ^~ /.well-known/acme-challenge/ {
        root $ACME_ROOT;
        default_type text/plain;
    }
    location / {
        return 301 https://$SERVER_IP:$IP_HTTPS_PORT\$request_uri;
    }
}
server {
    listen $IP_HTTPS_PORT ssl;
    server_name $SERVER_IP;
    ssl_certificate /etc/letsencrypt/live/$CERT_NAME/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$CERT_NAME/privkey.pem;
    client_max_body_size 64k;
    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
EOF
sudo nginx -t
```

После успешной проверки:

```bash
sudo systemctl reload nginx
curl --fail "https://$SERVER_IP:$IP_HTTPS_PORT/healthz"
```

Ожидается `{"ok":true}` без отключения проверки TLS. Не используйте `curl -k` как решение ошибок сертификата.

Добавьте загрузку обновлённого сертификата после автоматического продления:

```bash
sudo install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
sudo tee "/etc/letsencrypt/renewal-hooks/deploy/$COMPOSE_PROJECT-nginx.sh" >/dev/null <<'EOF'
#!/bin/sh
/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx
EOF
sudo chmod 0750 "/etc/letsencrypt/renewal-hooks/deploy/$COMPOSE_PROJECT-nginx.sh"
sudo "$CERTBOT_BIN" renew --cert-name "$CERT_NAME" --dry-run --run-deploy-hooks
systemctl list-timers --all | grep -i certbot
```

Ожидается успешная проверка продления и настроенный таймер Certbot. Если таймера нет, настройте автоматическое продление по способу установки Certbot до публичного использования. Порт 80 и ACME-путь оставьте доступными для продления.

Теперь портал: `https://ВАШ_IP:8443`, MCP: `https://ВАШ_IP:8443/mcp`. DNS и домен не нужны, `WEB_ALLOW_HTTP_IP` остаётся `false`.

При смене IP получите сертификат для нового адреса и обновите `WEB_PUBLIC_URL` и Nginx. После изменения основного адреса повторите `docker compose ... up -d` и получите новую конфигурацию MCP в портале; старые конфигурации агента автоматически не меняются.


## Пошагово Ubuntu сервер и домен

Эти шаги устанавливают проект на Ubuntu Server 22.04, 24.04 или 26.04 LTS с архитектурой **amd64**. Основной маршрут использует Nginx на хосте, отдельный домен и Docker-контейнер с локальным портом. Если Nginx уже работает в контейнере, используйте отдельную ветку в конце раздела.

Выполняйте блоки последовательно. Проверка после каждого блока показывает, можно ли переходить дальше. Команды установки Docker соответствуют [официальной инструкции Docker](https://docs.docker.com/engine/install/ubuntu/), выпуск сертификата — [инструкции Certbot для Nginx](https://certbot.eff.org/instructions?ws=nginx&os=snap).

### Шаг 1 Подключиться к серверу

**Где выполнять: PowerShell на вашем Windows-компьютере.**

Замените значения в первых трёх строках. IP берётся из панели хостинга; SSH-пользователь обычно `ubuntu` или `root`.

```powershell
$ServerIp = 'ВАШ_IP_СЕРВЕРА'
$SshUser = 'ubuntu'
$SshPort = 22
ssh -p $SshPort "$SshUser@$ServerIp"
```

При использовании отдельного SSH-ключа вместо последней строки:

```powershell
ssh -i 'C:\Users\swiss\.ssh\ВАШ_КЛЮЧ' -p $SshPort "$SshUser@$ServerIp"
```

Ожидается приглашение командной строки Ubuntu, например `ubuntu@server:~$`. Следующие блоки с пометкой Bash выполняются **в этой SSH-сессии на сервере**. Команды с запросом пароля sudo используют пароль Ubuntu-пользователя.

### Шаг 2 Проверить сервер и задать свои значения

```bash
. /etc/os-release
printf '%s\n' "$PRETTY_NAME"
dpkg --print-architecture
sudo -v
```

Ожидается Ubuntu и `amd64`. Если архитектура `arm64`, текущий Dockerfile с Google Chrome не подходит — не продолжайте этот маршрут.

Замените только домен в первой строке. Указывайте его без `https://`, пути и завершающего слеша:

```bash
DOMAIN='linkedin.example.com'
APP_PORT='3081'
APP_DIR="$HOME/apps/linkedin-mcp"
COMPOSE_PROJECT='linkedin-mcp'
printf 'Домен: %s\nПорт: %s\nКаталог: %s\n' "$DOMAIN" "$APP_PORT" "$APP_DIR"
```

Проверьте напечатанные значения. Все дальнейшие команды используют эти переменные. Если закроете SSH и подключитесь снова, повторите этот блок; после установки также выполните `cd "$APP_DIR"` и определение функции `dc` из шага 7.

Для второй установки на том же сервере задайте другое значение `COMPOSE_PROJECT`, другой `APP_PORT` и другой каталог `APP_DIR`.

### Шаг 3 Привязать домен в DNS

**Где выполнять: DNS-панель регистратора или сервиса, который обслуживает DNS вашего домена.**

Для `linkedin.example.com`:

| Поле | Значение |
| --- | --- |
| Тип записи | A |
| Имя или Host | linkedin |
| Значение или Target | Публичный IPv4 этого Ubuntu-сервера |
| TTL | Оставьте стандартный |

Если используете основной домен `example.com`, имя записи обычно `@`. AAAA требуется только при рабочем IPv6 на этом же сервере. Уберите неверную AAAA для этого имени, если она указывает на другой адрес.

В панели хостинга разрешите входящие **TCP 80, TCP 443 и ваш SSH-порт**. Порт приложения 3081 не открывайте снаружи: в этой конфигурации он доступен только на `127.0.0.1`.

Вернитесь в SSH и установите служебные программы:

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates openssl dnsutils
dig +short A "$DOMAIN"
dig +short AAAA "$DOMAIN"
```

Для A ожидается IP вашего сервера. Для AAAA допустим пустой вывод, если IPv6 не используется. Если вывод неверный, исправьте DNS и повторите проверку; к выпуску сертификата переходите только после правильного ответа DNS.

### Шаг 4 Проверить или установить Docker

Сначала:

```bash
sudo docker info
sudo docker compose version
```

Если обе команды работают, Docker уже установлен: переходите к шагу 5.

**Следующий блок выполняется только на сервере без установленного Docker.** Если контейнеры других приложений уже работают, используйте существующую установку. При ошибке доступа или остановленной службе сначала проверьте `sudo systemctl status docker`.

```bash
sudo install -d -m 0755 /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' \
  "${UBUNTU_CODENAME:-$VERSION_CODENAME}" "$(dpkg --print-architecture)" \
  | sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

Проверка:

```bash
sudo docker info
sudo docker compose version
```

Ожидается информация о сервере Docker и версия Compose. Если установка сообщает конфликт с `docker.io`, `containerd` или другими пакетами, разберите конфликт по официальной инструкции Docker; не удаляйте пакеты работающей контейнерной инфраструктуры вслепую.

### Шаг 5 Скачать проект с GitHub

На сервере:

```bash
mkdir -p "$HOME/apps"
git clone https://github.com/RusAbk/linkedin_mcp.git "$APP_DIR"
cd "$APP_DIR"
git log -1 --oneline
ls package.json package-lock.json tsconfig.json src web/Dockerfile web/compose.yaml
```

Ожидается скачанный репозиторий и перечисленные файлы без ошибок. Нужен весь проект, потому что `web` импортирует ядро из `src`. Node.js и Chrome отдельно на Ubuntu-хост не устанавливаются.

Если каталог уже содержит этот репозиторий, вместо повторного клонирования:

```bash
cd "$APP_DIR"
git status --short
git pull --ff-only origin main
```

Перед `git pull` проверьте, что нет ваших несохранённых изменений. Если репозиторий недоступен без авторизации GitHub, используйте свой настроенный доступ к GitHub или перенос архива из прежней установки. Не вставляйте GitHub-токен в URL команды.

### Шаг 6 Создать конфигурацию и пароль

Проверьте, свободен ли выбранный порт:

```bash
sudo ss -ltnp "sport = :$APP_PORT"
```

Ожидается только строка заголовка без слушающего процесса. Если порт занят, задайте другой:

```bash
APP_PORT='3082'
sudo ss -ltnp "sport = :$APP_PORT"
```

Следующий блок создаёт `web/.env` и генерирует пароль **только при отсутствии файла**. Его можно вставить целиком:

```bash
cd "$APP_DIR"
if [ -e web/.env ]; then
  printf 'web/.env уже существует. Проверьте его командой nano web/.env.\n'
else
  umask 077
  ADMIN_PASSWORD="$(openssl rand -hex 24)"
  cat > web/.env <<EOF
WEB_PUBLIC_URL=https://$DOMAIN
WEB_ADMIN_USER=admin
WEB_ADMIN_PASSWORD=$ADMIN_PASSWORD
WEB_BIND_ADDRESS=127.0.0.1
WEB_EXTERNAL_PORT=$APP_PORT
WEB_MAX_BROWSERS=8
EOF
  chmod 600 web/.env
  printf 'Логин портала: admin\nПароль портала: %s\n' "$ADMIN_PASSWORD"
  unset ADMIN_PASSWORD
fi
```

Сохраните напечатанный пароль в менеджере паролей. При существующем `.env` проверьте домен и порт в редакторе:

```bash
nano web/.env
```

В nano: `Ctrl+O`, затем Enter — сохранить; `Ctrl+X` — выйти.

Проверка без вывода пароля:

```bash
grep -E '^(WEB_PUBLIC_URL|WEB_ADMIN_USER|WEB_BIND_ADDRESS|WEB_EXTERNAL_PORT|WEB_MAX_BROWSERS)=' web/.env
stat -c '%a %n' web/.env
```

Ожидается ваш HTTPS-домен, loopback-адрес, выбранный порт и права `600`. Если изменили настройки существующей установки, убедитесь, что переменные `DOMAIN` и `APP_PORT` в текущей SSH-сессии совпадают с файлом.

Пароль в `WEB_ADMIN_PASSWORD` создаёт администратора только при пустой базе. Изменение этой строки после первого запуска не сбрасывает существующий пароль.

### Шаг 7 Собрать и запустить контейнер

Определите короткую команду `dc`, чтобы во всех вызовах использовались одни и те же каталог, проект и файл конфигурации:

```bash
dc() {
  sudo docker compose \
    --project-name "$COMPOSE_PROJECT" \
    --env-file "$APP_DIR/web/.env" \
    -f "$APP_DIR/web/compose.yaml" "$@"
}
```

Проверьте Compose-конфигурацию без печати секретов:

```bash
dc config --quiet
```

Ожидается отсутствие ошибок. Затем:

```bash
dc build
dc up -d
dc ps
```

Первая сборка скачивает зависимости и Chrome. Успешная сборка завершается без ошибки; после запуска сервис `linkedin-mcp` должен иметь состояние `Up`, затем `healthy`.

Проверка HTTP внутри сервера:

```bash
curl --fail --retry 12 --retry-connrefused --retry-delay 2 "http://127.0.0.1:$APP_PORT/healthz"
printf '\n'
```

Ожидается `{"ok":true}`. Если его нет:

```bash
dc ps
dc logs --tail=100 linkedin-mcp
```

Не переходите к Nginx, пока локальная проверка не работает.

### Шаг 8 Проверить существующий Nginx

```bash
sudo ss -ltnp '( sport = :80 or sport = :443 )'
command -v nginx
sudo systemctl status nginx --no-pager
```

Если Nginx на хосте уже работает, используйте его и переходите к шагу 9.

Если Nginx отсутствует и порты 80/443 свободны:

```bash
sudo apt-get install -y nginx
sudo systemctl enable --now nginx
```

Проверка:

```bash
sudo nginx -t
sudo systemctl is-active nginx
```

Ожидается успешная проверка конфигурации и `active`. Если порты заняты контейнерным Nginx, Nginx Proxy Manager, Traefik или другим прокси, не запускайте второй сервер на этих портах: используйте ветку для существующего контейнерного прокси ниже.

### Шаг 9 Создать отдельный виртуальный хост

Проверьте, не существует ли файл для этого Compose-проекта:

```bash
sudo ls -l "/etc/nginx/sites-available/$COMPOSE_PROJECT" "/etc/nginx/sites-enabled/$COMPOSE_PROJECT"
```

При первой установке ожидается `No such file or directory`. Если файл уже есть, сначала просмотрите его: шаг ниже его заменит.

```bash
sudo cat "/etc/nginx/sites-available/$COMPOSE_PROJECT"
```

Создайте начальную HTTP-конфигурацию. Вставьте весь блок, включая завершающий `EOF`. Значения `$DOMAIN` и `$APP_PORT` подставятся автоматически; Nginx-переменные останутся в файле:

```bash
sudo tee "/etc/nginx/sites-available/$COMPOSE_PROJECT" >/dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    client_max_body_size 64k;
    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
EOF
```

Активируйте его, не заменяя чужую существующую ссылку:

```bash
if [ ! -e "/etc/nginx/sites-enabled/$COMPOSE_PROJECT" ] && [ ! -L "/etc/nginx/sites-enabled/$COMPOSE_PROJECT" ]; then
  sudo ln -s "/etc/nginx/sites-available/$COMPOSE_PROJECT" "/etc/nginx/sites-enabled/$COMPOSE_PROJECT"
fi
sudo nginx -t
```

Только если проверка успешна:

```bash
sudo systemctl reload nginx
curl --fail --header "Host: $DOMAIN" http://127.0.0.1/healthz
printf '\n'
```

Ожидается `{"ok":true}`. Другие сайты Nginx находятся в своих конфигурациях и продолжают обслуживаться.

### Шаг 10 Проверить доступ снаружи

На Ubuntu:

```bash
sudo ufw status
```

Если UFW активен, добавьте только правила для сайта:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

Если UFW неактивен, этот маршрут не включает его автоматически: включение требует учёта SSH и остальных приложений сервера. Независимо от UFW проверьте правила firewall в панели хостинга.

**Где выполнять следующую проверку: PowerShell на вашем компьютере, в отдельном окне.** Подставьте ваш домен:

```powershell
curl.exe --fail http://linkedin.example.com/healthz
```

Ожидается `{"ok":true}`. Это подтверждает доступ извне. Не вводите пароль портала по HTTP; этот адрес пока используется только для диагностики и выдачи сертификата.

Если команда не работает, проверьте A/AAAA и доступ TCP 80. К HTTPS переходите после исправления.

### Шаг 11 Выпустить HTTPS сертификат

**Где выполнять: SSH-сессия на Ubuntu.**

Проверьте, установлен ли Certbot:

```bash
command -v certbot
test -x /snap/bin/certbot && /snap/bin/certbot --version
```

Если Certbot уже используется на сервере, сохраните его установку:

```bash
CERTBOT_BIN="$(command -v certbot)"
```

Если его ещё нет, установите:

```bash
sudo apt-get install -y snapd
sudo snap install --classic certbot
CERTBOT_BIN='/snap/bin/certbot'
```

Проверка выбранного пути:

```bash
"$CERTBOT_BIN" --version
```

Ожидается версия Certbot. Выпустите сертификат для вашего домена:

```bash
sudo "$CERTBOT_BIN" --nginx -d "$DOMAIN" --redirect
```

Во время диалога введите свой email, прочитайте и подтвердите условия выдачи сертификата. Certbot добавит TLS в виртуальный хост этого домена и перенаправление HTTP → HTTPS.

Проверка:

```bash
sudo nginx -t
curl --fail "https://$DOMAIN/healthz"
printf '\n'
sudo "$CERTBOT_BIN" renew --dry-run
```

Ожидаются успешная проверка Nginx, `{"ok":true}` и успешная тестовая проверка продления сертификатов. Snap-установка Certbot запускает регулярное продление.

Если получаете `unauthorized` или `timeout`, проверьте DNS и доступ к порту 80 снаружи. Если Nginx не находит сайт, проверьте `server_name` и ссылку в `sites-enabled`.

### Шаг 12 Войти в портал и создать пользователя

**Где выполнять: браузер на вашем компьютере.**

1. Откройте `https://ваш-домен`.
2. Введите логин `admin` и пароль, сохранённый на шаге 6.
3. В разделе «Пользователи сервера» создайте логин и начальный пароль пользователя.
4. Откройте отдельное приватное окно браузера и войдите под созданным пользователем.
5. Нажмите «Войти в LinkedIn».
6. В изображении браузера на сервере нажмите нужное поле LinkedIn. Введите email в поле под изображением и нажмите «Ввести в поле». Аналогично введите пароль, затем нажмите кнопку входа в изображении.
7. При необходимости вручную пройдите 2FA или проверку LinkedIn в том же окне.
8. Нажмите «Проверить сессию». Ожидается «LinkedIn и Sales Navigator подключены».
9. Нажмите «Создать / заменить MCP-ключ» и «Скопировать конфигурацию».

Каждый пользователь выполняет авторизацию в собственном браузерном профиле. Аккаунты и журналы операций разделены. Если Sales Navigator недоступен, проверьте, есть ли у этого LinkedIn-аккаунта доступ к нему.

### Шаг 13 Проверить удалённый MCP

В SSH-сессии:

```bash
curl -i "https://$DOMAIN/mcp"
```

Ожидается **401**: запрос без персонального ключа отклоняется.

Сначала выполните **только эту строку**. После появления запроса вставьте персональный MCP-ключ из портала и нажмите Enter; ввод не отображается:

```bash
read -rsp 'Персональный MCP-ключ: ' MCP_KEY
```

После ввода ключа выполните следующий блок:

```bash
printf '\n'
printf 'Authorization: Bearer %s\n' "$MCP_KEY" | curl --fail-with-body --header @- \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json, text/event-stream' \
  --header 'MCP-Protocol-Version: 2025-06-18' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  "https://$DOMAIN/mcp"
unset MCP_KEY
```

Ожидается JSON с `result.tools` и восемью инструментами `linkedin_...`. Этот запрос не отправляет сообщения и не выполняет поиск.

Вставьте скопированную конфигурацию в MCP-настройки агента. Адрес сервера — `https://ваш-домен/mcp`; заголовок — `Authorization: Bearer <персональный ключ>`. Клиент должен поддерживать Streamable HTTP и пользовательский Bearer-заголовок. OAuth-only клиенты в этой версии не поддерживаются.

### Шаг 14 Обновление и обслуживание

В новой SSH-сессии повторите значения из шага 2 и определение `dc` из шага 7. Затем:

```bash
cd "$APP_DIR"
git status --short
git pull --ff-only origin main
dc build
dc up -d
dc ps
curl --fail "https://$DOMAIN/healthz"
```

Проверьте рабочую папку перед обновлением и не затирайте собственные изменения.

Посмотреть журналы:

```bash
dc logs --tail=100 linkedin-mcp
```

Следить за журналом до `Ctrl+C`:

```bash
dc logs -f --tail=100 linkedin-mcp
```

Остановить приложение, сохранив данные:

```bash
dc stop
```

Запустить снова:

```bash
dc up -d
```

После изменения `web/.env` используйте `dc up -d`: простой `restart` не применяет новые переменные окружения. Имя Compose-проекта сохраняйте тем же, чтобы использовался тот же том с пользователями и LinkedIn-сессиями. Не используйте `down -v` для обновления: эта команда удаляет постоянный том.

### Если Nginx уже работает в Docker

В этой ветке не устанавливайте Nginx на хосте и не выполняйте шаги 8–11 для хостового Nginx. DNS, запуск приложения и HTTPS-проверки остаются нужны.

Сначала найдите контейнер прокси:

```bash
sudo docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

Задайте его фактическое имя:

```bash
PROXY_CONTAINER='ИМЯ_ВАШЕГО_NGINX_КОНТЕЙНЕРА'
sudo docker network inspect "${COMPOSE_PROJECT}_default" --format '{{.Name}}'
sudo docker network connect "${COMPOSE_PROJECT}_default" "$PROXY_CONTAINER"
```

Ожидается существующая сеть этого приложения и успешное подключение прокси. Если прокси уже подключён к сети, повторная команда может сообщить, что endpoint уже существует; дополнительное подключение не требуется.

В конфигурации **этого контейнерного прокси** направьте нужный домен на:

```nginx
proxy_pass http://linkedin-mcp:3000;
proxy_buffering off;
proxy_read_timeout 600s;
```

В Nginx Proxy Manager аналогичные поля: Scheme `http`, Forward Hostname `linkedin-mcp`, Forward Port `3000`; домен и SSL-сертификат задайте в его панели.

Получайте сертификат тем способом, который уже используется вашим прокси. `127.0.0.1:3081` внутри контейнера прокси указывает на сам прокси, поэтому upstream здесь — `linkedin-mcp:3000`.

Подключение через `docker network connect` относится к текущему контейнеру. Чтобы оно сохранялось после его пересоздания, внесите сеть `${COMPOSE_PROJECT}_default` как внешнюю в Compose-конфигурацию существующего прокси. Например, для проекта `linkedin-mcp`:

```yaml
services:
  nginx:
    networks:
      - default
      - linkedin_mcp

networks:
  linkedin_mcp:
    external: true
    name: linkedin-mcp_default
```

Здесь `nginx` нужно заменить на имя сервиса вашего прокси и объединить запись с его существующими сетями и volumes. Приложение и прокси должны работать на одном Docker-хосте. Нескольким экземплярам LinkedIn MCP на одной общей сети назначайте разные aliases.

### Если что то не работает

| Проверка или ошибка | Действие |
| --- | --- |
| `git clone` сообщает, что каталог существует | Перейдите в каталог, проверьте `git status` и используйте `git pull --ff-only origin main`. |
| `dc config --quiet` выдаёт ошибку | Проверьте `web/.env`, наличие файлов и значения переменных из шага 2. |
| Локальный `/healthz` недоступен | Выполните `dc ps`, `dc logs --tail=100 linkedin-mcp`; проверьте, свободен ли порт. |
| Nginx даёт `502` | Проверьте локальный `/healthz` и порт в `proxy_pass`. Для контейнерного Nginx проверьте общую сеть. |
| Certbot не выдаёт сертификат | Проверьте A/AAAA, TCP 80, ответ HTTP с другого компьютера и точное совпадение домена с `server_name`. |
| Портал даёт `ORIGIN` | `WEB_PUBLIC_URL` должен совпадать с адресом браузера. После исправления выполните `dc up -d`. |
| Пароль администратора не подходит | При существующей базе используйте ранее установленный пароль; переменная bootstrap не сбрасывает его. |
| MCP даёт `401` | Проверьте Bearer-заголовок, актуальность ключа и отсутствие блокировки пользователя. |
| MCP даёт `405` при открытии в браузере с ключом | Это ожидаемо: инструменты вызываются POST-запросами. |
| Лимит активных браузеров | Закройте неиспользуемые браузеры в портале или измените `WEB_MAX_BROWSERS` с учётом ресурсов сервера. |
| Кнопка входа долго остаётся занятой | Окно сразу показывает состояние запуска. Через 60 секунд ожидание отменяется с сообщением; выполните `dc logs --since=5m --tail=100 linkedin-mcp`. Ошибка запуска Chrome содержит подробную причину в журнале. |
| После проверки LinkedIn окно перестало обновляться | Обновите код и образ командой `dc up -d --build`. Повторное открытие продолжает текущую страницу LinkedIn, не начинает проверку заново. Промежуточные переходы на `/`, `/home` и другие HTTPS-страницы LinkedIn разрешены. |

## Первое подключение

1. Администратор входит в портал с `WEB_ADMIN_USER` / `WEB_ADMIN_PASSWORD`.
2. В разделе пользователей создаёт логин и начальный пароль. Для новых аккаунтов установлен `review`.
3. Пользователь входит под своим логином и нажимает «Войти в LinkedIn».
4. В окне сайта виден **его отдельный браузер** на сервере. Нажмите на поле LinkedIn в изображении, введите текст в поле под изображением и нажмите «Ввести в поле». Так можно ввести email, пароль и код 2FA; кнопки и CAPTCHA нажимаются в изображении. Логин LinkedIn вводится непосредственно в браузер этого пользователя; приложение не сохраняет пароль LinkedIn в базе или журналах.
5. После перехода в LinkedIn портал проверит доступ к Sales Navigator. При незавершённой проверке продолжите её в том же окне.
6. Нажмите «Создать / заменить MCP-ключ» и скопируйте конфигурацию в агент. Ключ показывается один раз. Повторная генерация сразу отзывает старый ключ.

Во время интерактивного входа MCP-операции этого пользователя приостановлены, чтобы агент не менял страницу. Кнопка «Скрыть окно» завершает этот режим. Через 15 минут он также истекает. «Закрыть браузер» сохраняет cookies на диске и освобождает место под другой активный браузер; при следующем MCP-запросе браузер откроется снова.

Повторное нажатие «Войти в LinkedIn» продолжает текущую страницу входа или проверки, если браузер уже находится на LinkedIn. Промежуточные страницы после проверки остаются доступными; окно автоматически закрывается на известных страницах завершённого входа и затем проверяет Sales Navigator. Если браузер перешёл на посторонний адрес, портал сохраняет изображение и показывает актуальный URL, но запрещает ввод на этом адресе.

### Скорость окна авторизации

Окно использует поток кадров Chrome через `/api/linkedin/stream` (SSE), до пяти обновлений в секунду. Клики и ввод отправляются отдельно и последовательно, получение изображения их не задерживает. Сервер хранит последний кадр и учитывает скорость соединения; очередь устаревших изображений не накапливается. При скрытии вкладки передача приостанавливается, а при возвращении возобновляется. Выход из портала, блокировка пользователя и сброс пароля закрывают его трансляции.

Панель появляется сразу со статусом запуска. Chrome подключает поток до перехода на страницу, а запуск не ждёт первого снимка или загрузки всех скриптов LinkedIn. Первый кадр приходит асинхронно, пока страница продолжает загружаться. Подключение к Chrome и его команды имеют ограничение ожидания; ошибка запуска выводится в портале и подробно записывается в серверный журнал.

Если поток недоступен, портал автоматически переходит на получение кадров отдельными запросами. Индикатор «Прямой эфир» подтверждает потоковый режим; «Обновление изображения» означает запасной режим. В Nginx оставьте `proxy_buffering off` и `proxy_read_timeout 600s`, как в примерах проекта. CDN и другие прокси также должны пропускать SSE без буферизации.

После обновления кода обязательно соберите новый Docker-образ. На сервере с каталогом `/var/linkedin_mcp`:

```bash
cd /var/linkedin_mcp
git pull --ff-only origin main
docker compose --project-name linkedin-mcp --env-file web/.env -f web/compose.yaml up -d --build
```

Затем обновите страницу портала и войдите снова. Время загрузки самого LinkedIn и задержка сети остаются зависимыми от сервера и соединения; на небольшом сервере закрывайте неиспользуемые браузеры через портал.

## Персональная конфигурация MCP

Транспорт: **Streamable HTTP**, URL: `https://ваш-домен/mcp`, заголовок: `Authorization: Bearer <персональный ключ>`.

```json
{
  "mcpServers": {
    "linkedin": {
      "url": "https://linkedin.your-domain.com/mcp",
      "headers": {
        "Authorization": "Bearer <персональный ключ>"
      }
    }
  }
}
```

Это распространённый JSON-формат; точные названия полей зависят от MCP-клиента. Клиент должен поддерживать удалённый Streamable HTTP и пользовательский Bearer-заголовок. Клиенты, принимающие только OAuth, пока не поддерживаются: OAuth-провайдер в этой версии не реализован. Локальный мост/скачивание проекта для поддерживаемого клиента не нужны.

Endpoint работает без состояния **транспорта**: каждый запрос авторизуется заново и не требует `Mcp-Session-Id`; GET/SSE и DELETE на `/mcp` возвращают 405. Сессия LinkedIn при этом постоянная. Используется [официальный HTTP-транспорт MCP SDK](https://ts.sdk.modelcontextprotocol.io/v2/serving/http).

Доступны те же восемь инструментов, что и в исходном локальном MCP: статус worker, статус сессии, поиск людей, один/несколько профилей, сообщения, приглашения и чтение операции. Реальная отправка требует разрешённого администратором режима `execute` **и** `commit=true`. `operationId` всегда относится только к текущему пользователю. После обрыва связи проверяйте его через `linkedin_get_operation`; ядро сохраняет защиту от повторной отправки.

## Администрирование и данные

- Создание пользователей, блокировка/разблокировка, сброс пароля, отзыв ключа, переключение `review` / `execute`, закрытие браузера.
- Блокировка и сброс пароля отзывают MCP-ключ и сессии портала. Уже принятый сервером запрос может завершиться; новые будут отклонены.
- Пароли портала хранятся как scrypt-хэши с индивидуальной солью, MCP-ключи — как SHA-256-хэши. Cookies портала имеют HttpOnly/SameSite и Secure при HTTPS. Сессии портала живут 8 часов и сбрасываются при перезапуске.
- Bootstrap-пароль администратора применяется **только при пустой базе**. Изменение переменной не сбрасывает пароль существующего администратора; он может сменить пароль в портале.
- Аккаунты не удаляются через UI, чтобы случайно не потерять browser profiles и журнал операций. Блокировка закрывает доступ.
- Одновременные операции одного пользователя выполняются последовательно; другие пользователи имеют независимые браузеры и очереди. По умолчанию ограничение — восемь открытых runtimes, очередь одного пользователя — 20 вызовов. Администратор может закрывать неиспользуемые браузеры.

В постоянном Docker-томе `/data`:

```text
users.sqlite                          # пользователи и хэши
users/<uuid>/browser-profile/         # персональные cookies и профиль
users/<uuid>/operations.sqlite        # персональный журнал отправок
users/<uuid>/diagnostics/             # персональная диагностика ядра
```

Локальный профиль исходного проекта `.data/browser-profile` не используется порталом. Cookies LinkedIn и диагностические файлы содержат приватные данные: ограничьте доступ к тому и резервным копиям. Изоляция пользователей реализована на уровне приложения и каталогов; администратор хоста имеет доступ к данным на диске.

Обслуживание, из корня репозитория:

```sh
docker compose --project-name linkedin-mcp --env-file web/.env -f web/compose.yaml logs --tail=100
docker compose --project-name linkedin-mcp --env-file web/.env -f web/compose.yaml up -d --build
docker compose --project-name linkedin-mcp --env-file web/.env -f web/compose.yaml stop
```

Сохраняйте том при обновлении. Перед копированием файлов SQLite остановите приложение или используйте согласованное резервное копирование SQLite. Несколько реплик приложения с одним browser-profile не поддерживаются; эта версия предназначена для одного экземпляра сервера. При необходимости расширения нужны закрепление пользователей за workers и отдельные хранилища сессий.

## Локальная разработка

Node.js 24+ и Chrome. Зависимости общие, устанавливаются в корне проекта:

```sh
npm ci
```

Для Windows:

```powershell
Copy-Item web/.env.example web/.env
# В web/.env задайте WEB_PUBLIC_URL=http://localhost:3000 и уникальный WEB_ADMIN_PASSWORD.
npm run dev --prefix web
```

После сборки:

```sh
npm run check --prefix web
npm run test --prefix web
npm run build --prefix web
npm run start --prefix web
```

В Linux для видимого Chrome требуется дисплей: Docker уже запускает Xvfb. Для локальной разработки можно использовать `xvfb-run` либо свой графический сеанс. Проверки LinkedIn не обходятся; изменение DOM или нестандартная страница проверки может потребовать обновления адаптера/портала.

## Проверено

Автоматические проверки портала покрывают авторизацию, CSRF/origin, права администратора, блокировку, сброс пароля, постоянные хэши и отзыв ключей, маршрутизацию remote MCP, одинаковый набор инструментов, раздельные SQLite-журналы и ограничение активных браузеров. Проверки окна также покрывают приватность потока, закрытие при отзыве доступа, порядок ввода, отмену устаревших действий, отсутствие блокировки ввода кадрами и запасной режим. Они не отправляют сообщения и не авторизуются в реальном LinkedIn. Контейнер и живая авторизация должны быть проверены на целевом Linux-сервере.

Дополнительная проверка с установленным Chrome запускает локальную тестовую страницу с задержанным шрифтом и проверяет получение кадра и обновление после клика. В Linux:

```bash
WEB_BROWSER_TESTS=1 npm run test --prefix web
```

В PowerShell:

```powershell
$env:WEB_BROWSER_TESTS = '1'
npm run test --prefix web
Remove-Item Env:WEB_BROWSER_TESTS
```
