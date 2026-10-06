# LinkedIn MCP — портал подключения

Подпроект в этой папке использует исходное ядро из `../src`, без копии сценариев LinkedIn. Сайт служит для входа, управления пользователями и выдачи персональной конфигурации. Поиск, профили, сообщения и приглашения доступны **только через MCP**.

Пользователь получает учётную запись от администратора, входит на сайт, авторизуется в собственном браузере LinkedIn на сервере, создаёт MCP-ключ и добавляет URL + Bearer-ключ в настройки агента. Пользователю не нужно устанавливать этот проект, Node.js или Docker.

## Запуск на сервере

Подробный сценарий для Ubuntu, от установки Docker до HTTPS: [пошаговая инструкция ниже](#пошагово-ubuntu-сервер-и-домен).

Нужны Linux x86_64, Docker Engine и Docker Compose. Образ устанавливает Google Chrome; сборка на ARM в этой конфигурации не поддерживается. Домен и внешний порт можно выбрать любые. У каждого Compose-проекта свои сеть и том; жёстко заданного имени контейнера нет.

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

Настройте существующий Nginx по [примеру](deploy/nginx.conf.example), заменив домен, порт и пути к TLS-сертификатам. `WEB_PUBLIC_URL` должен точно совпадать с адресом, который видят пользователи, включая нестандартный HTTPS-порт. Приложение рассчитано на отдельный домен/поддомен и корневой путь `/`, а не на подпуть `/linkedin/`.

Если Nginx тоже находится в Docker, подключите его к сети этого Compose-проекта и проксируйте на `http://linkedin-mcp:3000`. `127.0.0.1` внутри контейнера Nginx указывает на сам Nginx, а не на хост. При использовании общей внешней сети можно добавить её через собственный Compose override; публиковать дополнительный порт не требуется. Если на одной общей сети размещены несколько экземпляров, назначьте им разные сетевые aliases.

Порт HTTP приложения по умолчанию опубликован только на loopback. Снаружи доступен Nginx с HTTPS. Публичная административная панель защищена логином и паролем. MCP требует отдельный персональный ключ.

## Пошагово: Ubuntu-сервер и домен

Сценарий для Ubuntu Server 22.04 / 24.04 / 26.04 LTS на **amd64**, с Nginx на хосте. Пример адреса — `linkedin.example.com`, порт приложения — `3081`. Замените домен, IP сервера и SSH-пользователя на свои значения. Если Docker или Nginx уже обслуживают другие приложения, используйте существующую установку; для этого проекта добавляется отдельный виртуальный хост.

### 1. Направить домен на сервер

В DNS-панели домена создайте запись:

| Тип | Имя | Значение |
| --- | --- | --- |
| A | linkedin | Публичный IPv4 вашего Ubuntu-сервера |

Для корневого домена вместо `linkedin` обычно используется `@`. Запись AAAA добавляйте только при настроенном IPv6 на этом же сервере. Старый AAAA, указывающий на другой сервер, может мешать выдаче сертификата.

В сетевых правилах облачного провайдера разрешите входящие TCP 80 и 443, а также ваш SSH-порт. Порт 3081 оставьте локальным: к нему обращается Nginx.

### 2. Подключиться и установить Docker

На своём компьютере:

```sh
ssh ubuntu@SERVER_IP
```

На сервере проверьте архитектуру и имеющийся Docker:

```sh
dpkg --print-architecture
sudo docker version
sudo docker compose version
```

Архитектура должна быть `amd64`. Если Docker и Compose уже работают, переходите к следующему шагу. Команды ниже предназначены для установки Docker на сервер, где его ещё нет; не переустанавливайте работающую контейнерную инфраструктуру ради этого приложения.

Установка из [официального репозитория Docker для Ubuntu](https://docs.docker.com/engine/install/ubuntu/):

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl
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
sudo docker compose version
```

Все команды Docker ниже используют `sudo`; добавление SSH-пользователя в группу Docker не требуется.

### 3. Перенести проект

Нужен **весь проект**, включая корневые `package.json`, `package-lock.json`, `tsconfig.json`, `src` и `web`. Только папки `web` недостаточно: она использует общее ядро.

На вашем Windows-компьютере, в PowerShell из папки `Linkedin`:

```powershell
tar --exclude=.git --exclude=node_modules --exclude=dist --exclude=.data --exclude=.env --exclude='.env.*' --exclude='*.log' -czf "$env:TEMP\linkedin-mcp.tar.gz" .
scp "$env:TEMP\linkedin-mcp.tar.gz" ubuntu@SERVER_IP:~/linkedin-mcp.tar.gz
```

В архив не включаются локальные сессии, пароли и установленные зависимости. На сервере:

```sh
mkdir -p ~/apps/linkedin-mcp
tar -xzf ~/linkedin-mcp.tar.gz -C ~/apps/linkedin-mcp
cd ~/apps/linkedin-mcp
```

Далее команды Compose выполняются из этой папки. Node.js и Chrome на хосте устанавливать не нужно — они находятся в контейнере.

### 4. Задать конфигурацию

Создайте файл на сервере:

```sh
umask 077
nano web/.env
```

Содержимое:

```dotenv
WEB_PUBLIC_URL=https://linkedin.example.com
WEB_ADMIN_USER=admin
WEB_ADMIN_PASSWORD=ВСТАВЬТЕ_СЛУЧАЙНЫЙ_ПАРОЛЬ
WEB_BIND_ADDRESS=127.0.0.1
WEB_EXTERNAL_PORT=3081
WEB_MAX_BROWSERS=8
```

Для пароля можно отдельно выполнить `openssl rand -hex 24` и вставить полученную строку. Сохраните пароль в своём менеджере паролей. Затем:

```sh
chmod 600 web/.env
sudo ss -ltnp 'sport = :3081'
```

Если порт 3081 занят, выберите свободный, например 3082, и используйте его и в `WEB_EXTERNAL_PORT`, и в `proxy_pass` Nginx. Пароль администратора применяется только при первом запуске с пустой базой.

### 5. Собрать и запустить приложение

```sh
sudo docker compose --project-name linkedin-mcp --env-file web/.env -f web/compose.yaml up -d --build
sudo docker compose --project-name linkedin-mcp --env-file web/.env -f web/compose.yaml ps
curl --fail http://127.0.0.1:3081/healthz
```

Ожидаемый ответ проверки: `{"ok":true}`. Первая сборка скачивает зависимости и Chrome. При ошибке:

```sh
sudo docker compose --project-name linkedin-mcp --env-file web/.env -f web/compose.yaml logs --tail=100 linkedin-mcp
```

### 6. Добавить домен в Nginx

Если Nginx ещё не установлен:

```sh
sudo apt-get install -y nginx
sudo systemctl enable --now nginx
```

Если порты 80/443 уже обслуживает Nginx в контейнере или другой прокси, добавьте домен в него по разделу выше вместо запуска второго Nginx на тех же портах.

Создайте отдельный конфигурационный файл из **HTTP-шаблона**:

```sh
sudo cp web/deploy/nginx-http.conf.example /etc/nginx/sites-available/linkedin-mcp
sudo nano /etc/nginx/sites-available/linkedin-mcp
```

В файле измените `server_name linkedin.example.com;` на свой домен и при необходимости порт в `proxy_pass`. Активируйте сайт:

```sh
sudo ln -s /etc/nginx/sites-available/linkedin-mcp /etc/nginx/sites-enabled/linkedin-mcp
sudo nginx -t
sudo systemctl reload nginx
```

Существующие сайты сохраняются: используется отдельный файл. При повторном выполнении шага уже созданную ссылку создавать снова не нужно. Начальный HTTP-шаблон позволяет запустить Nginx до получения сертификата; HTTPS-шаблон с путями к ещё не существующим сертификатам на этом этапе использовать не нужно.

Если на сервере активен UFW:

```sh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw status
```

Если собираетесь впервые включать UFW, сначала разрешите ваш фактический SSH-порт и порты всех уже работающих приложений. Здесь включение firewall не выполняется. Настройка UFW описана в [документации Ubuntu](https://ubuntu.com/server/docs/how-to/security/firewalls/).

### 7. Выпустить HTTPS-сертификат

Убедитесь, что DNS уже указывает на сервер и по HTTP отвечает ваш Nginx:

```sh
sudo apt-get install -y dnsutils
dig +short A linkedin.example.com
dig +short AAAA linkedin.example.com
curl --fail http://linkedin.example.com/healthz
```

Для новой установки Certbot используйте [официальную инструкцию Certbot для Nginx](https://certbot.eff.org/instructions?ws=nginx&os=snap):

```sh
sudo apt-get install -y snapd
sudo snap install --classic certbot
sudo /snap/bin/certbot --nginx -d linkedin.example.com --redirect
```

Certbot запросит контактный email и согласие с условиями выдачи сертификата. Он добавит HTTPS в виртуальный хост этого домена и перенаправление HTTP → HTTPS. Если Certbot уже установлен и обслуживает другие домены, используйте существующую установку: достаточно выполнить `sudo certbot --nginx -d linkedin.example.com --redirect`, без установки второй копии.

После выпуска:

```sh
sudo nginx -t
curl --fail https://linkedin.example.com/healthz
sudo /snap/bin/certbot renew --dry-run
```

Для уже установленного Certbot последнюю команду выполняйте через его обычный путь. Snap-установка настраивает регулярное продление; `--dry-run` проверяет возможность продления без замены рабочего сертификата. Для диагностики TLS также есть [инструкция Ubuntu](https://ubuntu.com/server/docs/how-to/security/obtain-tls-certificates/).

**Входите в портал только по HTTPS.** Адрес в `WEB_PUBLIC_URL` уже должен совпадать с вашим HTTPS-доменом; cookies портала рассчитаны на защищённое соединение.

### 8. Создать пользователей и подключить агента

Откройте `https://linkedin.example.com`, войдите как администратор и создайте пользователей. Каждый пользователь входит в собственную учётную запись портала, авторизуется в LinkedIn и создаёт свой ключ. Адрес MCP для всех один — `https://linkedin.example.com/mcp`; ключ определяет, чья сессия используется.

Проверка защиты без ключа:

```sh
curl -i https://linkedin.example.com/mcp
```

Ожидается **401**, а не страница с данными. Для проверки инструментов с ключом, в Bash на сервере или другом компьютере:

```sh
read -rsp 'Персональный MCP-ключ: ' MCP_KEY
printf '\n'
printf 'Authorization: Bearer %s\n' "$MCP_KEY" | curl --fail-with-body --header @- \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json, text/event-stream' \
  --header 'MCP-Protocol-Version: 2025-06-18' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  https://linkedin.example.com/mcp
unset MCP_KEY
```

Эта проверка выводит перечень восьми инструментов и не выполняет действий в LinkedIn. Затем вставьте персональную конфигурацию из портала в настройки вашего агента.

### Частые проблемы

| Симптом | Что проверить |
| --- | --- |
| `502 Bad Gateway` | Контейнер запущен; `/healthz` работает на loopback; порт в Nginx совпадает с `WEB_EXTERNAL_PORT`. |
| Certbot не выдаёт сертификат | A/AAAA указывают на этот сервер; TCP 80 доступен извне; Nginx запущен; домен указан в `server_name`. |
| `ORIGIN` при входе | `WEB_PUBLIC_URL` точно совпадает с протоколом, доменом и портом браузера. После изменения `.env` повторите `up -d`. |
| MCP отвечает `401` | Передан актуальный Bearer-ключ; пользователь не заблокирован; ключ не был заменён/отозван. |
| Открытие `/mcp` в браузере даёт `405` с ключом | Это нормально: инструменты вызываются POST-запросами Streamable HTTP. |
| Пароль из `.env` не подходит после обновления | Bootstrap не меняет пароль существующего администратора; используйте ранее установленный пароль. |
| Лимит браузеров | Закройте неиспользуемые браузеры через портал либо измените `WEB_MAX_BROWSERS` с учётом ресурсов сервера. |

Инструкция подготовлена по конфигурации проекта и официальной документации; выполнение команд на конкретном Ubuntu-сервере в этой сессии не проверялось.

## Первое подключение

1. Администратор входит в портал с `WEB_ADMIN_USER` / `WEB_ADMIN_PASSWORD`.
2. В разделе пользователей создаёт логин и начальный пароль. Для новых аккаунтов установлен `review`.
3. Пользователь входит под своим логином и нажимает «Войти в LinkedIn».
4. В окне сайта виден **его отдельный браузер** на сервере. Нажмите на поле LinkedIn в изображении, введите текст в поле под изображением и нажмите «Ввести в поле». Так можно ввести email, пароль и код 2FA; кнопки и CAPTCHA нажимаются в изображении. Логин LinkedIn вводится непосредственно в браузер этого пользователя; приложение не сохраняет пароль LinkedIn в базе или журналах.
5. После перехода в LinkedIn портал проверит доступ к Sales Navigator. При незавершённой проверке продолжите её в том же окне.
6. Нажмите «Создать / заменить MCP-ключ» и скопируйте конфигурацию в агент. Ключ показывается один раз. Повторная генерация сразу отзывает старый ключ.

Во время интерактивного входа MCP-операции этого пользователя приостановлены, чтобы агент не менял страницу. Кнопка «Скрыть окно» завершает этот режим. Через 15 минут он также истекает. «Закрыть браузер» сохраняет cookies на диске и освобождает место под другой активный браузер; при следующем MCP-запросе браузер откроется снова.

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

Автоматические проверки портала покрывают авторизацию, CSRF/origin, права администратора, блокировку, сброс пароля, постоянные хэши и отзыв ключей, маршрутизацию remote MCP, одинаковый набор инструментов, раздельные SQLite-журналы и ограничение активных браузеров. Они не отправляют сообщения и не авторизуются в реальном LinkedIn. Контейнер и живая авторизация должны быть проверены на целевом Linux-сервере.
