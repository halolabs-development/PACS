# KIN Gateway

병원 안의 DICOM 장비/PACS에서 C-STORE를 받고 KIN으로 HTTPS STOW-RS를 보내는 설치물이다.
현재 범위는 병원 → 자기 KIN 테넌트 수신뿐이며, KIN 영상을 원내로 가져오는 Import 방향은
Transfer 수신 API가 추가되는 후속 커밋 전에는 열지 않는다.

MG·DBT·XA/US 시네를 포함한 DICOM 원본을 전송한다. 큰 단일 인스턴스도 분할하지 않고
하나의 STOW part로 보내며, 전송 본문은 임시 파일에 스트리밍하여 준비한다.

CD-10: 각 STOW 요청은 로컬 Orthanc의 `RemoteAET`(실제 C-STORE association의 송신 AE)를
`X-Kin-Source-AE`에, 설정된 `KIN_CLIENT_ID`를 `X-Kin-Gateway`에,
그 `gw-<institutionId>`의 기관 ID를 `X-Kin-Institution`에 보낸다.
서로 다른 송신 AE의 객체는 별도 배치로 보내며 DICOM 원본과 multipart 형식은 유지한다.
로컬 REST 반입 등으로 송신 AE가 없으면 빈 값이다. 서버는 기관을 기존 검증 자격증명으로 판정한다.
구형 agent의 헤더 없는 요청도 수용하고 기재 주체를 `gateway (unknown source AE)`로 기록하는 것이
서버 수신 계약이다. 서버는 archive가 수락한 SOP의 환자 연결과 기재 기록을 확정한 뒤 STOW 응답을 보낸다.
기재 기록을 확인하지 못하면 503을 반환하며, 원본은 지우지 않고 기존 큐 재시도로 결과를 다시 확인한다.

## 설치

1. `.env.example`을 `.env`로 복사하고 실제 값을 채운다. `.env`와 SQLite 큐는 커밋하지 않는다.
2. Keycloak에서 `gw-<institutionId>` confidential client를 만들고 client credentials를 켠다.
   서비스 계정은 해당 기관 그룹 하나와 realm 역할 `gateway` 하나만 가져야 한다.
3. `orthanc.json`의 `DicomModalities`를 해당 병원의 실제 송신 AE Title 설정으로 바꾼다.
4. 이 디렉터리에서 `docker compose up -d --build`를 실행한다.

원내 장비는 Gateway 호스트의 `${GW_DICOM_PORT}`와 AE Title `KINGW`로 보낸다. Gateway의
로컬 REST 포트는 진단용으로 localhost에만 열리고, 클라우드로는 outbound HTTPS 443만 필요하다.
인터넷에서 병원 안으로 여는 인바운드 포트는 없다.

```bash
docker compose ps
docker compose logs -f gw-agent
docker compose exec gw-agent python /app/agent.py status
```

에이전트는 `StableStudy`를 `/changes`로 감지하고 SQLite에 큐를 먼저 남긴다. 검사마다 announce한
뒤 DICOM 인스턴스를 설정된 목표 크기로 묶어 직접 STOW한다. 목표보다 큰 객체는 단독 요청으로 보낸다. 응답의 실패 SOP만 남겨
지수 백오프로 재시도하며, 완료 조건은 로컬 SOP 집합과 성공 SOP 집합의 정확한 일치다. 같은
Study가 다시 stable이 되면 완료 큐를 재개해 늦게 온 인스턴스의 차분만 보낸다.
`status`의 `failed`는 같은 바이트로 재시도해도 성공할 수 없는 영구 실패 수다. 각 행의
`lastError`를 확인해 송신 대상과 지원 범위를 바로잡은 뒤 새 StableStudy 이벤트로 다시 연다.

announce가 성공한 검사마다 에이전트는 전송 영수증(`/api/gateway/receipt`)을 보낸다. 영수증에는
UID·단계·Gateway가 집계한 N건(보관 기간이 지나 지운 사본 포함) 중 보낸 M건·재시도 횟수·고정 오류 코드·큐 epoch·검사별 seq만 들어가고,
`lastError` 문구·시각·기관은 들어가지 않는다. `complete`는 "마지막 확인 때 들고 있던 SOP를 다 보냈다"는
뜻일 뿐 검사가 끝났다는 뜻이 아니다. 영수증 실패는 전송에 영향을 주지 않는다. SQLite 큐를 지우고 새로
만들면 새 epoch가 되고, KIN은 이미 이전 epoch로 보고된 검사의 새 epoch 영수증을 거절한다(승인된 교체
절차가 생기기 전까지). 전송은 계속되지만 그 검사들의 워크리스트 보고는 갱신되지 않으므로 큐를 지우지 않는다.

**Now Retry(S4-U4)는 `retry` 행에만 있는 요청이다.** 기사(admin 포함)가 워크리스트에서 누르면 KIN은 그 순간
저장된 `retry` 영수증의 (epoch, seq)에 묶인 요청을 남기고 감사로그에 요청자와 서버 시각을 적는다. 에이전트는
고정 30초 주기(설정·환경 변수 없음, 시작 30초 뒤 첫 조회)로 자기 epoch의 요청 UID 목록만 가져온다. 병원 쪽 포트는
여전히 열지 않는다. 적용 전에 그 행의 현재 영수증을 다시 보내 KIN이 `duplicate`라고 답할 때만 `next_at`을 0으로
당긴다. `attempt`·`lastError`·오류 코드·성공 SOP·개수·seq는 그대로라 다시 실패하면 백오프가 이어서 늘어난다.
조회는 주 루프 안에서 돌므로 전송이 진행 중이면 그 전송이 끝날 때까지 밀리고, 당겨진 행도 이미 전송을 기다리는
다른 행보다 앞서지 않는다.
화면의 `Retry Requested`는 "요청을 남겼다"는 뜻이지 재시도가 실행됐다는 뜻이 아니다. 전달은 한 번만이라고 보장하지
않으며, 요청 하나가 만드는 효과는 최대 한 번의 `next_at` 변경이다. 이 판단은 **한 에이전트 프로세스만 자기 epoch을
쓴다**는 전제에 기대므로 같은 `queue.db` 사본을 두 호스트에서 돌리지 않는다. `failed`(F-01, 같은 바이트로는 성공할
수 없음)에는 요청 컨트롤이 없고 KIN도 거절한다.

**운영 상태(하트비트).** 에이전트는 시작 직후 한 번, 그 뒤 고정 30초마다 `/api/gateway/heartbeat`로 살아 있음을
알린다. 주 루프와 따로 도는 스레드라 큰 STOW 중에도 끊기지 않는다. 본문에는 큐 epoch·실행마다 메모리에서 정하는 무작위 실행 id와 그 실행의 본문 번호(1, 2, …; 큐 파일에는 남기지 않는다)·
에이전트 버전·가동 초·큐 수(waiting = pending·announcing·sending, retry, failed — 큐를 못 읽으면 `null`이고 0이 아니다)·
마지막으로 받아들여진 STOW 뒤 경과 초·로컬 Orthanc REST API가 마지막 요청에 답했는지와 그 뒤 경과 초만 들어간다.
이 호스트의 시각·UID·기관·오류 문구는 들어가지 않고, KIN은 받은 시각에서 시작·마지막 STOW 시각을 계산한다. 하트비트는
큐를 읽기만 하고(읽기 전용 연결) 실패해도 로그만 남겨 전송·영수증에 영향을 주지 않는다. 회원 콘솔 Gateway Status의
`Refresh Gateway Status`가 기관의 Gateway 줄(Last Contact, Queue, Last STOW, Local Orthanc API, Version, Running Since)을
보이고, KIN이 180초 넘게 소식을 받지 못하면 `No Contact since <시각>`이다. KIN은 이 줄을 API 메모리에만 두므로 API가
다시 시작하면 다음 하트비트(약 30초마다)가 올 때까지 비어 있다. KIN은 서로 다른 실행의 앞뒤를 정하지 않는다(같은 실행 안에서는
더 큰 번호만 받는다): 종료한 실행이 남긴 요청이 늦게 도착하면 그 줄이 잠시 옛 실행의 값을 보이고, 살아 있는 실행의 새
하트비트가 받아지면 그 실행의 상태로 돌아온다. 그 요청의 개수·도착 기한은 보장하지 않는다. Local Orthanc API는 REST 응답 여부이지 장비가 보내는 DICOM 포트를
직접 시험한 값이 아니다.

**Gateway 설정(목적지 규칙·무손실 압축·전달된 사본의 보관 기간).** 기관 관리자가 회원 콘솔 `Gateway Rules`에서 정하고
(`PUT /api/admin/gateway-settings`, 규칙은 `api/src/gateway-settings.ts` 한 곳), 에이전트는 하트비트 스레드에서 60초마다
(시작 직후 한 번) `GET /api/gateway/settings`로 읽어 큐 옆 `settings.json`에 둔다. 큐와 설정 파일은 클라이언트 ID와 KIN 기본 주소에 묶인다.
새 큐와 라우팅 도입 전 큐는 처음 시작할 때 현재 신원에 연결되며 기존 전송을 이어간다.
소유자 없는 큐에 목적지 결정 또는 전달 기록이 있거나 설정 파일 또는 큐의 신원이 다르면
에이전트가 통신을 멈춘다. `status`의 `identityError`에서 원인을 확인하고 일치하는 큐·설정·접속 정보로 다시 시작한다.
설정을 한 번도 확인하지 못한 동안(첫 시작에 사본도 없을 때)은 받기·큐 쌓기만 하고 보내지 않는다 — 모르는 규칙은
"규칙 없음"이 아니다. KIN에 설정이 없으면 빈 설정(규칙 없음·지우지 않음·압축 없음)이고, 그것이 설정 전의 동작과 같다.

- 목적지 규칙: 규칙 한 줄은 Modality와(또는) 보낸 장비 AE Title을 조건으로, KIN과 기관의 DICOM Peers(PACS / Modality)
  가운데 하나 이상을 목적지로 정한다. 검사 안의 시리즈 Modality·인스턴스 송신 AE 가운데 하나라도 같으면 맞는다. 한 검사가
  여러 규칙에 맞으면(CT와 SR 시리즈 등) 그 규칙들의 목적지 모두로 가고(규칙 순서 없음), 맞는 규칙이 없으면 KIN으로만 간다. 검사의 목적지는 처음 처리할 때 한 번
  정한다. 늦게 도착한 영상이나 재시도는 그중 마지막으로 수신한 규칙에도 맞는 곳에만 보낸다. Peer의 등록 ID·AE·호스트·포트가 달라지거나 규칙에서 빠지면 사본을 보존하고 해당 목적지는 미전송으로 남긴다. KIN 아닌 목적지마다 큐에 따로
  줄이 있고(성공 SOP·재시도·백오프가 따로, 정할 때의 주소를 함께 둠) 로컬 Orthanc가 C-STORE로 보낸다(받는 권한 없이 보내는
  대상으로만 등록). KIN 전송이 실패하는 동안에도 다른 목적지는 계속 보낸다. 그 목적지의
  상태는 `status`의 `forwards`로 본다(KIN 영수증·기사 화면에는 KIN 전송만 나온다). KIN이 목적지가 아닌 검사는 KIN에
  announce·영수증을 보내지 않는다(`not_routed`).
- 전달된 사본의 보관 기간(`Delete Delivered Copies After`, 1–3650일, 비우면 지우지 않음 — 기본): 날 수를 정하면 에이전트가
  5분마다 한 번(한 번에 최대 10검사) 다음을 모두 만족한 검사의 로컬 인스턴스를 지운다. ① 그 검사에 정한 목적지 모두가 받았다 —
  KIN은 STOW 응답이 저장했다고 이름을 댄 SOP(00081199)이고 그 `complete` 영수증에 KIN이 `stored`/`duplicate`로 답했으며,
  KIN 아닌 목적지는 각자의 C-STORE 줄이 `complete`다. ② 마지막 목적지가 받은 때부터 그 날 수가 지났다(이 호스트의 시계).
  ③ 지우기 직전에 다시 읽은 로컬 인스턴스가 모두 ①에 든다(아직 보내지 않은 늦은 영상이 하나라도 있으면 그 검사는 그대로).
  대기·재시도·실패·영수증 거절·목적지 하나라도 미전송인 검사, 그리고 이 판 이전에 끝난 검사(KIN 저장 기록이 없음 —
  `status`의 `retention.keptWithoutRecord`)는 날 수가 지나도 지우지 않는다. 지울 인스턴스 ID를 큐에 먼저 적고 Orthanc에서
  ID로만 지우며(그 사이 도착한 영상은 남는다), 실제로 사라진 것만 센다. 지운 사본은 영수증 수(N·M·series)와 늦게 도착한 같은
  검사 영상의 라우팅(Modality·송신 AE)에 계속 들어간다. 갱신 시험 가동·복귀 중이거나, 이미지의 내장판이나 돌아갈 판이 이 기록을
  못 읽는 옛 판이면 지우지 않는다 — 보관 기간은 이 판 이상의 **이미지 교체** 뒤에 쓴다. 지운 수는 `status`의
  `retention`(`deletedStudies`·`deletedInstances`)·검사별 `purgedSops`와 원격 진단 보고 마지막 줄(`retention.totals`)에 남는다.
  이 판보다 옛 에이전트에게 KIN은 보관 기간을 보내지 않는다(그 에이전트는 지우지 않고 설정도 그대로 읽는다).
- 무손실 압축: `lossless`이면 KIN으로 보낼 때 저장 구문이 비압축인 인스턴스만 로컬 Orthanc가 JPEG Lossless(SV1)로 바꿔
  보낸다. 이미 압축된 것과 Orthanc가 바꾸지 못한 것은 받은 그대로 보내며 손실 구문으로 가는 길은 없다. 원내 PACS로는 받은
  그대로 보낸다.

## 갱신(Secure Update)

컨테이너는 `update.py run`(런처)으로 시작하고, 런처가 agent를 자식 프로세스로 돌린다. 런처는 이미지의 일부이며
갱신으로 바뀌지 않는다. agent의 새 판은 **서명된 묶음 파일 하나**(`<판>.json`: 판·파일·Ed25519 서명)다.

- **신뢰**: 묶음은 이 Gateway 호스트에 설정된 공개 키(`GW_UPDATE_KEYS`, base64, 쉼표로 여럿)로 확인될 때만 돈다.
  키는 KIN에서 오지 않는다. 키가 없으면 어떤 묶음도 깔리지 않는다(`no_update_key`). 런처는 시작할 때마다 보관한
  묶음을 다시 확인하고, 그 묶음에서 파일을 새로 풀어 돌린다 — 확인한 바이트가 도는 바이트다.
- **새 판만**: 설치(수동·원격)는 지금 도는 판보다 높은 판만 받는다(`not_newer`). 판은 숫자와 점(`2026.12.1`)이다.
- **시험 가동**: 새 판은 180초 안에 주 루프를 한 번 마치고 KIN이 그 판의 하트비트를 한 번 저장했을 때만 남는다.
  그 전에 멈추거나(`exited`) 시간이 지나면(`not_ready`) 런처가 그 판을 멈추고 **바로 앞에 돌던 판**으로 돌아간다.
  시험 중 컨테이너가 다시 시작되면 `interrupted`로 닫고 앞 판을 돌린다. 돌아간 판을 저절로 다시 시도하지 않는다.
- **바닥**: 보관한 판이 확인되지 않으면(파일이 바뀜·키가 빠짐) 앞 판, 그것도 안 되면 이미지의 `/app/agent.py`가 돈다.
- 갱신하는 동안에도 로컬 Orthanc는 계속 받고 큐(`queue.db`)는 그대로다. 다음에 도는 판이 큐를 이어서 보낸다.
  묶음으로 내는 판은 이전 판과 내장판이 그 큐와 설정 파일을 계속 읽을 수 있어야 한다(큐 구조를 바꾸는 변경은 이미지 교체로).
- 상태는 `/data/agent-releases/state.json`(현재·이전 판, 마지막 결과)이다.

**수동 설치·복귀 절차**(병원 호스트에서):

```bash
# 받은 묶음을 컨테이너의 임시 자리로 옮긴다(감시하는 incoming/ 으로 직접 복사하지 않는다)
docker compose cp kin-gateway-2026.12.1.json gw-agent:/tmp/update.json
# 서명·판을 먼저 확인하고 런처에 넘긴다(거절이면 그 자리에서 code를 보인다)
docker compose exec gw-agent python /app/update.py install /tmp/update.json
docker compose exec gw-agent python /app/update.py status     # last.result: installed / rolled_back / refused
docker compose logs --since 5m gw-agent | grep -E 'update\.|launcher\.'
# 앞 판으로 되돌리기(런처가 도는 agent까지 바꾼다)
docker compose exec gw-agent python /app/update.py rollback
```

새 Python 의존성이 필요한 변경, 런처 자체의 변경, 그리고 런처가 없던 옛 설치에 런처를 처음 들이는 일은 묶음이 아니라
**이미지 교체**다: 이 디렉터리를 새 판으로 바꾸고 `docker compose up -d --build gw-agent`. 두 볼륨(`agent-data`,
`orthanc-data`)과 로컬 Orthanc는 그대로 두며, `.env`의 `GW_UPDATE_KEYS`·`GW_REMOTE_SUPPORT`는 agent를 다시 만들 때 반영된다.
compose의 `stop_grace_period: 6m`은 agent가 진행 중인 전송 한 회를 마치고 멈추게 한다.

**릴리스 서명**(릴리스 담당자의 컴퓨터에서; 개인 키 파일은 저장소·서버·Gateway에 두지 않는다):

```bash
python gateway/agent/update.py keygen --out release.key        # 공개 키(base64)를 출력한다 → 각 Gateway의 GW_UPDATE_KEYS
python gateway/agent/update.py sign --key release.key --version 2026.12.1 --out 2026.12.1.json gateway/agent/agent.py
```

## 원격 지원(Remote Support)

기관 관리자(병원이 관리자 권한을 준 계정 — HALO 지원 인력도 병원이 준 관리자 계정으로 쓴다)는 회원 콘솔
`Gateway Support`에서 이 기관 Gateway 한 줄(큐 인스턴스)에 세 가지 중 하나를 요청한다:
`Request Diagnostics`, `Restart Gateway`, `Update Gateway`(KIN이 가진 판 하나). 요청은 감사 기록
(`gateway.support.request`)에 남는다. agent는 자기가 바깥으로 거는 연결로 약 30초마다 그 요청을 가져가 한 번만
실행한다 — **병원 안으로 여는 포트나 원격 셸은 없다**.

- 진단: agent 판, 런처 상태, 가동 시간, 비밀이 아닌 설정, 설정 판, 로컬 Orthanc 응답, `/data` 여유 바이트, 큐 수와
  KIN으로 가는 검사의 UID·단계·오류 코드(최대 200줄; 오류 문구 없음), 이번 실행의 최근 기록 200줄(시각·사건·숫자·오류
  코드만; UID 없음). 256 KiB 안에 맞춘다. 환자 이름·PatientID·비밀값·DICOM 바이트는 들어가지 않는다.
- 재시작: agent가 진행 중인 회를 마치고 끝나며(종료 코드 75), 런처가 바로 다시 띄운다. 새 실행이 `Done`을 알린다.
- 갱신: agent는 KIN에서 그 판의 묶음을 받아 통째로 런처에 넘길 뿐이고, 설치 여부는 런처가 위 규칙으로 정한다.
  결과(`Installed`·`Rolled Back`·`Refused`와 code)는 그 뒤에 도는 agent가 KIN이 받았다고 답할 때까지 알린다.
- 병원의 승인: 관리자 권한은 병원이 정하고, 병원 IT는 Gateway 호스트에서 `GW_REMOTE_SUPPORT=off`로 원격 지원을 끌 수 있다
  (그러면 모든 요청이 `Refused (remote_support_off)`로 끝나고, 위 수동 절차는 그대로 된다).
- KIN 쪽 준비: API 컨테이너에 `GATEWAY_UPDATE_DIR`(읽기 전용으로 연결한 디렉터리)를 주고, 서명된 `<판>.json`만 둔다.
  KIN은 서명을 판정하지 않는다. 요청·진단은 API 메모리에만 있어 API가 다시 시작하면 사라진다(감사 기록은 남는다).

## 검증

격리된 합성 Gateway 검증은 합성 스택 전용이며 [시험 실행 안내](../tests/README.md)의 지정된 fixture 명령을 사용한다.

로그와 큐에는 UID·SOP UID·개수·바이트 수만 남기며 환자 이름과 PatientID는 남기지 않는다.
`KIN_TLS_VERIFY=false`는 자체 서명 인증서를 쓰는 로컬 검증 전용이다. 운영에서는 신뢰할 수 있는
CA 인증서를 사용하고 기본값 `true`를 유지한다.

CD-10 수신 기록: Orthanc가 성공 SOP 목록에 포함한 재전송 객체도 Gateway 경로에서는 기재로 다시 기록합니다. 로컬 반입의 `already-present`는 새 기재를 남기지 않습니다. 이 차이는 누락이 아닌 중복 기록이며, 경로 간 정렬은 후속 관련 묶음에서 다룹니다.
