import { startTransition, useEffect, useEffectEvent, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { Game, FPS, refreshPlacement } from '../../shared/game.ts';
import type { Action, GameView } from '../../shared/game.ts';
import { emptyMetrics } from '../../shared/protocol.ts';
import type { AiOptions, ClientEvents, Insight, InputAck, InputBatch, JoinResult, Metrics, Reply, RoomView, ServerEvents } from '../../shared/protocol.ts';

type GameSocket = Socket<ServerEvents, ClientEvents>;
interface Session { token: string; name: string; room: string }

function savedSession(): Session | null {
  try { return JSON.parse(sessionStorage.getItem('tokenfall-session') ?? 'null'); } catch { return null; }
}
function persistSession(session: Session) {
  try { sessionStorage.setItem('tokenfall-session', JSON.stringify(session)); } catch { return; }
}

export function useGame() {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [connected, setConnected] = useState(false);
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [name, setName] = useState(savedSession()?.name ?? '');
  const [playerId, setPlayerId] = useState('');
  const [view, setView] = useState<GameView>(() => new Game('lobby-preview').view());
  const [metrics, setMetrics] = useState<Metrics>(emptyMetrics);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [busy, setBusy] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [notice, setNotice] = useState('');
  const [options, setOptions] = useState<AiOptions>({ cache: true, compression: true });
  const socket = useRef<GameSocket | null>(null);
  const game = useRef<Game | null>(null);
  const roomRef = useRef<RoomView | null>(null);
  const runId = useRef('');
  const sequence = useRef(0);
  const sentEvents = useRef(0);
  const active = useRef(false);
  const pendingBatch = useRef<InputBatch | null>(null);
  const sending = useRef<Promise<boolean> | null>(null);
  const batchAt = useRef(0);
  const autoJoining = useRef(false);
  const reconnectMessage = useRef('');
  const currentInsight = insights[0] ?? null;
  const isProjector = new URLSearchParams(window.location.search).get('view') === 'room';

  function refresh() { if (game.current) setView(game.current.view()); }

  function installSession(data: JoinResult) {
    game.current = Game.restore(data.replay);
    runId.current = data.runId;
    sequence.current = data.sequence;
    sentEvents.current = data.replay.events.length;
    pendingBatch.current = null;
    sending.current = null;
    active.current = true;
    setPlayerId(data.playerId);
    setName(data.name);
    setMetrics(data.metrics);
    setJoined(true);
    setJoining(false);
    setInsights([]);
    refresh();
  }

  function resync(message: string) {
    if (!active.current) return;
    active.current = false;
    reconnectMessage.current = message;
    setNotice(message);
    socket.current?.disconnect().connect();
  }

  function flush(): Promise<boolean> {
    if (!active.current || !socket.current?.connected || !game.current) return Promise.resolve(false);
    if (sending.current) return sending.current;
    if (!pendingBatch.current) {
      const remaining = game.current.events.slice(sentEvents.current, sentEvents.current + 64);
      const hasMore = sentEvents.current + remaining.length < game.current.events.length;
      const frame = hasMore ? remaining[remaining.length - 1]?.frame ?? game.current.frame : game.current.frame;
      pendingBatch.current = { runId: runId.current, sequence: sequence.current + 1, frame, events: remaining };
    }
    const batch = pendingBatch.current;
    batchAt.current = performance.now();
    const promise = new Promise<boolean>(resolve => {
      socket.current!.timeout(5000).emit('inputs', batch, (error: Error | null, response: Reply<InputAck>) => {
        sending.current = null;
        if (error) { resync('Connection interrupted. Restoring your verified game.'); resolve(false); return; }
        if (!response.ok) { resync(response.error); resolve(false); return; }
        if (runId.current !== batch.runId) { resolve(false); return; }
        sentEvents.current += batch.events.length;
        sequence.current = response.data.sequence;
        pendingBatch.current = null;
        resolve(true);
      });
    });
    sending.current = promise;
    return promise;
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
    const accepted = game.current.act(action);
    if (accepted) refresh();
    if (action === 'hardDrop' || action === 'hold' || action === 'pause' || action === 'resume') void flush();
  }

  function join(session?: Session) {
    if (!roomRef.current || !socket.current?.connected) { setNotice('Waiting for the room connection.'); return; }
    const chosenName = (session?.name ?? name).trim();
    if (chosenName.length < 2 || chosenName.length > 16) { setNotice('Choose a name with 2 to 16 characters.'); return; }
    setJoining(true);
    setNotice('');
    const requestedCode = new URLSearchParams(window.location.search).get('room') ?? roomRef.current.code;
    socket.current.timeout(8000).emit('join', { name: chosenName, room: session?.room ?? requestedCode, ...(session ? { token: session.token } : {}) }, (error: Error | null, reply: Reply<JoinResult>) => {
      autoJoining.current = false;
      if (error) { setJoining(false); setNotice('The room did not answer. Try joining again.'); return; }
      if (!reply.ok) {
        setJoining(false);
        setNotice(reply.error);
        if (reply.code === 'session') { try { sessionStorage.removeItem('tokenfall-session'); } catch { return; } }
        return;
      }
      installSession(reply.data);
      persistSession({ token: reply.data.token, name: reply.data.name, room: session?.room ?? requestedCode });
      if (reconnectMessage.current) { setNotice('Your verified game is restored.'); reconnectMessage.current = ''; }
    });
  }

  async function assist() {
    if (busy || !game.current || !active.current) return;
    if (game.current.status === 'over') { setNotice('Start a new game before asking Luna.'); return; }
    setBusy(true);
    setNotice('');
    const originalRun = runId.current;
    if (!await flushAll()) { setBusy(false); return; }
    setCooldownUntil(Date.now() + 8000);
    socket.current!.timeout(25000).emit('assist', options, (error: Error | null, response: Reply<{ insight: Insight; metrics: Metrics }>) => {
      setBusy(false);
      if (error) { setNotice('Luna took too long. Keep playing; usage will sync with the room.'); return; }
      if (!response.ok) {
        setNotice(response.error);
        if (response.retryAfterMs) setCooldownUntil(Date.now() + response.retryAfterMs);
        return;
      }
      setMetrics(response.data.metrics);
      const insight = response.data.insight;
      if (originalRun !== runId.current || game.current?.pieceId !== insight.pieceId) insight.status = 'stale';
      setInsights(current => [insight, ...current].slice(0, 12));
    });
  }

  function applySuggestion() {
    if (!currentInsight?.placement || !game.current || game.current.status === 'over' || currentInsight.status !== 'ready') return;
    if (currentInsight.pieceId !== game.current.pieceId) { setNotice('That move belongs to a previous piece.'); return; }
    const refreshed = refreshPlacement(game.current, currentInsight.placement);
    if (!refreshed) { setNotice('That landing is no longer reachable.'); return; }
    const paused = game.current.status === 'paused';
    if (paused) game.current.act('resume');
    for (const action of refreshed.path) game.current.act(action);
    if (paused) game.current.act('pause');
    setInsights(current => current.map(insight => insight.id === currentInsight.id ? { ...insight, status: 'stale' } : insight));
    refresh();
    void flush();
  }

  async function restart() {
    if (!socket.current?.connected || !game.current || busy) return;
    if (!await flushAll()) return;
    socket.current.timeout(8000).emit('restart', (error: Error | null, response: Reply<JoinResult>) => {
      if (error) { setNotice('Could not restart. Check your connection.'); return; }
      if (!response.ok) { setNotice(response.error); return; }
      installSession(response.data);
      setNotice('');
    });
  }

  const onFlush = useEffectEvent(flush);
  const onAct = useEffectEvent(act);
  const onJoin = useEffectEvent(join);

  useEffect(() => {
    const connection: GameSocket = io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 750, reconnectionDelayMax: 4000 });
    socket.current = connection;
    connection.on('connect', () => { setConnected(true); autoJoining.current = false; });
    connection.on('connect_error', () => { setConnected(false); setNotice('Cannot reach the room. Reconnecting.'); });
    connection.on('disconnect', () => {
      active.current = false;
      setConnected(false);
      setJoined(false);
      setBusy(false);
      if (game.current?.status === 'playing') game.current.act('pause');
      refresh();
    });
    connection.on('room', nextRoom => {
      roomRef.current = nextRoom;
      startTransition(() => setRoom(nextRoom));
      const previous = savedSession();
      if (!isProjector && previous && previous.room === nextRoom.code && !active.current && !autoJoining.current) {
        autoJoining.current = true;
        onJoin(previous);
      }
    });
    connection.on('notice', setNotice);
    return () => { active.current = false; connection.disconnect(); socket.current = null; };
  }, [isProjector]);

  useEffect(() => {
    let request = 0;
    let previous = performance.now();
    let accumulator = 0;
    const animate = (now: number) => {
      const elapsed = Math.min(100, now - previous);
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
    const onVisibility = () => { if (document.hidden && game.current?.status === 'playing') onAct('pause'); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { cancelAnimationFrame(request); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

  const roomMetrics = room?.leaderboard.find(candidate => candidate.id === playerId)?.metrics;
  const currentMetrics = roomMetrics && roomMetrics.requests >= metrics.requests ? roomMetrics : metrics;

  return {
    room, connected, joined, joining, name, setName, playerId, view, metrics: currentMetrics, insights,
    busy, cooldownUntil, notice, setNotice, options, setOptions, game, isProjector,
    join: () => join(), act, assist, applySuggestion, restart,
  };
}

export type GameController = ReturnType<typeof useGame>;