import { startTransition, useEffect, useEffectEvent, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { Game, FPS, refreshPlacement } from '../../shared/game.ts';
import type { Action, GameView } from '../../shared/game.ts';
import { costForUsage, emptyMetrics } from '../../shared/protocol.ts';
import type { AiOptions, ClientEvents, Insight, InputAck, InputBatch, JoinResult, Metrics, Reply, RoomView, ServerEvents } from '../../shared/protocol.ts';

type GameSocket = Socket<ServerEvents, ClientEvents>;
interface Session { token: string; name: string; room: string }
export interface RequestRecord { number: number; receivedAt: string; insight: Insight }

function savedSession(): Session | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem('tokenfall-session') ?? 'null');
    return typeof saved?.token === 'string' && /^[a-f0-9]{64}$/.test(saved.token) && typeof saved.name === 'string' && typeof saved.room === 'string' ? saved : null;
  } catch { return null; }
}

function savedOptions(): AiOptions {
  try {
    const saved = JSON.parse(sessionStorage.getItem('tetris-luna-options') ?? 'null');
    if (typeof saved?.cache === 'boolean' && typeof saved?.compression === 'boolean') return { cache: saved.cache, compression: saved.compression };
  } catch { return { cache: false, compression: false }; }
  return { cache: false, compression: false };
}

export function useGame() {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [connected, setConnected] = useState(false);
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [unmeteredRequests, setUnmeteredRequests] = useState(0);
  const [view, setView] = useState<GameView>(() => new Game('preview').view());
  const [metrics, setMetrics] = useState<Metrics>(emptyMetrics);
  const [insight, setInsight] = useState<Insight | null>(null);
  const [requestHistory, setRequestHistory] = useState<RequestRecord[]>([]);
  const historyPlayer = useRef('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [options, setOptions] = useState<AiOptions>(savedOptions);
  const [autopilot, setAutopilot] = useState(false);
  const [requestOptions, setRequestOptions] = useState<AiOptions | null>(null);
  const socket = useRef<GameSocket | null>(null);
  const game = useRef<Game | null>(null);
  const roomRef = useRef<RoomView | null>(null);
  const session = useRef(savedSession());
  const joiningRef = useRef(false);
  const joinFailed = useRef(false);
  const active = useRef(false);
  const runId = useRef('');
  const sequence = useRef(0);
  const sentEvents = useRef(0);
  const pendingBatch = useRef<InputBatch | null>(null);
  const sending = useRef<Promise<boolean> | null>(null);
  const batchAt = useRef(0);
  const pilotActive = useRef(false);
  const pilotEpoch = useRef(0);
  const requestPending = useRef(false);
  const requestSerial = useRef(0);
  const nextRequestAt = useRef(0);

  useEffect(() => {
    try { sessionStorage.setItem('tetris-luna-options', JSON.stringify(options)); } catch { return; }
  }, [options]);

  function refresh() { if (game.current) setView(game.current.view()); }

  function stopAutopilot() {
    pilotActive.current = false;
    pilotEpoch.current += 1;
    setAutopilot(false);
  }

  function installSession(data: JoinResult) {
    stopAutopilot();
    requestSerial.current += 1;
    requestPending.current = false;
    setBusy(false);
    setRequestOptions(null);
    game.current = Game.restore(data.replay);
    runId.current = data.runId;
    sequence.current = data.sequence;
    sentEvents.current = data.replay.events.length;
    pendingBatch.current = null;
    sending.current = null;
    active.current = true;
    joiningRef.current = false;
    setUnmeteredRequests(data.unmeteredRequests);
    setMetrics(data.metrics);
    if (historyPlayer.current !== data.playerId) setRequestHistory([]);
    historyPlayer.current = data.playerId;
    setJoined(true);
    setJoining(false);
    setInsight(null);
    refresh();
  }

  function join() {
    if (!roomRef.current || !socket.current?.connected || active.current || joiningRef.current) return;
    joiningRef.current = true;
    joinFailed.current = false;
    setJoining(true);
    setNotice('');
    const code = roomRef.current.code;
    const previous = session.current?.room === code ? session.current : null;
    const name = previous?.name ?? `Player ${crypto.randomUUID().slice(0, 6)}`;
    socket.current.timeout(8000).emit('join', { name, room: code, classic: true, ...(previous ? { token: previous.token } : {}) }, (error: Error | null, reply: Reply<JoinResult>) => {
      joiningRef.current = false;
      setJoining(false);
      if (error || !reply.ok) {
        joinFailed.current = true;
        setNotice(!error && !reply.ok ? reply.error : 'Could not connect. Press Play to retry.');
        if (!error && !reply.ok && reply.code === 'session') {
          session.current = null;
          joinFailed.current = false;
          try { sessionStorage.removeItem('tokenfall-session'); } catch { return; }
        }
        return;
      }
      installSession(reply.data);
      session.current = { token: reply.data.token, name: reply.data.name, room: code };
      try { sessionStorage.setItem('tokenfall-session', JSON.stringify(session.current)); } catch { return; }
    });
  }

  function resync(message: string) {
    if (!active.current) return;
    stopAutopilot();
    active.current = false;
    setNotice(message);
    socket.current?.disconnect().connect();
  }

  function flush(): Promise<boolean> {
    if (!active.current || !socket.current?.connected || !game.current) return Promise.resolve(false);
    if (sending.current) return sending.current;
    if (!pendingBatch.current) {
      const events = game.current.events.slice(sentEvents.current, sentEvents.current + 64);
      const hasMore = sentEvents.current + events.length < game.current.events.length;
      const frame = hasMore ? events[events.length - 1]?.frame ?? game.current.frame : game.current.frame;
      pendingBatch.current = { runId: runId.current, sequence: sequence.current + 1, frame, events };
    }
    const batch = pendingBatch.current;
    batchAt.current = performance.now();
    const pending = new Promise<boolean>(resolve => {
      socket.current!.timeout(5000).emit('inputs', batch, (error: Error | null, reply: Reply<InputAck>) => {
        if (runId.current !== batch.runId) { resolve(false); return; }
        sending.current = null;
        if (error || !reply.ok) { resync(!error && !reply.ok ? reply.error : 'Reconnecting to your game.'); resolve(false); return; }
        sentEvents.current += batch.events.length;
        sequence.current = reply.data.sequence;
        pendingBatch.current = null;
        resolve(true);
      });
    });
    sending.current = pending;
    return pending;
  }

  async function flushAll() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!await flush()) return false;
      if (game.current && sentEvents.current >= game.current.events.length) return true;
    }
    return false;
  }

  function act(action: Action) {
    if (!active.current || !game.current || !socket.current?.connected) return;
    if (pilotActive.current) {
      if (action !== 'pause') return;
      stopAutopilot();
    }
    if (game.current.act(action)) refresh();
    if (['hardDrop', 'hold', 'pause', 'resume'].includes(action)) void flush();
  }

  function toggleAutopilot(enabled: boolean) {
    if (!enabled) {
      stopAutopilot();
      if (game.current?.status === 'playing') act('pause');
      if (requestPending.current) setNotice('Luna stopped. The pending request can still be charged.');
      return;
    }
    if (!active.current || !socket.current?.connected || !game.current || game.current.status === 'over') return;
    pilotEpoch.current += 1;
    pilotActive.current = true;
    setAutopilot(true);
    setNotice('');
    if (game.current.status === 'playing') game.current.act('pause');
    refresh();
    void flush();
  }

  function applyMove(result: Insight) {
    if (!result.placement || !game.current || !active.current || !socket.current?.connected || game.current.status === 'over' || result.status !== 'ready' || result.pieceId !== game.current.pieceId) return false;
    const placement = refreshPlacement(game.current, result.placement);
    if (!placement) return false;
    if (game.current.status === 'paused') game.current.act('resume');
    for (const action of placement.path) game.current.act(action);
    if (game.current.view().status !== 'over') game.current.act('pause');
    setInsight({ ...result, status: 'stale' });
    refresh();
    void flush();
    return true;
  }

  async function requestMove() {
    if (requestPending.current || Date.now() < nextRequestAt.current || !pilotActive.current || document.hidden || !game.current || !active.current || !socket.current?.connected) return;
    if (game.current.status === 'over') { stopAutopilot(); return; }
    requestPending.current = true;
    const serial = ++requestSerial.current;
    const epoch = pilotEpoch.current;
    const originalRun = runId.current;
    const selected = { cache: options.cache, compression: options.compression, autopilot: true };
    setRequestOptions(selected);
    setBusy(true);
    if (!await flushAll() || serial !== requestSerial.current || originalRun !== runId.current || !pilotActive.current || epoch !== pilotEpoch.current) {
      if (serial === requestSerial.current) { requestPending.current = false; setBusy(false); setRequestOptions(null); }
      return;
    }
    nextRequestAt.current = Date.now() + (roomRef.current?.autopilotCooldownMs ?? 1000);
    socket.current!.timeout(25000).emit('assist', selected, (error: Error | null, reply: Reply<{ insight: Insight; metrics: Metrics }>) => {
      if (serial !== requestSerial.current) return;
      requestPending.current = false;
      setRequestOptions(null);
      setBusy(false);
      if (error) { stopAutopilot(); setNotice('Luna timed out. Any provider charges will still be recorded.'); return; }
      if (!reply.ok) {
        if (reply.retryAfterMs) nextRequestAt.current = Date.now() + reply.retryAfterMs;
        if (reply.code !== 'busy' && reply.code !== 'cooldown') { stopAutopilot(); setNotice(reply.error); }
        return;
      }
      setMetrics(reply.data.metrics);
      const result = reply.data.insight;
      const record = { number: reply.data.metrics.requests, receivedAt: new Date().toISOString(), insight: result };
      setRequestHistory(history => [record, ...history.filter(entry => entry.insight.id !== result.id)].slice(0, 20));
      const current = originalRun === runId.current && result.pieceId === game.current?.pieceId;
      setInsight(current ? result : { ...result, status: 'stale' });
      if (pilotActive.current && epoch === pilotEpoch.current && !document.hidden) {
        if (!current || !applyMove(result)) { stopAutopilot(); setNotice('Luna returned an unusable move. Manual play is still available.'); return; }
        if (game.current?.status === 'over') stopAutopilot();
      }
    });
  }

  async function restart() {
    if (!socket.current?.connected || !active.current || requestPending.current || joiningRef.current) return;
    stopAutopilot();
    if (!await flushAll()) return;
    joiningRef.current = true;
    setJoining(true);
    socket.current.timeout(8000).emit('restart', (error: Error | null, reply: Reply<JoinResult>) => {
      joiningRef.current = false;
      setJoining(false);
      if (error || !reply.ok) { setNotice(!error && !reply.ok ? reply.error : 'Could not start a new game. Try again.'); return; }
      installSession(reply.data);
      setNotice('');
    });
  }

  const onJoin = useEffectEvent(join);
  const onFlush = useEffectEvent(flush);
  const onAct = useEffectEvent(act);
  const onStop = useEffectEvent(stopAutopilot);
  const onPilotStep = useEffectEvent(requestMove);

  useEffect(() => {
    const timer = setInterval(() => void onPilotStep(), 100);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const connection: GameSocket = io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 750, reconnectionDelayMax: 4000 });
    socket.current = connection;
    connection.on('connect', () => { setConnected(true); joiningRef.current = false; joinFailed.current = false; });
    connection.on('connect_error', () => setConnected(false));
    connection.on('disconnect', () => {
      onStop();
      requestSerial.current += 1;
      requestPending.current = false;
      joiningRef.current = false;
      active.current = false;
      setRequestOptions(null);
      setConnected(false);
      setJoined(false);
      setBusy(false);
      setJoining(false);
      if (game.current?.status === 'playing') game.current.act('pause');
      refresh();
    });
    connection.on('room', nextRoom => {
      roomRef.current = nextRoom;
      startTransition(() => setRoom(nextRoom));
      if (!active.current && !joiningRef.current && !joinFailed.current) onJoin();
    });
    connection.on('usage', usage => {
      setMetrics(current => usage.metrics.requests >= current.requests ? usage.metrics : current);
      setUnmeteredRequests(usage.unmeteredRequests);
    });
    connection.on('notice', setNotice);
    return () => { active.current = false; pilotActive.current = false; pilotEpoch.current += 1; connection.disconnect(); socket.current = null; };
  }, []);

  useEffect(() => {
    let request = 0;
    let previous = performance.now();
    let accumulator = 0;
    const animate = (now: number) => {
      const elapsed = Math.min(100, Math.max(0, now - previous));
      previous = now;
      if (game.current && active.current && !document.hidden) {
        accumulator += elapsed;
        let updated = false;
        while (accumulator >= 1000 / FPS) { game.current.tick(); accumulator -= 1000 / FPS; updated = true; }
        if (updated) refresh();
        if (now - batchAt.current >= 400) void onFlush();
      } else accumulator = 0;
      request = requestAnimationFrame(animate);
    };
    request = requestAnimationFrame(animate);
    const visibility = () => {
      previous = performance.now();
      accumulator = 0;
      if (document.hidden) { onStop(); if (game.current?.status === 'playing') onAct('pause'); }
    };
    document.addEventListener('visibilitychange', visibility);
    return () => { cancelAnimationFrame(request); document.removeEventListener('visibilitychange', visibility); };
  }, []);

  const rates = room?.pricing.snapshot?.usdPerMillion;
  const cost = rates ? costForUsage(metrics, rates) : null;
  return { room, connected, joined, joining, view, metrics, insight, requestHistory, cost, busy, notice, setNotice, options, setOptions, autopilot, toggleAutopilot, requestOptions, unmeteredRequests, join, act, restart };
}