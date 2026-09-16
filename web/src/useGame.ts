import { startTransition, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { Game, FPS, refreshPlacement } from '../../shared/game.ts';
import type { Action, GameView } from '../../shared/game.ts';
import { costForUsage, emptyMetrics, MCP_LOOKUP_TIMEOUT_MS } from '../../shared/protocol.ts';
import type { AiOptions, ClientEvents, Insight, InputAck, InputBatch, JoinResult, Metrics, PlayerUsage, Reply, RoomResetMode, RoomView, ServerEvents, TokenAllowance } from '../../shared/protocol.ts';

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
    if (typeof saved?.cache === 'boolean' && typeof saved?.compression === 'boolean') return { cache: saved.cache, compression: saved.compression, reasoning: saved.reasoning === true, mcp: saved.mcp === true };
  } catch { return { cache: false, compression: false, reasoning: false, mcp: false }; }
  return { cache: false, compression: false, reasoning: false, mcp: false };
}

export function useGame() {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [connected, setConnected] = useState(false);
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [player, setPlayer] = useState<{ id: string; name: string; tokenText: string } | null>(null);
  const [sessionName, setSessionName] = useState<string>();
  const [unmeteredRequests, setUnmeteredRequests] = useState(0);
  const [view, setView] = useState<GameView>(() => new Game('preview').view());
  const [metrics, setMetrics] = useState<Metrics>(emptyMetrics);
  const [allowance, setAllowance] = useState<TokenAllowance | null>(null);
  const [insight, setInsight] = useState<Insight | null>(null);
  const [requestHistory, setRequestHistory] = useState<RequestRecord[]>([]);
  const historyPlayer = useRef('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [options, updateOptions] = useState<AiOptions>(savedOptions);
  const [autopilot, setAutopilot] = useState(false);
  const [autopilotStatus, setAutopilotStatus] = useState<'retrying' | 'blocked' | null>(null);
  const [inspectionPaused, setInspectionPaused] = useState(false);
  const [requestOptions, setRequestOptions] = useState<AiOptions | null>(null);
  const [resetVersion, setResetVersion] = useState(0);
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
  const retryCount = useRef(0);
  const pilotBlocked = useRef(false);
  const inspection = useRef(false);

  useEffect(() => {
    try { sessionStorage.setItem('tetris-luna-options', JSON.stringify(options)); } catch { return; }
  }, [options]);

  function refresh() { if (game.current) setView(game.current.view()); }

  function clearRetry() {
    retryCount.current = 0;
    pilotBlocked.current = false;
    setAutopilotStatus(null);
  }

  function stopAutopilot() {
    pilotActive.current = false;
    pilotEpoch.current += 1;
    setAutopilot(false);
    clearRetry();
  }

  function retryAutopilot() {
    if (!pilotActive.current) return;
    clearRetry();
    nextRequestAt.current = 0;
    setNotice('');
  }

  function setOptions(next: SetStateAction<AiOptions>) {
    updateOptions(next);
    retryAutopilot();
  }

  function pauseForInspection() {
    inspection.current = true;
    setInspectionPaused(true);
    pilotEpoch.current += 1;
    if (game.current?.status === 'playing') { game.current.act('pause'); refresh(); void flush(); }
  }

  function resumeAfterInspection() {
    inspection.current = false;
    setInspectionPaused(false);
  }

  async function prepareMaintenance() {
    toggleAutopilot(false);
    pauseForInspection();
    return !active.current || await flushAll();
  }

  function clearRoomSession(mode: RoomResetMode) {
    stopAutopilot();
    requestSerial.current += 1;
    requestPending.current = false;
    active.current = false;
    joiningRef.current = false;
    joinFailed.current = true;
    runId.current = '';
    sequence.current = 0;
    sentEvents.current = 0;
    pendingBatch.current = null;
    sending.current = null;
    game.current = null;
    historyPlayer.current = '';
    resumeAfterInspection();
    setJoined(false);
    setJoining(false);
    setPlayer(null);
    setBusy(false);
    setRequestOptions(null);
    setInsight(null);
    setRequestHistory([]);
    setView(new Game('preview').view());
    setResetVersion(version => version + 1);
    if (mode === 'all') {
      session.current = null;
      setSessionName(undefined);
      setMetrics(emptyMetrics());
      setAllowance(null);
      setUnmeteredRequests(0);
      try { sessionStorage.removeItem('tokenfall-session'); } catch { return; }
    }
  }

  function deferAutopilot(message: string, retryable = true, retryAfterMs = 0) {
    if (!pilotActive.current) return;
    retryCount.current += 1;
    if (!retryable || retryCount.current > 3) {
      pilotBlocked.current = true;
      setAutopilotStatus('blocked');
      setNotice(`${message} Luna is paused${retryable ? ' after repeated errors' : ''}.`);
      return;
    }
    const delay = Math.max(retryAfterMs, 2000 * 2 ** (retryCount.current - 1));
    nextRequestAt.current = Date.now() + delay;
    setAutopilotStatus('retrying');
    setNotice(`${message} Retrying in ${Math.ceil(delay / 1000)}s.`);
  }

  function installSession(data: JoinResult) {
    if (historyPlayer.current !== data.playerId || runId.current !== data.runId) stopAutopilot();
    else pilotEpoch.current += 1;
    requestSerial.current += 1;
    requestPending.current = false;
    setBusy(false);
    setRequestOptions(null);
    game.current = Game.restore(data.replay);
    if (game.current.status === 'over') stopAutopilot();
    else if (pilotActive.current && game.current.status === 'playing') game.current.act('pause');
    runId.current = data.runId;
    sequence.current = data.sequence;
    sentEvents.current = data.replay.events.length;
    pendingBatch.current = null;
    sending.current = null;
    active.current = true;
    joiningRef.current = false;
    setPlayer({ id: data.playerId, name: data.name, tokenText: data.tokenText });
    setSessionName(data.name);
    setUnmeteredRequests(data.unmeteredRequests);
    setMetrics(data.metrics);
    setAllowance(data.allowance ?? null);
    if (historyPlayer.current !== data.playerId) setRequestHistory([]);
    historyPlayer.current = data.playerId;
    setJoined(true);
    setJoining(false);
    setInsight(null);
    refresh();
  }

  function join(setup?: { name: string; text?: string; tokenLimit?: number }) {
    if (!roomRef.current || !socket.current?.connected || active.current || joiningRef.current) return;
    const code = roomRef.current.code;
    const previous = session.current?.room === code ? session.current : null;
    if (!previous && !setup) return;
    joiningRef.current = true;
    joinFailed.current = false;
    setJoining(true);
    setNotice('');
    const name = previous?.name ?? setup!.name.trim();
    socket.current.timeout(8000).emit('join', { name, room: code, ...(previous ? { token: previous.token } : { tokenLimit: setup?.tokenLimit, ...(setup?.text !== undefined ? { text: setup.text } : {}) }) }, (error: Error | null, reply: Reply<JoinResult>) => {
      joiningRef.current = false;
      setJoining(false);
      if (error || !reply.ok) {
        joinFailed.current = true;
        setNotice(!error && !reply.ok ? reply.error : 'Could not connect. Join again to retry.');
        if (!error && !reply.ok && reply.code === 'session') {
          clearRoomSession('all');
          joinFailed.current = false;
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
    pilotEpoch.current += 1;
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
    clearRetry();
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
    if (requestPending.current || pilotBlocked.current || inspection.current || Date.now() < nextRequestAt.current || !pilotActive.current || document.hidden || !game.current || !active.current || !socket.current?.connected) return;
    if (game.current.status === 'over') { stopAutopilot(); return; }
    requestPending.current = true;
    const serial = ++requestSerial.current;
    const epoch = pilotEpoch.current;
    const originalRun = runId.current;
    const selected = { cache: options.cache, compression: options.compression, reasoning: Boolean(options.reasoning), mcp: Boolean(options.mcp), autopilot: true };
    setRequestOptions(selected);
    setBusy(true);
    if (!await flushAll() || serial !== requestSerial.current || originalRun !== runId.current || !pilotActive.current || epoch !== pilotEpoch.current || document.hidden || inspection.current) {
      if (serial === requestSerial.current) { requestPending.current = false; setBusy(false); setRequestOptions(null); }
      return;
    }
    nextRequestAt.current = Date.now() + (roomRef.current?.autopilotCooldownMs ?? 1000);
    socket.current!.timeout((selected.reasoning ? 65000 : 25000) + (selected.mcp ? MCP_LOOKUP_TIMEOUT_MS : 0)).emit('assist', selected, (error: Error | null, reply: Reply<{ insight: Insight } & PlayerUsage>) => {
      if (serial !== requestSerial.current) return;
      requestPending.current = false;
      setRequestOptions(null);
      setBusy(false);
      const currentPilot = pilotActive.current && epoch === pilotEpoch.current && originalRun === runId.current;
      if (error) { if (currentPilot) deferAutopilot('Luna timed out. Any provider charges will still be recorded.'); return; }
      if (!reply.ok) {
        if (!currentPilot) return;
        if (reply.code === 'busy' || reply.code === 'cooldown') {
          nextRequestAt.current = Date.now() + Math.max(1000, reply.retryAfterMs ?? 0);
          setAutopilotStatus('retrying');
        } else deferAutopilot(reply.error, ['mcp', 'unavailable', 'rate'].includes(reply.code ?? ''), reply.retryAfterMs);
        return;
      }
      setMetrics(reply.data.metrics);
      setAllowance(reply.data.allowance ?? null);
      setUnmeteredRequests(reply.data.unmeteredRequests);
      const result = reply.data.insight;
      const record = { number: reply.data.metrics.requests, receivedAt: new Date().toISOString(), insight: result };
      setRequestHistory(history => [record, ...history.filter(entry => entry.insight.id !== result.id)].slice(0, 20));
      const current = originalRun === runId.current && result.pieceId === game.current?.pieceId;
      setInsight(current ? result : { ...result, status: 'stale' });
      if (currentPilot && !document.hidden && !inspection.current) {
        if (!current || !applyMove(result)) { deferAutopilot(result.status === 'invalid' ? result.tip : 'Luna returned an unusable move. Manual play is still available.'); return; }
        clearRetry();
        setNotice('');
        if (game.current?.status === 'over') stopAutopilot();
      }
    });
  }

  async function restart(text?: string, tokenLimit?: number): Promise<boolean> {
    if (!socket.current?.connected || !active.current || requestPending.current || joiningRef.current) return false;
    stopAutopilot();
    if (!await flushAll()) return false;
    joiningRef.current = true;
    setJoining(true);
    return new Promise(resolve => {
      const receive = (error: Error | null, reply: Reply<JoinResult>) => {
        joiningRef.current = false;
        setJoining(false);
        if (error || !reply.ok) { setNotice(!error && !reply.ok ? reply.error : 'Could not start a new game. Try again.'); resolve(false); return; }
        installSession(reply.data);
        setNotice('');
        resolve(true);
      };
      if (text === undefined) socket.current!.timeout(8000).emit('restart', receive);
      else socket.current!.timeout(8000).emit('configure', { text, tokenLimit }, receive);
    });
  }

  async function adjustAllowance(tokenLimit: number): Promise<boolean> {
    if (!socket.current?.connected || !active.current || joiningRef.current) return false;
    pauseForInspection();
    joiningRef.current = true;
    setJoining(true);
    return new Promise(resolve => {
      socket.current!.timeout(8000).emit('allowance', { tokenLimit }, (error: Error | null, reply: Reply<PlayerUsage>) => {
        joiningRef.current = false;
        setJoining(false);
        if (error || !reply.ok) { setNotice(!error && !reply.ok ? reply.error : 'Could not update the allowance. Try again.'); resolve(false); return; }
        setAllowance(reply.data.allowance);
        setMetrics(reply.data.metrics);
        setUnmeteredRequests(reply.data.unmeteredRequests);
        retryAutopilot();
        setNotice('');
        resolve(true);
      });
    });
  }

  const onJoin = useEffectEvent(join);
  const onFlush = useEffectEvent(flush);
  const onPilotStep = useEffectEvent(requestMove);
  const onRoomReset = useEffectEvent((reset: { mode: RoomResetMode }) => {
    clearRoomSession(reset.mode);
    setNotice(reset.mode === 'all' ? 'Room history cleared. Join again for a new game.' : 'Scores cleared. Rejoin for a new game; AI usage was retained.');
  });

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
      pilotEpoch.current += 1;
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
      setSessionName(session.current?.room === nextRoom.code ? session.current.name : undefined);
      startTransition(() => setRoom(nextRoom));
      if (session.current?.room === nextRoom.code && !active.current && !joiningRef.current && !joinFailed.current) onJoin();
    });
    connection.on('usage', usage => {
      if (!active.current) return;
      setMetrics(current => usage.metrics.requests >= current.requests ? usage.metrics : current);
      setUnmeteredRequests(usage.unmeteredRequests);
      setAllowance(current => !current || (usage.allowance && usage.allowance.used >= current.used) ? usage.allowance ?? null : current);
    });
    connection.on('notice', setNotice);
    connection.on('roomReset', onRoomReset);
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
      if (document.hidden) {
        pilotEpoch.current += 1;
        if (game.current?.status === 'playing') { game.current.act('pause'); refresh(); void onFlush(); }
      }
    };
    document.addEventListener('visibilitychange', visibility);
    return () => { cancelAnimationFrame(request); document.removeEventListener('visibilitychange', visibility); };
  }, []);

  const rates = room?.pricing.snapshot?.usdPerMillion;
  const cost = rates ? costForUsage(metrics, rates) : null;
  return { room, connected, joined, joining, player, sessionName, view, metrics, allowance, adjustAllowance, insight, requestHistory, cost, busy, notice, setNotice, options, setOptions, autopilot, autopilotStatus, inspectionPaused, pauseForInspection, resumeAfterInspection, prepareMaintenance, resetVersion, retryAutopilot, toggleAutopilot, requestOptions, unmeteredRequests, join, act, restart };
}