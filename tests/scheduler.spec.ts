import { TurnScheduler } from '../src/engine/TurnScheduler';

jest.useFakeTimers();

describe('TurnScheduler', () => {
  afterEach(() => {
    jest.clearAllTimers();
  });

  it('지정한 ms 후 정확히 1회 호출된다', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const s = new TurnScheduler(handler);

    s.start('R1', 'P1', 1, 30_000);
    jest.advanceTimersByTime(29_999);
    expect(handler).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await Promise.resolve(); // flush microtasks
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ roomId: 'R1', playerId: 'P1', turnSeq: 1 });
  });

  it('clear() 후에는 호출되지 않는다', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const s = new TurnScheduler(handler);

    s.start('R1', 'P1', 1, 30_000);
    s.clear('R1');
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
  });

  it('start()를 다시 호출하면 이전 타이머는 취소된다', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const s = new TurnScheduler(handler);

    s.start('R1', 'P1', 1, 30_000);
    jest.advanceTimersByTime(15_000);

    s.start('R1', 'P2', 2, 30_000); // 새 턴
    jest.advanceTimersByTime(20_000); // 이전 타이머 만료 구간 통과
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled(); // 이전 타이머는 취소됨

    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ roomId: 'R1', playerId: 'P2', turnSeq: 2 });
  });

  it('resume(): 남은 시간만큼 카운트한 뒤 호출된다', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const s = new TurnScheduler(handler);

    const deadline = Date.now() + 10_000;
    s.resume('R1', 'P1', 5, deadline);

    jest.advanceTimersByTime(9_999);
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await Promise.resolve();
    expect(handler).toHaveBeenCalledWith({ roomId: 'R1', playerId: 'P1', turnSeq: 5 });
  });

  it('이미 지난 deadline 으로 resume 하면 setImmediate 후 즉시 호출된다', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const s = new TurnScheduler(handler);

    s.resume('R1', 'P1', 3, Date.now() - 100);

    jest.runAllTimers();
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('getDeadline()은 active 타이머의 deadline 을 반환한다', () => {
    const s = new TurnScheduler(jest.fn());
    const before = Date.now();
    s.start('R1', 'P1', 1, 10_000);
    const d = s.getDeadline('R1');
    expect(d).toBeGreaterThanOrEqual(before + 9_990);
    s.clear('R1');
    expect(s.getDeadline('R1')).toBeNull();
  });

  it('에러 핸들러가 emit error 를 받는다', async () => {
    const boom = new Error('boom');
    const handler = jest.fn().mockRejectedValue(boom);
    const s = new TurnScheduler(handler);
    const errSpy = jest.fn();
    s.on('error', errSpy);

    s.start('R1', 'P1', 1, 100);
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve(); // handler rejection propagation
    expect(errSpy).toHaveBeenCalledWith(boom);
  });
});
