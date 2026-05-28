import { EventEmitter } from 'events';

export interface TimeoutPayload {
  roomId: string;
  playerId: string;
  turnSeq: number;
}

type Handler = (p: TimeoutPayload) => Promise<void>;

interface Entry {
  deadline: number;
  playerId: string;
  turnSeq: number;
}

export class TurnScheduler extends EventEmitter {
  private timers    = new Map<string, NodeJS.Timeout>();
  private deadlines = new Map<string, Entry>();

  constructor(private onTimeout: Handler) { super(); }

  start(roomId: string, playerId: string, turnSeq: number, durationMs: number): number {
    this.clear(roomId);
    const deadline = Date.now() + durationMs;
    this.deadlines.set(roomId, { deadline, playerId, turnSeq });
    this._set(roomId, durationMs);
    return deadline;
  }

  resume(roomId: string, playerId: string, turnSeq: number, deadline: number): void {
    this.clear(roomId);
    this.deadlines.set(roomId, { deadline, playerId, turnSeq });
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      setImmediate(() => this._fire(roomId));
    } else {
      this._set(roomId, remaining);
    }
  }

  clear(roomId: string): void {
    const t = this.timers.get(roomId);
    if (t) clearTimeout(t);
    this.timers.delete(roomId);
    this.deadlines.delete(roomId);
  }

  getDeadline(roomId: string): number | null {
    return this.deadlines.get(roomId)?.deadline ?? null;
  }

  private _set(roomId: string, ms: number): void {
    const t = setTimeout(() => this._fire(roomId), Math.max(0, ms));
    this.timers.set(roomId, t);
  }

  private async _fire(roomId: string): Promise<void> {
    const entry = this.deadlines.get(roomId);
    this.timers.delete(roomId);
    this.deadlines.delete(roomId);
    if (!entry) return;
    try {
      await this.onTimeout({ roomId, playerId: entry.playerId, turnSeq: entry.turnSeq });
      this.emit('timeout', { roomId, ...entry });
    } catch (e) {
      this.emit('error', e);
    }
  }
}
