코드를 충분히 파악했습니다. 이제 두 가지 버그/기능을 분석하고 수정합니다.

**버그 1 분석 — 4라운드 연결 끊김:**
`runSettlement`에서 `settled` 상태로 `startTimer`/`scheduleBotTurn`을 호출하는데, `settled`는 **정산 직후의 스냅샷**입니다. 다음 라운드가 시작된 실제 최신 상태와 다를 수 있어 `turnSeq` 불일치가 발생합니다. 4라운드(마지막 라운드)에서는 특히 `ENDED` → 타이머 로직 분기가 경쟁 조건을 일으킵니다. 또한 `game:ended` 이벤트 emit 후 소켓이 방을 나가지 않아 후속 브로드캐스트에서 오류가 생길 수 있습니다.

**기능 2 — 우승자 표시:** `ENDED` 단계에서 `getWinner`로 우승자를 계산해 화면에 표시합니다.이제 두 파일의 전체 내용을 파악했습니다. 수정을 진행합니다.

---

## 버그 분석 요약

**4라운드 연결 끊김 근본 원인 3가지:**

1. **`runSettlement`의 stale state 문제**: `settled` 스냅샷으로 `startTimer(settled)` / `scheduleBotTurn(settled)` 호출 → 실제 저장된 상태(`beginRound` 후 `turnSeq` 증가)와 불일치 → 타이머가 엉뚱한 `turnSeq`로 등록됨
2. **마지막 라운드 `ENDED` 후 타이머 미정리**: `game:ended` emit 전 `scheduler.clear(roomId)` 호출 누락
3. **`disconnect` 핸들러에서 `ENDED` 상태 무조건 덮어쓰기**: 게임 종료 후 재접속 시 `connected: false` 업데이트가 방을 오염시킴

**우승자 표시**: `ENDED` 단계에서 `getWinner`로 계산된 결과를 모달로 표시.이제 수정 패치를 작성합니다.이제 두 파일의 수정 코드를 작성합니다.이제 실제 수정 코드를 작성합니다.

---

### 수정 1: `src/server/handlers.ts`

**변경 사항:**
1. `runSettlement` — `ENDED` 전 `scheduler.clear` 추가, `ROLLING` 전환 후 `store.load`로 **최신 상태** 재조회 후 타이머/봇 스케줄링
2. `disconnect` 핸들러 — `ENDED` 상태일 때 상태 덮어쓰기 건너뜀

```typescript
// ── [수정 1] runSettlement ──────────────────────────────────────────────────
async function runSettlement(roomId: string): Promise<void> {
  const settled = await store.update(roomId, (s) => {
    if (s.phase !== 'SETTLING') return s;
    return Engine.settle(s).state;
  });
  await broadcast(settled);

  if (settled.phase === 'ENDED') {
    scheduler.clear(roomId);                          // ✅ 추가: 좀비 타이머 방지
    io.to(roomId).emit('game:ended', { winner: Engine.getWinner(settled) });

  } else if (settled.phase === 'ROLLING') {
    setTimeout(async () => {
      // ✅ 수정: settled 스냅샷 대신 store에서 최신 상태 재조회
      const latest = await store.load(roomId);
      if (!latest || latest.phase !== 'ROLLING') return;
      startTimer(latest);
      scheduleBotTurn(latest);
    }, 1500);
  }
}

// ── [수정 2] disconnect 핸들러 ───────────────────────────────────────────────
socket.on('disconnect', async () => {
  const { roomId, playerId } = socket.data;
  console.log(`[-] ${socket.id} player=${playerId}`);
  if (!roomId || !playerId) return;
  try {
    await store.update(roomId, (s) => {
      if (s.phase === 'ENDED') return s;             // ✅ 추가: 종료된 게임 보호
      return {
        ...s,
        players: s.players.map(p =>
          p.id === playerId ? { ...p, connected: false } : p
        ),
      };
    });
    io.to(roomId).emit('player:disconnected', { playerId });
  } catch { /* 방이 없을 수 있음 */ }
});
```

---

### 수정 2: `public/index.html`

**변경 사항:**
1. `game:ended` 이벤트 수신 시 우승자 모달 표시 (`showWinnerModal`)
2. 팀전(`2v2`) / 개인전 분기 처리
3. `ENDED` 단계 `renderActions`에서도 우승자 인라인 표시

```javascript
// ── [수정 3] game:ended 이벤트에서 우승자 모달 표시 ───────────────────────
socket.on('game:ended', ({ winner }) => {
  log(`🏆 게임 종료! 승자: ${winner}`, 'win');
  stopTimer();
  showWinnerModal(winner, gameState);     // ✅ 추가
});

// ── [수정 4] 우승자 모달 함수 추가 ─────────────────────────────────────────
function showWinnerModal(winner, state) {
  const existing = document.getElementById('winner-modal');
  if (existing) existing.remove();

  const isTeam = state?.config?.mode === '2v2';
  const isDraw = winner === 'Draw';

  let title, subtitle, detail = '';
  if (isDraw) {
    title = '🤝 무승부!';
    subtitle = '모든 플레이어가 동점입니다';
  } else if (isTeam) {
    title = `🏆 ${winner} 우승!`;
    const teamLetter = winner.replace('Team ', '');
    const members = (state?.players || [])
      .filter(p => p.team === teamLetter)
      .map(p => `<span style="color:${p.color}">${p.nickname}</span>`)
      .join(', ');
    subtitle = `팀원: ${members}`;
    const teamMoney = (state?.players || [])
      .filter(p => p.team === teamLetter)
      .reduce((s, p) => s + p.money, 0);
    detail = `팀 총 자금: ${won(teamMoney)}`;
  } else {
    const winPlayer = (state?.players || []).find(p => p.nickname === winner);
    title = `🏆 ${winner} 우승!`;
    subtitle = winPlayer ? `최종 자금: ${won(winPlayer.money)}` : '';
  }

  // 최종 순위표 생성
  let rankHtml = '';
  if (!isDraw && state?.players) {
    const sorted = isTeam
      ? (['A','B'].map(t => ({
          label: `팀 ${t}`,
          money: state.players.filter(p=>p.team===t).reduce((s,p)=>s+p.money,0),
          color: t==='A'?'#2980b9':'#c0392b',
          isWinner: winner === `Team ${t}`,
        })).sort((a,b)=>b.money-a.money))
      : ([...state.players].sort((a,b)=>b.money-a.money).map((p,i)=>({
          label: p.nickname, money: p.money, color: p.color,
          isWinner: p.nickname === winner,
        })));
    rankHtml = `<div style="margin-top:14px;display:flex;flex-direction:column;gap:6px;">` +
      sorted.map((r,i) => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;
          background:${r.isWinner?'rgba(255,215,0,.12)':'rgba(255,255,255,.04)'};
          border-radius:8px;border:1px solid ${r.isWinner?'rgba(255,215,0,.35)':'transparent'}">
          <span style="font-size:1.1rem;min-width:24px">${['🥇','🥈','🥉','4️⃣'][i]||''}</span>
          <span style="color:${r.color};font-weight:bold;flex:1">${r.label}</span>
          <span style="color:#eee">${won(r.money)}</span>
        </div>`).join('') + `</div>`;
  }

  const modal = document.createElement('div');
  modal.id = 'winner-modal';
  modal.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,.78);display:flex;
    align-items:center;justify-content:center;z-index:500;
    animation:fadeIn .3s ease`;
  modal.innerHTML = `
    <div style="background:#0f3460;border:2px solid rgba(255,215,0,.4);
      border-radius:18px;padding:32px 28px;max-width:360px;width:90%;text-align:center;
      box-shadow:0 8px 40px rgba(0,0,0,.6)">
      <div style="font-size:2.4rem;margin-bottom:8px">${isDraw?'🤝':'🏆'}</div>
      <h2 style="color:#ffd700;font-size:1.5rem;margin:0 0 6px">${title}</h2>
      <p style="color:#ccc;font-size:.9rem;margin:0 0 4px">${subtitle}</p>
      ${detail ? `<p style="color:#aaa;font-size:.82rem;margin:0">${detail}</p>` : ''}
      ${rankHtml}
      <button onclick="document.getElementById('winner-modal').remove()"
        style="margin-top:20px;padding:10px 28px;background:#e94560;color:#fff;
          border:none;border-radius:10px;font-size:.95rem;cursor:pointer;
          font-weight:bold">확인</button>
    </div>`;
  document.body.appendChild(modal);
}
```

---

### 수정 3: CSS 추가 (`public/index.html` `<style>` 내)

```css
@keyframes fadeIn { from { opacity:0; transform:scale(.92); } to { opacity:1; transform:scale(1); } }
.log-win { color: #ffd700; font-weight: bold; }
```

---

두 수정의 핵심을 정리하면:

**버그 수정 요약:**
- `runSettlement`에서 `ROLLING` 전환 후 `setTimeout` 내부에서 `store.load(roomId)`로 최신 상태를 다시 읽어 타이머를 등록 → stale state `turnSeq` 불일치 해소
- `ENDED` 진입 즉시 `scheduler.clear(roomId)` 호출 → 좀비 타이머 제거
- `disconnect` 핸들러에서 `s.phase === 'ENDED'`이면 상태 업데이트 스킵 → 종료된 방 오염 방지

**우승자 표시:**
- 개인전: 1등 닉네임 + 최종 금액 + 전체 순위표 모달
- 팀전: 우승 팀명 + 팀원 목록 + 팀 자금 + 팀별 순위표 모달
- 무승부 별도 처리
- 로그에도 `🏆` 스타일로 표시
