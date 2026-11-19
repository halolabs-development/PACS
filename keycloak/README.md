# Keycloak 렐름 (개발용)

첫 기관의 기본 회원 생성은 관리자가 대면 확인 후 기관·역할을 지정하는 방식이다. `verifyEmail`은 기본 false이며 병원에서 이메일 검증을 선택하면 렐름에서 켤 수 있다. 이메일 미검증 자체는 회원 승인을 막지 않는다. 사용자는 업무 화면의 **Change Password**에서 Keycloak의 `UPDATE_PASSWORD` 동작만 열어 비밀번호를 직접 변경한다. 계정 콘솔은 열지 않으며 이메일·이름 등 감사 식별 정보는 관리자가 변경한다. 기존 설치는 API와 nginx·업무 화면을 함께 갱신한다(렐름 재import 불필요). [Keycloak AIA](https://www.keycloak.org/docs/26.7.0/server_admin/#_application_initiated_actions) 경로는 완료·취소·실패를 그 탭에 한국어로 알리고(`kc_action_status`), 새 제품 세션을 만들지 않으며 업무 화면의 세션은 그대로 둔다. 계정별 실패 잠금과 유휴 종료 설정은 유지한다.

기존 렐름은 import 파일 변경으로 갱신되지 않는다. 기존 설치의 선택적 이메일 검증은 Keycloak 관리 콘솔 Realm settings에서 적용하며 SMTP는 이메일 검증·메일 재설정을 선택할 때만 필요하다.

## 접속기록 신원은 관리자만 바꾼다 (의료법 제23조④ 접속기록)

API는 토큰의 `email`을 접속기록·판독·질의의 actor로, `firstName`·`lastName`을 표시 이름으로 쓴다. 가입한 뒤의 사용자가 이 값을
스스로 바꾸면 같은 사람의 기록이 본인이 고른 신원으로 남는다. Keycloak에서 로그인한 사용자가 프로필을 고치는 길은 셋이다:
계정 콘솔·계정 REST(`/realms/kin/account…`, nginx가 404로 닫는다), 주소에 `kc_action=UPDATE_PROFILE`을 붙인 필수 동작,
프로필이 불완전할 때 뜨는 `VERIFY_PROFILE`. 그래서 렐름은 `UPDATE_PROFILE`·`VERIFY_PROFILE` 필수 동작을 **끈다**
(`kin-realm.json`의 `requiredActions`). `verifyEmail=false`(이메일 확인이 실패 장벽이던 이전 설정이 빠졌다)인 지금은 이것이
본인 변경을 막는 자리다. 이메일·이름 변경은 회원 관리(Admin API)로만 한다.

user profile의 `email`·`firstName`·`lastName`을 관리자 전용 편집(`edit: [admin]`)으로 바꾸는 방법은 쓰지 않는다:
26.7.3에서 가입(REGISTRATION)도 사용자 문맥이라, 그 설정은 가입 폼에서 이메일·이름을 빼고 actor가 될 이메일 없이 계정을
만든다. 필수 동작을 끄는 것은 가입 폼에 영향이 없다(`tests/e2e/test_caution_app.py`가 가입 입력과 본인 변경 거절을 함께 확인).

`requiredActions`를 렐름 파일에 적으면 Keycloak은 기본 목록을 넣지 않고 적힌 것만 만든다(`delete_account`만 따로 더한다).
그래서 파일에는 26.7.3의 기본 목록을 두고 위 둘만 `enabled:false`로 둔다. 기본에서도 꺼진 `UPDATE_EMAIL`(이메일 변경 동작)은
넣지 않아 미등록으로 남는다 — 쓸 수 없다는 점은 같다. Keycloak을 올릴 때는 새 기본 동작이 빠지지 않았는지 관리 콘솔
Authentication → Required actions(또는 `GET /admin/realms/kin/authentication/unregistered-required-actions`, 지금은
`UPDATE_EMAIL` 하나만 나온다)로 확인한다.

**기존 설치(import가 적용되지 않는다):** 관리 콘솔 → `kin` 렐름 → Authentication → Required actions에서
`Update Profile`과 `Verify Profile`의 Enabled를 끈다. Admin REST로는 각 동작을
`GET /admin/realms/kin/authentication/required-actions/{UPDATE_PROFILE|VERIFY_PROFILE}`로 읽어 `enabled:false`로 `PUT`한다.
렐름 재import·사용자 변경은 필요 없다. 끈 뒤 로그인한 시험 계정으로 `kc_action=UPDATE_PROFILE` 주소를 열어 이메일이 바뀌지
않는지 확인한다.

`kin-realm.json`은 빈 Keycloak PostgreSQL DB를 처음 띄울 때만 들어간다
(`start-dev --import-realm`, 운영은 `start --import-realm`; 둘 다 아래 세션 캐시 옵션을 함께 준다).
이후 렐름·계정·회전된 자격증명은 PostgreSQL에 유지된다.
서버는 `26.7.3`으로 고정한다. `prompt=create` 가입 진입은 26.1.0부터 지원되므로
그보다 낮은 버전으로 내리면 BFF 가입 링크가 로그인 화면으로 잘못 열린다.

> ⚠️ **이 파일의 JSON에는 주석을 넣을 수 없다.** Keycloak은 모르는 필드를 만나면
> import 자체를 거부하고 서버가 뜨지 않는다 (`Unrecognized field ... not marked as ignorable`).
> 설명은 전부 이 README에 쓴다.

## 관리자 OTP 필수 (`admin` 역할)

realm 역할 `admin`(회원·기관·역할 관리, 감사·접속기록 점검)을 가진 계정은 OTP(TOTP) 없이 브라우저 로그인을 끝내지 못한다.
OTP가 없는 관리자는 다음 로그인에서 비밀번호 뒤에 OTP 등록 화면(`CONFIGURE_TOTP`)을 먼저 지난다. 그 밖의 계정(판독의·
방사선사·임상의)은 기본 흐름 그대로다 — 스스로 OTP를 등록한 계정만 지금처럼 OTP를 묻는다. 역할은 그룹·복합 역할로 받은
것도 센다(26.7.3 `ConditionalRoleAuthenticator`의 `hasRole`).

렐름 파일의 `browserFlow`=`kin browser`, `resetCredentialsFlow`=`kin reset credentials`가 그것이다. 둘 다 Keycloak 기본 흐름
(`browser`, `reset credentials`)을 복사한 것에 두 가지만 덧붙인다:

- 끝에 CONDITIONAL 하위 흐름 `kin browser administrator otp`(`kin browser forms` 안) / `kin reset administrator otp`
  (`kin reset credentials` 안): `Condition - user role`(`admin`) + `OTP Form` REQUIRED. OTP가 없는 사용자에게 REQUIRED
  OTP Form은 `CONFIGURE_TOTP` 동작을 건다.
- 기본 조건부 OTP 하위 흐름(`kin browser Browser - Conditional 2FA`, `kin reset credentials Reset - Conditional OTP`)
  끝에 `Condition - user role`(`admin`, **Negate output**). 이것이 없으면 OTP가 있는 관리자에게 OTP를 두 번 묻는다.

비밀번호 재설정(이메일)도 끝에 세션을 만들기 때문에 재설정 흐름에도 둔다: 관리자는 재설정 뒤에도 기존 OTP를 입력하고
(기본 `Reset OTP`의 재등록을 하지 않는다), OTP가 없는 관리자는 등록한다. `CONFIGURE_TOTP` 필수 동작은 켜 둔다(등록 화면).

SSO 쿠키(`Cookie` 단계)로 돌아오는 로그인은 폼을 다시 지나지 않는다. 제품 로그인은 언제나 `prompt=login`이라
(`api/src/auth.service.ts` `startFlow`) 비밀번호와 OTP를 다시 지난다 — 세션 중에 `admin`을 받은 사람도 다음 제품 로그인에서
OTP를 등록한다. Change Password(`UPDATE_PASSWORD` 동작)는 SSO 위에서 그 동작만 열고 제품 세션을 만들지 않는다.

OTP 기기를 잃은 관리자는 이메일 재설정으로 풀리지 않는다(재설정도 기존 OTP를 묻는다). Keycloak 관리 콘솔 → `kin` →
Users → 그 사용자 → Credentials에서 OTP를 Delete 하면 다음 로그인에 다시 등록한다(관리 이력에 남는다).

**PACS도 OTP를 확인한다.** PACS의 권한은 Keycloak 역할이 아니라 DB 회원 권한이 정한다. 그 권한이 `admin`을 주면 PACS는
로그인 토큰(검증된 access token)에 `admin` 역할과 **실제로 OTP를 입력했다는 표시**(`amr`의 `otp`)가 둘 다 있을 때만 받아들인다
(`api/src/auth.service.ts` `adminProved` — 콜백·세션·토큰 갱신·Bearer가 모두 지난다). 그 표시는 렐름 파일이 두 관리자 OTP
단계(`kin browser administrator otp`·`kin reset administrator otp`의 `OTP Form`)에 붙인 인증 참조 `otp`(`default.reference.value`,
유효 `default.reference.maxAge` 43200초 = `ssoSessionMaxLifespan`; Keycloak 기본값 0이면 그 초가 지나면 사라진다)와 kin-bff의 AMR
매퍼(`kin-authentication-methods`, access token)가 만든다. 그래서:

- **관리자는 OTP를 처음 등록한 뒤 한 번 더 로그인한다.** 등록하는 로그인의 토큰에는 `otp`가 없다(Keycloak 26.7.3은 등록을
  OTP 입력으로 세지 않는다). PACS는 그 로그인을 세션 없이 거절하고 첫 화면에 "관리자 계정은 OTP 확인이 필요합니다. 다시
  로그인해 주십시오."를 보인다(접속기록 원인 `admin_otp_required`). 로그인 버튼으로 다시 들어가 비밀번호와 방금 등록한 코드를
  넣으면 들어간다.
- 같은 안내는 DB는 관리자인데 Keycloak에 `admin` 역할이 없을 때도 나온다(승격 뒤 역할 반영이 늦거나 실패함, 콘솔에서 역할이
  빠짐). 이때는 다시 로그인해도 거절된다 — Keycloak이 `admin`이 아니면 OTP를 묻지 않는다. 마지막 관리자에게도 로그인 예외는
  없다. 복구: 반영 기록이 확인되지 않은(`unknown`·`void`) 명부 변경은 운영자 CLI `node prisma/import-member-rights.cjs --retry-roster`
  (api 컨테이너 안)가 다시 보낸다. 반영이 확인된(`done`) 뒤 콘솔에서 생긴 어긋남은 그 CLI가 고치지 않는다 — 콘솔 → `kin` →
  Users → 그 사용자 → Role mapping에서 `admin`을 다시 주고, OTP가 없으면 위의 OTP 복구 절차를 따른다. 그 뒤 OTP로 로그인한다.
- 이 규칙이 배포되기 전에 만든 관리자 세션(토큰에 `otp` 표시가 없음)은 배포 뒤 첫 요청에서 끝난 세션으로 답하고, 다시
  로그인하면 들어간다. 판독의·방사선사·임상의는 바뀌지 않는다.

**기존 설치(import가 적용되지 않는다):** 관리 콘솔 → `kin` 렐름 → Authentication에서:

1. `browser` 흐름을 Duplicate 하여 이름을 `kin browser`로 한다.
2. `kin browser Browser - Conditional 2FA`에 condition `Condition - user role`을 더해 Required로 두고, 설정(alias
   `kin browser not administrator`)에서 User role `admin`, Negate output On.
3. `kin browser forms`에 sub-flow `kin browser administrator otp`(basic)를 더해 Conditional로 두고, 그 안에 condition
   `Condition - user role`(Required, alias `kin browser administrator`, User role `admin`, Negate output Off)과
   step `OTP Form`(Required)을 차례로 더한다.
4. `reset credentials` 흐름을 Duplicate 하여 `kin reset credentials`로 하고, `kin reset credentials Reset - Conditional OTP`에
   2와 같은 condition(alias `kin reset not administrator`)을, `kin reset credentials`에 3과 같은 sub-flow
   `kin reset administrator otp`(condition alias `kin reset administrator`)를 더한다.
5. `kin browser`를 Browser flow로, `kin reset credentials`를 Reset credentials flow로 Bind 한다.
6. Required actions에서 `Configure OTP`가 Enabled인지 본다(기본 On). 어느 client에도 Authentication flow overrides의
   Browser Flow를 두지 않는다.
7. 3·4에서 더한 두 `OTP Form`(⚙ 설정)에 인증 참조를 단다: alias `kin browser administrator otp reference` /
   `kin reset administrator otp reference`, Authentication Reference `otp`, Authentication Max Age `43200`.
8. Clients → `kin-bff` → Client scopes → `kin-bff-dedicated` → Add mapper → By configuration → `Authentication Method Reference
   (AMR)`: 이름 `kin-authentication-methods`, Add to access token On, Add to ID token Off, Add to token introspection On.

이미 1~6을 적용한 설치(이 절의 앞 판)는 7·8만 더한다. 적용 전에는 관리자가 아무도 PACS에 들어가지 못하므로(토큰에 `otp`
표시가 없다) 배포 전에 한다 — 배포 전 읽기가 적용 전에는 멈춘다.

Admin REST(`kin` 렐름 관리자 토큰, 경로의 공백은 `%20`, `P=/admin/realms/kin/authentication`)는 같은 순서다:

- 복사: `POST $P/flows/browser/copy` `{"newName":"kin browser"}`, `POST $P/flows/reset%20credentials/copy`
  `{"newName":"kin reset credentials"}`.
- 조건·단계 더하기(위 2·3·4의 각 조건과 `OTP Form`): `POST $P/flows/{흐름}/executions/execution` `{"provider":"conditional-user-role"}`
  (또는 `"auth-otp-form"`) → `GET $P/flows/{흐름}/executions`의 마지막 행을 `"requirement":"REQUIRED"`로 바꿔
  `PUT $P/flows/{흐름}/executions` → 조건이면 `POST $P/executions/{그 행 id}/config`
  `{"alias":"…","config":{"condUserRole":"admin","negate":"true"|"false"}}`.
- 하위 흐름 더하기(위 3·4): `POST $P/flows/{부모}/executions/flow` `{"alias":"kin browser administrator otp","type":"basic-flow","description":""}`
  → 부모의 마지막 행을 `"requirement":"CONDITIONAL"`로 `PUT` → 그 안에 조건(`negate` `"false"`)과 `OTP Form`을 차례로 더한다.
- 묶기: `PUT /admin/realms/kin` `{"browserFlow":"kin browser","resetCredentialsFlow":"kin reset credentials"}`.
- 인증 참조(위 7): 각 하위 흐름의 `OTP Form` 행 id를 `GET $P/flows/{하위 흐름}/executions`에서 읽어
  `POST $P/executions/{그 id}/config` `{"alias":"kin browser administrator otp reference","config":{"default.reference.value":"otp","default.reference.maxAge":"43200"}}`
  (재설정 쪽은 alias `kin reset administrator otp reference`).
- AMR 매퍼(위 8): `GET /admin/realms/kin/clients?clientId=kin-bff`의 id로 `POST /admin/realms/kin/clients/{id}/protocol-mappers/models`
  `{"name":"kin-authentication-methods","protocol":"openid-connect","protocolMapper":"oidc-amr-mapper","consentRequired":false,
  "config":{"id.token.claim":"false","access.token.claim":"true","introspection.token.claim":"true"}}`.

렐름 재import·사용자 변경은 필요 없다. 업그레이드의 B 전 확인(`docs/ops/release-tools-runbook.md` "Precondition: the
upgrade itself" 1 — N의 `scripts/ops_deploy_preflight.py` `check_admin_mfa`; 전환 runner의 fence 전 읽기
`scripts/ops_emr_introduction.py`도 같은 검사)이 live browser·reset 흐름을 이 파일의 흐름과 모양(단계·요구·조건 설정·순서, 이름과 id는 보지 않는다)으로
대조하고 `Configure OTP`·client override·kin-bff의 AMR 매퍼(access token)를 확인해, 적용 전에는 첫 변경 전에 멈춘다. **그 읽기가
못 보는 것:** Admin REST는 인증 참조의 두 값을 `**********`로 가려 돌려주므로 검사는 두 칸이 있다는 것만 본다(가리지 않고
읽히는 값은 이 파일의 값과 비교한다). 실제 로그인 토큰에 `otp`가 실리는지는 보지 않는다 — 적용 뒤 관리자 계정으로 한 번
로그인해 들어가는지로 확인한다. 적용 뒤 관리자 계정으로 로그인하면 비밀번호 다음에 OTP(없으면 등록) 화면이 나오고, 판독의
계정은 바로 들어간다. 이미 있는 관리자 계정은 적용 뒤 첫 로그인에서 OTP를 등록하고(그 로그인은 위와 같이 한 번 거절된다)
한 번 더 로그인하므로 OTP 앱(Google Authenticator·Microsoft Authenticator·FreeOTP)을 미리 알린다.

## 관리 접근 변경 이력 — 3년 보존

`kin` 렐름은 `adminEventsEnabled=true`, `adminEventsDetailsEnabled=true`로 관리 사건과 변경 내용
(`representation`)을 Keycloak PostgreSQL에 저장한다. 근거는 **개인정보의 안전성 확보조치 기준 제5조③**의
접근권한 부여·변경·말소 내역 최소 3년 보관이다. `attributes.adminEventsExpiration="94694400"`은
윤년 하루를 포함한 `(3 × 365 + 1) × 24 × 60 × 60`초(1096일)다. 사용자 사건의 `eventsExpiration`과
다른 설정이며, 사용자 사건 설정은 변경하지 않는다.

고정 버전 26.7.3은 관리 사건의 선택 저장을 지원하지 않아 **모든 관리 사건**을 저장한다.
조회 시 쓰는 `operationTypes`는 저장 필터가 아니다. 변경 내용도 함께 남겨 누가 어느 계정·권한을
어떻게 변경했는지 확인한다. 제품의 업무 권한 이력은 기존 MemberRights 경로가 계속 기록하며,
Keycloak의 로그인 가능 여부·인증 수단 변경은 이 관리 이력에서 확인한다.
기술 근거: [26.7.3 AdminEventBuilder](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/services/resources/admin/AdminEventBuilder.java),
[JpaEventStoreProvider](https://github.com/keycloak/keycloak/blob/26.7.3/model/jpa/src/main/java/org/keycloak/events/jpa/JpaEventStoreProvider.java).

**기존 설치:** import JSON은 이미 PostgreSQL에 있는 렐름을 덮어쓰지 않는다. 관리 콘솔에서 `kin` 선택 →
Realm settings → Events → Admin events settings로 이동하여 Save events와 Include representation을 On으로,
Expiration을 **1096 Days**(저장값 94694400초)로 지정하고 Save한다. User events settings는 그대로 둔다.
저장 뒤 같은 화면을 다시 열어 값이 유지되는지 확인한다.

같은 설정을 CLI로 적용하려면, 해당 설치의 관리자 인증이 이미 된 `KC_ADMIN_CONFIG` 경로를 사용하여
Keycloak 컨테이너 안에서 다음을 실행한다(Bash). `kcadm.sh update`의 기본 GET 후 병합 방식을 사용하므로
기존 렐름 속성과 사용자 사건 설정을 보존한다(`--no-merge`를 붙이지 않는다).

```bash
/opt/keycloak/bin/kcadm.sh update realms/kin --config "$KC_ADMIN_CONFIG" \
  -s 'attributes.adminEventsExpiration="94694400"'
/opt/keycloak/bin/kcadm.sh update events/config -r kin --config "$KC_ADMIN_CONFIG" \
  -s adminEventsEnabled=true -s adminEventsDetailsEnabled=true
/opt/keycloak/bin/kcadm.sh get events/config -r kin --config "$KC_ADMIN_CONFIG" \
  --fields adminEventsEnabled,adminEventsDetailsEnabled
/opt/keycloak/bin/kcadm.sh get realms/kin --config "$KC_ADMIN_CONFIG" \
  --fields 'attributes(adminEventsExpiration)'
```

두 조회에서 각각 `true`, `true`, `"94694400"`인지 확인한다. 재import·DB 초기화·계정 재생성은 필요 없다.
설정 적용 이후 생성되는 사건에 대한 보존이며, 과거에 저장하지 않은 사건을 복구하지 않는다.
관리 콘솔의 Clear admin events는 보존기간 전 이력을 지우므로 보존 대상 이력을 정리하는 데 사용하지 않는다.

## 사용자 세션 캐시는 끈다 (`--spi-user-sessions--infinispan--use-caches=false`)

두 compose의 Keycloak command에 이 옵션을 둔다(`docker-compose.yml`, 그리고 그 command를 통째로 덮어쓰는
`docker-compose.prod.yml` — 운영 파일에서 빠뜨리면 운영에만 문제가 남는다). **persistent user sessions는 끄지 않는다**:
세션은 계속 PostgreSQL에 남아 재기동 뒤에도 유지된다. 끄는 것은 그 앞의 내장(embedded) 사용자/클라이언트 세션
캐시뿐이며 렐름·사용자·역할 캐시는 그대로다. `cache=local`로 바꾸는 것은 대신이 아니다(local도 같은 캐시다).

**왜:** 26.7.3에서 세션 캐시가 비었을 때 DB에서 읽은 옛 세션을 캐시에 다시 넣는 사이 종료가 끼면, 이미 끝낸 세션이
캐시에서 되살아난다(keycloak#51127). 그러면 확인된 Log out 뒤에도 같은 브라우저의 다음 Login에 Keycloak이 앞 의사의 끝난
인증을 폼 없이 돌려줄 수 있다 — 관리자 세션 목록은 DB를 읽어 0으로 보이면서. 캐시 없이 DB만 읽으면 그 부활 경로가 없다
(26.7.3 `InfinispanUserSessionProviderFactory`: 옵션 `useCaches`, 읽는 곳 `:144`, 보고 `:330-334`). 이 옵션은 이미 끝난
응답이나 발급된 code를 소급 취소하지 않으므로 BFF의 종료 표식·옛 Bearer 거절·미확인 종료 보호는 그대로 필요하다.

**확인(실효값):** 옵션이 소스에 있다는 것은 실행 중 반영의 증거가 아니다. 실행 중인 Keycloak의 관리자 자격으로
`GET /auth/admin/serverinfo`를 읽어 `providers.userSessions.providers.infinispan.operationalInfo.useCaches`가 `"false"`인지,
같은 응답의 `PERSISTENT_USER_SESSIONS` 기능이 켜져 있는지(`enabled: true`) 확인한다. 비밀 필드는 출력·보존하지 않는다.
이 옵션 이전(캐시 ON)의 값은 `"true"`다.

**기존 설치:** 렐름·클라이언트 쓰기가 아니라 Keycloak **프로세스 옵션**이므로, 기존 PostgreSQL 렐름은 그대로 두고
Keycloak 서비스만 새 command로 갱신·재기동하면 반영된다(렐름 재import·삭제·비밀번호/secret 회전 없음, 병원 쪽 수동 작업 없음).
같은 옵션·DB로 다시 띄우는 것은 멱등이다. 갱신 뒤 위 실효값을 다시 읽어 확인한다. 이 변경은 API-only 배포
(`scripts/ops_deploy_preflight.py`가 compose·keycloak 변경을 일부러 거절한다)로는 나가지 않으며, Keycloak을 포함한 배포
경로로 반영한다.

**26.8.0 업그레이드는 별도 단위다.** 26.8.0은 #51127을 제한된 tombstone으로 고쳤지만 기본은 여전히 캐시 ON이고,
Keycloak 자체 DB migration이 있는 minor 업그레이드다. 업그레이드를 하더라도 이 옵션은 명시적으로 유지한다. 같은 브라우저에서
끝난 sid를 다음 SSO가 다시 받는 일(keycloak#53682)은 이 옵션과 별개이며 BFF의 같은-sid 경계가 계속 다룬다.

## 들어 있는 것

| 항목 | 값 |
|---|---|
| 렐름 | `kin` |
| 클라이언트 | `kin-web` (public, Authorization Code + PKCE S256), `gw-kin-center` (비활성 Gateway 템플릿) |
| 롤 | `radiologist`, `technician`, `admin`, `clinician`, `gateway` |
| 토큰 수명 | access 30분 / 세션 유휴 4시간 / 최대 12시간 |
| 보호 | 비밀번호 최소 8자리(조합 강제 없음), 로그인 5회 실패 시 잠금(brute force), `admin` 역할 OTP 필수 |

운영 주소는 `https://pacs.halolabs.co.kr`이다. 옛 주소 `pacs.koreaimagingnetwork.com`은 프록시가 새 주소로 301하며, 이전이
끝날 때까지 `kin-web`·`kin-bff`의 redirect URI·web origin에 새 주소와 함께 남긴다. 운영 렐름은 `--import-realm`으로 바뀌지
않으므로(위 기존 설치) 새 주소는 관리 콘솔이나 Admin REST로 두 클라이언트에 직접 더한다.

## 기관 첫 관리자 지정 (운영자 명령)

병원 관리자는 **자기 기관의 회원만** 보고 바꾼다(`api/src/member-scope.ts` — 다른 기관 회원은 없는 id와 같은 답,
기관 배정은 자기 기관으로만). 그래서 활성 관리자가 없는 기관(새 병원, 개발 realm의 `kin-center`)의 첫 관리자는
화면이 아니라 API 컨테이너 안의 운영자 명령으로 한 번 세운다. 그 뒤 그 기관의 회원은 그 관리자가 화면에서 다룬다.

1. 사람 계정을 준비한다: 본인이 가입하거나(승인 대기) 관리 콘솔 → `kin` → Users에서 만든다. 그 사용자의 ID(`sub`)를 적는다.
2. api 컨테이너 안에서:

   ```text
   node prisma/designate-first-admin.cjs --institution <그룹 이름> --subject <사용자 ID> \
     --operator <실행한 사람> --reason "<병원의 요청과 누가 어떻게 확인했는지>"
   ```

3. 결과(출력 JSON의 `designated`가 끝 코드와 같은 뜻이다):
   - 0 = 지정되고 Keycloak 반영 확인(`designated: true`).
   - 2 = 지정은 저장(커밋)됐고 반영이 확인되지 않음 — 저장 뒤의 기록 조회·반영 전송·그 답 가운데 하나가 실패했거나
     저장 뒤 다른 단계가 예외를 냄(`designated: true`). `node prisma/import-member-rights.cjs --retry-roster`가 같은
     변경을 다시 보낸다.
   - 1 = 지정 안 됨: 거절(그 앞의 거절은 아무것도 쓰지 않음), 또는 지정 트랜잭션이 커밋되기 전에 실패하거나 커밋되지
     않았음이 확인됨. 실패 감사 행·운영자 원장 신원이 남을 수 있으나 권한은 주지 않는다(`designated: false`).
   - 3 = 저장됐는지 모름: 커밋 답을 잃었고 이 실행이 쓴 감사 행도 보이지 않음(아직 커밋 중일 수 있음, `designated: null`).
     관리 화면의 그 기관 회원(또는 감사 기록)에서 그 사람이 관리자인지 보고, 관리자이면 `--retry-roster`를, 아니면
     같은 명령을 다시 실행한다.

   끝의 정리(원장 런타임 정지·DB 연결 닫기)가 실패하면 그 사실을 따로 한 줄로 알리고, 끝 코드는 바꾸지 않는다.
4. 지정된 사람은 다음 로그인에서 OTP를 등록하고(위 "관리자 OTP 필수"), 한 번 더 로그인한다.

명령이 하는 일은 화면의 승인과 같다(회원 권한·버전·재로그인 기준·세션 종료·감사 행 `admin.user.approve`·명부 반영
기록). 감사 행의 `actor`는 `operator:<실행한 사람>`, `detail.operator`에 기관·사유가 남는다. 역할은 그 사람의 지금 그
기관 역할에 `admin`만 더한다. 거절(쓰기 0): 그 기관에 승인·활성 관리자가 이미 있음(다시 실행해도 같다 — 두 사람이 동시에
실행해도 기관을 잠근 뒤 다시 읽어 한 명만 된다), 다른 기관 회원, 그룹이 둘 이상이거나 이 기관이 아닌 그룹을 가진 계정,
서비스 계정, 정지·격리된 계정, 지금 로그인 중인 계정(명령은 회원의 세션을 끝내지 않는다 — 로그아웃하거나 세션이 끝난 뒤 다시 실행), 없는 기관. 비밀번호·OTP·정지는 건드리지 않는다. `--force`는 없다 — 관리자가 있는 기관에
더하는 것은 그 기관 관리자가 화면에서 한다. 마지막 관리자가 떠났는데 권한이 살아 있는 경우의 교체는 이 명령이 하지 않는다
(그 관리자의 정지·철회는 위 "관리자 OTP 필수"의 복구 절차와 관리 콘솔로).

개발·시험 스택: `kin-center`의 고정 관리자 `kin-center-admin`은 라이브 시험 하네스(`tests/invariants_live.py`
`LiveStack`)가 처음 필요할 때 이 명령으로 한 번 지정하고 다시 쓴다. 실행마다 생기는 시험 기관은 그 실행의 합성
관리자를 같은 명령으로 세운다.

## SMTP와 이메일 검증

회원 가입 검증과 비밀번호 재설정 메일은 Google Workspace SMTP를 사용한다.

- SMTP: `smtp.gmail.com:587`, STARTTLS, 인증 사용
- 발신 주소: `no-reply@halolabs.co.kr`
- 렐름 정책: `verifyEmail=false`(병원 선택 시 켠다), `resetPasswordAllowed=true`
- 이메일 언어: 기본 한국어(`kin-email`), 필요 시 영어 선택
- SMTP 앱 비밀번호는 사용자가 무표시 입력으로 라이브 렐름에만 넣는다.

앱 비밀번호는 렐름 JSON, 명령 이력, 로그, 문서에 남기지 않는다. 렐름 export를 검증할 때도
`smtpServer.password` 같은 비밀 필드를 출력하지 않고 `host`·`from`·`auth`의 존재만 확인한다.
빈 DB import 뒤에는 아래 값만 템플릿으로 사용하고 `<SMTP_APP_PASSWORD>`의 실값은 사용자가
히스토리가 남지 않는 보안 입력 절차로 직접 주입한다.

```text
host=smtp.gmail.com
port=587
from=no-reply@halolabs.co.kr
auth=true
starttls=true
password=<SMTP_APP_PASSWORD>
```

자기 가입은 `registrationAllowed=true`이지만 프론트가 Keycloak 등록 주소를 직접 만들지 않는다.
`/api/auth/register`가 state·PKCE·pending 쿠키를 만든 다음 `prompt=create`로 넘기는 경로만
사용한다. 가입 직후에는 기관·업무 역할이 없어 승인 대기 상태이며, 관리자가 대면 확인 후 승인한다
(이메일 미검증 승인은 감사 기록에 남는다).

비밀번호는 최소 8자리만 요구하고 12자리·문자 조합을 강제하지 않는다. 세션 유휴 4시간과
5회 실패 잠금은 HPACS가 2025년 6월에야 넣은 정책이다
(→ `HPACS-릴리즈노트-교훈.md` §9). 뒤늦게 붙이면 전 구간을 건드리게 되므로 처음부터 켠다.

## 개발용 계정

| 아이디 | 롤 |
|---|---|
| `jmryu` | radiologist, technician, admin |
| `doctor` | radiologist |
| `tech` | technician |

Keycloak 관리 콘솔: http://localhost:8080 (관리자 비밀번호는 `.env`의 `KC_ADMIN_PASSWORD`)

> 렐름 파일에는 사용자 비밀번호가 없다. 최초 import 뒤 관리 콘솔이나 Admin REST로 설정하고,
> 로컬 자동화용 값은 Git에서 제외된 `.env`의 `KIN_TEST_PASSWORD`로만 관리한다.

## 왜 audience 매퍼가 있나

`kin-api-audience` 프로토콜 매퍼가 access token의 `aud`에 `kin-api`를 넣는다.
API는 서명·발급자뿐 아니라 **이 토큰이 우리 API를 위해 발급된 것인지**(audience)까지 확인한다.
이게 없으면 같은 Keycloak의 다른 클라이언트용 토큰으로도 우리 API를 부를 수 있다.

## 기관(그룹) — 멀티 기관 테넌시

기관은 **롤이 아니라 그룹**이다. 롤은 "무엇을 할 수 있는가"(판독의/방사선사),
그룹은 "어느 조직에 속하는가"(한림병원/KIN 판독센터)다. 축이 다르므로 섞지 않는다.
롤로 흉내내면 기관이 하나 늘 때마다 롤이 늘고, 권한 검사 코드가 기관 목록을 알게 된다.

렐름에 그룹 두 개가 있다:

| 그룹 | 기관 | 유형 |
|---|---|---|
| `hallym` | 한림병원 | hospital |
| `kin-center` | KIN 판독센터 | reading-center |

`kin-institution-groups` 프로토콜 매퍼가 소속 그룹을 access token의 `groups` 클레임에 넣는다
(`full.path=false` 라서 `/hallym`이 아니라 `hallym`으로 온다).
API의 `AuthGuard`가 그 값을 `req.institution`으로 꺼내고, 서비스 계층이 모든 조회·수정을
그 기관으로 거른다. **클라이언트가 기관을 고를 수 없다** — 감사로그의 actor와 같은 이유로
기관도 서명된 토큰에서만 나온다. 헤더로 받으면 그건 필터가 아니라 요청이다.

### 개발용 계정

| 계정 | 기관 | 롤 |
|---|---|---|
| `jmryu` | 한림병원 | radiologist + technician + admin |
| `doctor` | 한림병원 | radiologist |
| `tech` | 한림병원 | technician |
| `kdoctor` | KIN 판독센터 | radiologist |
| `ktech` | KIN 판독센터 | technician |

`admin` 롤도 기관 경계를 넘지 못한다. 역할과 소속은 다른 축이라, admin이라고 남의 병원
환자를 보게 하면 그건 편의가 아니라 구멍이다.

`clinician` 롤만 가진 승인 회원은 API의 명시 allowlist(`api/src/clinician-policy.ts`)에 있는
경로만 부를 수 있고 나머지는 `403 CLINICIAN_ROUTE_DENIED`다. 처음에는 본인 세션 동작(`GET /api/me`,
`POST /api/auth/logout`)만 있고 업무 경로는 비어 있다. radiologist/technician/admin이 함께 있으면
그 역할의 기존 권한 경로를 그대로 타며 clinician이 그것을 좁히지 않는다. 이미 운영 중인 렐름에는
import가 적용되지 않으므로 관리 콘솔이나 Admin REST로 realm 역할 `clinician`을 한 번 추가한다.

소속 그룹이 없는 계정은 **빈 목록이 아니라 403**을 받는다. 매퍼 설정이 틀렸을 때
"검사가 하나도 없네"로 보이는 것이 가장 나쁘다.

## Gateway 서비스 계정

렐름 JSON의 `gw-kin-center`는 구조를 고정하는 **비활성 템플릿**이며 시크릿이 없다. 실제 설치
때 `gw-<institutionId>` confidential client를 별도로 만들고 client credentials를 켠 뒤,
서비스 계정에 해당 기관 그룹 하나와 realm 역할 `gateway` 하나만 부여한다. 사람 역할을 섞거나
시크릿을 렐름 JSON에 기록하지 않는다.

## 서비스 계정 (kin-api) — 사용자 조회·회원 관리

Preliminary(RS=P)는 상급 판독의를 **지정**하는 기능이고, 지정된 사람만 판독문을 볼 수 있다.
지정 대상을 자유 입력으로 받으면 오타 하나에 아무도 못 여는 판독문이 생긴다.
그래서 API가 Keycloak에 "우리 기관의 판독의가 누구인가"를 직접 묻는다.

- 컨피덴셜 클라이언트 `kin-api` + 서비스 계정 (compose의 `KC_CLIENT_SECRET`)
- 부여된 realm-management 롤: `manage-users`, `view-users`, `query-users`, `query-groups`, `view-realm`

`view-realm`이 필요한 이유: `GET /admin/realms/{realm}/roles/{role}/users`(롤 보유자 목록)는
`view-users`만으로는 **403**이다. 이 엔드포인트가 롤 조회 권한을 따로 보기 때문.
회원 콘솔은 `manage-users`로 생성·정지·역할·그룹·비밀번호 초기화를 수행한다. 이 역할은
사용자 삭제까지 가능한 넓은 권한이므로 API는 고정된 `/api/admin/users` 동작만 제공한다.
범용 Keycloak 프록시와 사용자 삭제 라우트는 없고, 서비스 계정 사용자는 목록과 모든 쓰기에서
제외한다. impersonation·client 관리는 별도 역할이라 서비스 계정 토큰으로 403이다.

사용자의 토큰을 빌려 쓰지 않는다 — 판독의에게 사용자 조회 권한을 줄 이유가 없다.
서버가 서버 자격으로 묻는다.

클라이언트 시크릿은 렐름 JSON의 `${KC_KIN_API_SECRET}` 플레이스홀더에 Compose가
`.env`의 `KC_CLIENT_SECRET`을 주입한다. 운영에서는 같은 값을 시크릿 매니저에서 공급한다.

## issuer 주소가 두 개인 이유

- 브라우저는 `http://localhost:8080`으로 Keycloak에 간다 → 토큰의 `iss`가 그 주소로 박힌다
- API 컨테이너는 같은 Keycloak을 `http://keycloak:8080`(도커 네트워크 이름)으로 본다

그래서 API는 **JWKS는 내부 주소로 가져오고, `iss` 검증은 외부 주소로** 한다.
compose의 `KC_ISSUER`(외부)와 `KC_JWKS_URL`(내부)이 그 둘이다.
Keycloak에 `KC_HOSTNAME=http://localhost:8080`을 고정해 두었기 때문에 `iss`가 흔들리지 않는다.

## 설정을 바꾼 뒤

Keycloak은 기존 PostgreSQL의 별도 `keycloak` 데이터베이스를 쓴다. 컨테이너를 재생성해도
현재 렐름이 유지되고, import 파일의 변경은 기존 렐름을 덮어쓰지 않는다.

```bash
docker compose up -d --force-recreate keycloak
```

빈 DB에서 렐름 파일을 다시 import해야 할 때는 사용자 비밀번호를 별도로 설정한다.
저장소의 JSON에는 비밀번호나 고정 클라이언트 시크릿을 추가하지 않는다.
