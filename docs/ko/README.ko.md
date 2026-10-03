# AI Trade Bot (ATB) — BNB Chain

## 배포 순서
1. `npm install`
2. `.env.example` → `.env` 복사 후 개인키 입력 (배포 전용 새 지갑 권장). 메인넷은 배분 수령 주소 7개(멀티시그) 필수
3. 테스트넷 tBNB 받기: https://www.bnbchain.org/en/testnet-faucet
4. `npm run compile` → `npm test` → `npm run deploy:testnet` (토큰 + 베스팅 배포, 배분 락업, 베스팅 오너 포기까지 한 번에 실행)
5. BscScan에서 verify (deploy 로그에 명령어 출력됨)
6. 테스트넷에서 approveOperator(에이전트 지갑이 호출) → registerAgent / anchorTrade / payAccess / freeze / slash / requestUnbond / bounty 동작 확인
7. 이상 없으면 `npm run deploy:mainnet`

## 상장 이후 (CMC 등록에 필요한 것)
- PancakeSwap에 ATB/BNB 유동성 풀 생성
- 웹사이트, 백서(metadataHash 스펙 포함), X/텔레그램
- BscScan 토큰 정보 업데이트 (로고, 링크)
- CMC / CoinGecko 리스팅 신청 폼 제출

## 문서
- `docs/TOKENOMICS.md` — 배분·베스팅·수수료·하드캡 스펙 (코드와 1:1)
- `docs/WHITEPAPER.md`, `docs/CMC-APPLICATION.md`

## 봇 연동 (`bot/`)
퀀트 트레이딩 스택과 컨트랙트 사이의 브리지입니다. 주문 전 `guard()`(킬 스위치 + 일일 한도 확인), 체결 후 `anchor_fill()`(온체인 앵커), 대시보드 "On-chain" 탭 데이터, `AccessPaid` 이벤트 → 30일 이용권 인덱서를 제공합니다. 자세한 내용은 [bot/README.md](../../bot/README.md) 참고.
```bash
npx hardhat run scripts/register-agent.js --network bscTestnet   # 봇 지갑 생성 + 운영자 승인 + 본드 + 에이전트 등록
python bot/atb_bridge.py status                                  # 봇 지갑 기준 에이전트 상태
python -m bot.access_indexer                                     # 이용권 결제 인덱싱
```
테스트넷 레퍼런스 에이전트: `0x6F90de57291A757f903d70f3cACcf4e23943026F`

## 보안 메모
- 감사(audit) 전 상태입니다. 메인넷 전 최소 1회 외부 감사 권장
- `arbiter`와 `owner`는 반드시 멀티시그(Safe)로 이전 (2단계: Safe가 `acceptOwnership()` 호출)
- 보증금 슬래싱 기준을 백서에 명문화해야 신뢰를 얻을 수 있음
- 배포 후 `deployments/<network>.json`을 커밋해 수령 주소·스케줄을 공개
