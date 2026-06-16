# stream-radio

터미널에서 실행하는 스트리밍 오디오 플레이어 MVP입니다.
내부적으로는 Electron의 숨겨진 `BrowserWindow`를 플레이어 엔진으로 사용합니다.

현재는 CHZZK 라이브 페이지를 지원합니다.

## 요구사항

- Node.js 22.12+
- npm

## 설치/실행

```bash
npm install
npm link
```

`npm install` 중 Electron 바이너리 다운로드가 진행될 수 있습니다.
`npm link` 후 `stream-radio` 명령어를 사용할 수 있습니다.

링크 없이 테스트하려면:

```bash
node ./bin/stream-radio.js --help
```

최초 1회 로그인:

```bash
stream-radio login
```

로그인 명령은 `https://nid.naver.com/nidlogin.login?url=...`을 열고,
CHZZK로 redirect가 감지되면 자동 종료합니다.
쿠키/네비게이션 흐름 확인:

```bash
stream-radio login --debug --stay-open
```

재생:

```bash
stream-radio play <channelId>
stream-radio play https://chzzk.naver.com/live/<channelId>
```

재생 중 페이지가 호출하는 CHZZK `live-status` 응답을 감지하면 방제를 출력합니다.

종료:

```text
Ctrl+C
```

## 옵션

```bash
stream-radio play <channelId> --visible
stream-radio play <channelId> --debug
stream-radio play <channelId> --profile ~/.stream-radio/dev-profile
```

- `login`: 브라우저 창을 보여주고 세션을 저장합니다.
- `play`: 기본값은 hidden window입니다.
- `--visible`: 재생 중 브라우저 창을 보여줍니다. 디버깅용입니다.
- `--profile`: 로그인 세션 저장 위치를 바꿉니다.

기본 프로필 위치:

```text
~/.stream-radio/electron-profile
```

깨끗한 로그인 플로우를 테스트하려면 기존 프로필을 지우기보다 임시 프로필을 쓰는 편이 안전합니다.

```bash
rm -rf /tmp/stream-radio-test-profile
stream-radio login --profile /tmp/stream-radio-test-profile --debug --stay-open
```

## 구조

```text
stream-radio
├─ bin/stream-radio.js       # 터미널 CLI wrapper
├─ src/electron-main.js     # hidden Electron player
└─ package.json
```
