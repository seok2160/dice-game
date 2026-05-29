import { Server, Socket } from 'socket.io';
import { MemoryStore } from '../store/MemoryStore';
import { TurnScheduler, TimeoutPayload } from '../engine/TurnScheduler';
import * as Engine from '../engine/GameEngine';
import { GameState, PipValue } from '../engine/types';
import { v4 as uuidv4 } from 'uuid';

const PLAYER_LIMIT = 4;
const MAX_NICKNAME = 20;

export function registerHandlers(io: Server, store: MemoryStore): TurnScheduler {

  // ─── helpers ──────────────────────────────────────────────────────────────

  async function broadcast(state: GameState): Promise<void> {
    const sockets = await io.in(state.roomId).fetchSockets();
    for (const sock of sockets) {
      const pid = sock.data.playerId as string | undefined;
      sock.emit('state:update', pid ? Engine.privateView(state, pid) : Engine.publicView(state));
    }
  }

  function startTimer(state: GameState): void {
    if (state.phase !== 'ROLLING') return;
    const pid = state.turnOrder[state.currentTurnIdx];
    const player = state.players.find(p => p.id === pid);
    if (player?.isBot) return;
    if (pid) scheduler.start(state.roomId, pid, state.meta.turnSeq, state.config.turnTimeMs);
  }

  /** forceBet 결과에서 하나의 타입(일반 우선)만 골라 베팅 인수 반환 */
  function pickOneDiceType(bet: { pip: PipValue; ownCount: number; whiteCount: number }) {
    if (bet.ownCount >= bet.whiteCount) return { pip: bet.pip, ownCount: bet.ownCount,  whiteCount: 0 };
    return                                      { pip: bet.pip, ownCount: 0,             whiteCount: bet.whiteCount };
  }

  function scheduleBotTurn(state: GameState): void {
    const pid = state.turnOrder[state.currentTurnIdx];
    const player = state.players.find(p => p.id === pid);
    if (!player?.isBot || state.phase !== 'ROLLING') return;

    setTimeout(async () => {
      try {
        let settling = false;
        const next = await store.update(state.roomId, (s) => {
          const curPid = s.turnOrder[s.currentTurnIdx];
          const curPlayer = s.players.find(p => p.id === curPid);
          if (!curPlayer?.isBot || curPlayer.id !== pid || s.phase !== 'ROLLING') return s;

          const { state: afterRoll, roll } = Engine.roll(s, curPid);
          const raw = Engine.forceBet(roll);
          const bet = raw ? pickOneDiceType(raw) : null;
          const result = bet
            ? Engine.applyBet(afterRoll, curPid, bet.pip, bet.ownCount, bet.whiteCount)
            : Engine.pass(afterRoll);
          settling = result.phase === 'SETTLING';
          return result;
        });

        await broadcast(next);
        if (settling) {
          await runSettlement(state.roomId);
        } else if (next.phase === 'ROLLING') {
          startTimer(next);
          scheduleBotTurn(next);
        }
      } catch (e) { console.error('[bot error]', e); }
    }, 900 + Math.random() * 600);
  }

  async function runSettlement(roomId: string): Promise<void> {
    const settled = await store.update(roomId, (s) => {
      if (s.phase !== 'SETTLING') return s;
      return Engine.settle(s).state;
    });
    await broadcast(settled);
    if (settled.phase === 'ENDED') {
      io.to(roomId).emit('game:ended', { winner: Engine.getWinner(settled) });
    } else if (settled.phase === 'ROLLING') {
      setTimeout(() => {
        startTimer(settled);
        scheduleBotTurn(settled);
      }, 1500);
    }
  }

  function errAck(ack: ((r: unknown) => void) | undefined, e: unknown): void {
    const err = e as Error & { code?: string };
    ack?.({ ok: false, code: err.code ?? 'INTERNAL', msg: err.message });
  }

  // ─── timeout handler (defined before scheduler so it's in scope) ──────────

  async function timeoutHandler({ roomId, playerId, turnSeq }: TimeoutPayload): Promise<void> {
    try {
      const next = await store.update(roomId, (s) => {
        if (s.meta.turnSeq !== turnSeq) return s;
        if (s.phase === 'ENDED' || s.phase === 'SETTLING') return s;

        if (s.phase === 'ROLLING') {
          const { state: rolled, roll } = Engine.roll(s, playerId);
          const raw = Engine.forceBet(roll);
          const forced = raw ? pickOneDiceType(raw) : null;
          return forced
            ? Engine.applyBet(rolled, playerId, forced.pip, forced.ownCount, forced.whiteCount)
            : Engine.pass(rolled);
        }

        if (s.phase === 'CHOOSING' && s.currentRoll) {
          const raw = Engine.forceBet(s.currentRoll);
          const forced = raw ? pickOneDiceType(raw) : null;
          return forced
            ? Engine.applyBet(s, playerId, forced.pip, forced.ownCount, forced.whiteCount)
            : Engine.pass(s);
        }

        return s;
      });

      io.to(roomId).emit('turn:timeout', { playerId });
      await broadcast(next);

      if (next.phase === 'SETTLING') {
        await runSettlement(roomId);
      } else if (next.phase === 'ROLLING') {
        startTimer(next);
        scheduleBotTurn(next);
      }
    } catch (e) {
      console.error('[timeout error]', e);
    }
  }

  // ─── scheduler ────────────────────────────────────────────────────────────

  const scheduler = new TurnScheduler(timeoutHandler);
  scheduler.on('error', (e) => console.error('[scheduler]', e));

  // ─── socket events ────────────────────────────────────────────────────────

  io.on('connection', (socket: Socket) => {
    console.log(`[+] ${socket.id}`);

    // room:create ─────────────────────────────────────────────────────────────
    socket.on('room:create', async ({ nickname }: { nickname: string }, ack) => {
      if (!validNick(nickname)) return ack?.({ ok: false, code: 'INVALID_NICK', msg: 'Nickname must be 1-20 chars' });
      try {
        const playerId = uuidv4();
        const roomId   = uuidv4().slice(0, 8).toUpperCase();
        socket.data    = { playerId, roomId };

        const state = Engine.createRoom(roomId, playerId, nickname.trim());
        await store.save(state);
        await socket.join(roomId);

        ack?.({ ok: true, data: { roomId, playerId, state: Engine.privateView(state, playerId) } });
        console.log(`[room:create] ${roomId} host=${nickname}`);
      } catch (e) { errAck(ack, e); }
    });

    // room:join ───────────────────────────────────────────────────────────────
    socket.on('room:join', async ({ roomId, nickname }: { roomId: string; nickname: string }, ack) => {
      if (!validNick(nickname)) return ack?.({ ok: false, code: 'INVALID_NICK', msg: 'Nickname must be 1-20 chars' });
      if (!roomId?.trim()) return ack?.({ ok: false, code: 'INVALID_ROOM', msg: 'Room ID required' });
      try {
        let joinedId = '';
        const next = await store.update(roomId.trim().toUpperCase(), (s) => {
          if (s.players.length >= PLAYER_LIMIT) throw new Engine.GameError('ROOM_FULL', 'Room is full (max 4)');
          if (s.phase !== 'WAITING')            throw new Engine.GameError('GAME_STARTED', 'Game already started');
          joinedId = uuidv4();
          return Engine.addPlayer(s, joinedId, nickname.trim());
        });

        socket.data = { playerId: joinedId, roomId: next.roomId };
        await socket.join(next.roomId);

        const me = next.players.find(p => p.id === joinedId)!;
        ack?.({ ok: true, data: { playerId: joinedId, state: Engine.privateView(next, joinedId) } });
        socket.to(next.roomId).emit('player:joined', { player: me });
        io.to(next.roomId).emit('state:update', Engine.publicView(next));
        console.log(`[room:join] ${next.roomId} player=${nickname}`);
      } catch (e) { errAck(ack, e); }
    });

    // room:configure ──────────────────────────────────────────────────────────
    socket.on('room:configure', async (payload: { config: Partial<{ mode: string; useWhiteDice: boolean; totalRounds: 1 | 2 | 3 | 4; turnTimeMs: number }> }, ack) => {
      const { roomId, playerId } = socket.data;
      if (!roomId) return ack?.({ ok: false, code: 'NOT_IN_ROOM', msg: 'Join a room first' });
      try {
        const next = await store.update(roomId, (s) => {
          if (s.meta.hostId !== playerId) throw new Engine.GameError('NOT_HOST', 'Only host can configure');
          return Engine.setConfig(s, payload.config as never);
        });
        io.to(roomId).emit('state:update', Engine.publicView(next));
        ack?.({ ok: true });
      } catch (e) { errAck(ack, e); }
    });

    // game:start ──────────────────────────────────────────────────────────────
    socket.on('game:start', async (_: unknown, ack) => {
      const { roomId, playerId } = socket.data;
      if (!roomId) return ack?.({ ok: false, code: 'NOT_IN_ROOM', msg: 'Join a room first' });
      try {
        const next = await store.update(roomId, (s) => {
          if (s.meta.hostId !== playerId) throw new Engine.GameError('NOT_HOST', 'Only host can start');
          return Engine.startGame(s);
        });
        await broadcast(next);
        startTimer(next);
        scheduleBotTurn(next);
        ack?.({ ok: true });
        console.log(`[game:start] ${roomId}`);
      } catch (e) { errAck(ack, e); }
    });

    // turn:roll ───────────────────────────────────────────────────────────────
    socket.on('turn:roll', async (_: unknown, ack) => {
      const { roomId, playerId } = socket.data;
      if (!roomId || !playerId) return ack?.({ ok: false, code: 'NOT_IN_ROOM', msg: 'Join a room first' });
      try {
        let rollResult: ReturnType<typeof Engine.roll>['roll'] | undefined;
        const next = await store.update(roomId, (s) => {
          const { state, roll } = Engine.roll(s, playerId);
          rollResult = roll;
          return state;
        });

        scheduler.clear(roomId);

        // 현재 플레이어에게만 굴림 결과 전달
        socket.emit('turn:rolled', { roll: rollResult });
        socket.to(roomId).emit('turn:rolling', { playerId });
        await broadcast(next);

        // CHOOSING 단계 타이머
        scheduler.start(roomId, playerId, next.meta.turnSeq, next.config.turnTimeMs);
        ack?.({ ok: true, data: { roll: rollResult } });
      } catch (e) { errAck(ack, e); }
    });

    // turn:bet ────────────────────────────────────────────────────────────────
    socket.on('turn:bet', async ({ pip, diceType }: { pip: number; diceType: 'own' | 'white' }, ack) => {
      const { roomId, playerId } = socket.data;
      if (!roomId || !playerId) return ack?.({ ok: false, code: 'NOT_IN_ROOM', msg: 'Join a room first' });
      if (!Number.isInteger(pip) || pip < 1 || pip > 6) return ack?.({ ok: false, code: 'INVALID_PIP', msg: 'pip must be 1-6' });
      if (diceType !== 'own' && diceType !== 'white') return ack?.({ ok: false, code: 'INVALID_TYPE', msg: 'diceType must be own or white' });

      try {
        let settling = false;
        const pipVal = pip as PipValue;

        const next = await store.update(roomId, (s) => {
          if (!s.currentRoll) throw new Engine.GameError('NO_ROLL', 'Roll first');
          const own   = diceType === 'own'   ? s.currentRoll.ownPips[pipVal]   : 0;
          const white = diceType === 'white' ? s.currentRoll.whitePips[pipVal] : 0;
          if (own + white === 0) throw new Engine.GameError('EMPTY_PIP', 'No dice of that type showing that pip');
          const result = Engine.applyBet(s, playerId, pipVal, own, white);
          settling = result.phase === 'SETTLING';
          return result;
        });

        scheduler.clear(roomId);
        await broadcast(next);
        ack?.({ ok: true });

        if (settling) {
          await runSettlement(roomId);
        } else if (next.phase === 'ROLLING') {
          startTimer(next);
          scheduleBotTurn(next);
        }
      } catch (e) { errAck(ack, e); }
    });

    // game:reset ──────────────────────────────────────────────────────────────
    socket.on('game:reset', async (_: unknown, ack) => {
      const { roomId, playerId } = socket.data;
      if (!roomId) return ack?.({ ok: false, code: 'NOT_IN_ROOM', msg: 'Join a room first' });
      try {
        const next = await store.update(roomId, (s) => {
          if (s.meta.hostId !== playerId) throw new Engine.GameError('NOT_HOST', 'Only host can reset');
          return Engine.resetGame(s);
        });
        scheduler.clear(roomId);
        io.to(roomId).emit('state:update', Engine.publicView(next));
        ack?.({ ok: true });
        console.log(`[game:reset] ${roomId}`);
      } catch (e) { errAck(ack, e); }
    });

    // bot:add ─────────────────────────────────────────────────────────────────
    socket.on('bot:add', async (_: unknown, ack) => {
      const { roomId, playerId } = socket.data;
      if (!roomId) return ack?.({ ok: false, code: 'NOT_IN_ROOM', msg: 'Join a room first' });
      try {
        const next = await store.update(roomId, (s) => {
          if (s.meta.hostId !== playerId) throw new Engine.GameError('NOT_HOST', 'Only host can add bots');
          return Engine.addBot(s, uuidv4());
        });
        io.to(roomId).emit('state:update', Engine.publicView(next));
        ack?.({ ok: true });
      } catch (e) { errAck(ack, e); }
    });

    // room:state (재접속 후 상태 동기화) ─────────────────────────────────────
    socket.on('room:state', async ({ roomId: rid }: { roomId: string }, ack) => {
      try {
        const state = await store.load(rid?.trim().toUpperCase());
        if (!state) return ack?.({ ok: false, code: 'ROOM_NOT_FOUND', msg: 'Room not found' });
        const pid = socket.data.playerId as string | undefined;
        ack?.({ ok: true, data: pid ? Engine.privateView(state, pid) : Engine.publicView(state) });
      } catch (e) { errAck(ack, e); }
    });

    // chat:message ────────────────────────────────────────────────────────────
    socket.on('chat:message', async ({ text }: { text: string }, ack) => {
      const { roomId, playerId } = socket.data;
      if (!roomId || !playerId) return ack?.({ ok: false, code: 'NOT_IN_ROOM', msg: 'Join a room first' });
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!trimmed || trimmed.length > 200) return ack?.({ ok: false, code: 'INVALID_MSG', msg: 'Message must be 1-200 chars' });
      try {
        const state = await store.load(roomId);
        const player = state?.players.find(p => p.id === playerId);
        io.to(roomId).emit('chat:message', {
          playerId,
          nickname: player?.nickname ?? '?',
          color:    player?.color    ?? '#aaa',
          text:     trimmed,
          ts:       Date.now(),
        });
        ack?.({ ok: true });
      } catch (e) { errAck(ack, e); }
    });

    // disconnect ──────────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      const { roomId, playerId } = socket.data;
      console.log(`[-] ${socket.id} player=${playerId}`);
      if (!roomId || !playerId) return;
      try {
        await store.update(roomId, (s) => ({
          ...s,
          players: s.players.map(p => p.id === playerId ? { ...p, connected: false } : p),
        }));
        io.to(roomId).emit('player:disconnected', { playerId });
      } catch { /* 방이 없을 수 있음 */ }
    });
  });

  return scheduler;
}

function validNick(n: unknown): n is string {
  return typeof n === 'string' && n.trim().length >= 1 && n.trim().length <= MAX_NICKNAME;
}
