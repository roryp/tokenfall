import { startTransition, useEffect, useEffectEvent, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { DEFAULT_TOKEN_TEXT, Game, FPS, refreshPlacement } from '../../shared/game.ts';
import type { Action, GameView } from '../../shared/game.ts';
import { costForUsage, emptyMetrics, pointsPerCent } from '../../shared/protocol.ts';
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
  const [options, setOptions] = useState<AiOptions>({ cache: false, compression: false });
  const [tokenText, setTokenText] = useState(DEFAULT_TOKEN_TEXT);
  const configuredTokenText = useRef(DEFAULT_TOKEN_TEXT);
  const [editingTokens, setEditingTokens] = useState(false);
  const [autopilot, setAutopilot] = useState(false);
  const [pilotStatus, setPilotStatus] = useState('Manual control');
  const [requestOptions, setRequestOptions] = useState<AiOptions | null>(null);
  const pilotActive = useRef(false);
  const pilotEpoch = useRef(0);
  const requestPending = useRef(false);
  const requestSerial = useRef(0);
  const lastRequestAt = useRef(0);
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

  function stopAutopilot(message = 'Manual control') {
    pilotActive.current = false;
    pilotEpoch.current += 1;
    setAutopilot(false);
    setPilotStatus(message);
  }

  function toggleAutopilot(enabled: boolean) {
    if (!enabled) {
      stopAutopilot(requestPending.current ? 'Stopped. The in-flight request still counts toward cost.' : 'Stopped. Resume for manual play.');
      if (game.current?.status === 'playing') { game.current.act('pause'); refresh(); void flush(); }
      return;
    }
    if (!active.current || !socket.current?.connected || !game.current || game.current.status === 'over' || editingTokens) return;
    pilotEpoch.current += 1;
    pilotActive.current = true;
    setAutopilot(true);
    setPilotStatus('Luna is driving');
    setNotice('');
    if (game.current.status === 'playing') game.current.act('pause');
    setCooldownUntil(lastRequestAt.current + (roomRef.current?.autopilotCooldownMs ?? 1000));
    refresh();
    void flush();
  }

  function installSession(data: JoinResult) {
    stopAutopilot();
    requestSerial.current += 1;
    requestPending.current = false;
    setBusy(false);
    setRequestOptions(null);
    const needsTokenSetup = !data.replay.tokens?.length;
    setEditingTokens(needsTokenSetup);
    setTokenText(data.tokenText || DEFAULT_TOKEN_TEXT);
    configuredTokenText.current = data.tokenText || DEFAULT_TOKEN_TEXT;
    game.current = Game.restore(data.replay);
    if (needsTokenSetup && game.current.status === 'playing') game.current.act('pause');
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
    stopAutopilot('Stopped because the connection changed.');
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
    if (pilotActive.current) {
      if (action !== 'pause') return;
      stopAutopilot('Stopped. Resume for manual play.');
    }
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
    socket.current.timeout(8000).emit('join', { name: chosenName, room: session?.room ?? requestedCode, ...(session ? { token: session.token } : { text: tokenText }) }, (error: Error | null, reply: Reply<JoinResult>) => {
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

  async function assist(automatic = false) {
    if (requestPending.current || Date.now() < cooldownUntil || !game.current || !active.current || !socket.current?.connected) return;
    if (automatic && (!pilotActive.current || document.hidden)) return;
    if (game.current.status === 'over') { setNotice('Start a new game before asking Luna.'); return; }
    requestPending.current = true;
    const serial = ++requestSerial.current;
    const epoch = pilotEpoch.current;
    const selectedOptions = { cache: options.cache, compression: options.compression, autopilot: automatic };
    setRequestOptions(selectedOptions);
    setBusy(true);
    setNotice('');
    const originalRun = runId.current;
    if (automatic && game.current.status === 'playing') { game.current.act('pause'); refresh(); }
    if (!await flushAll() || serial !== requestSerial.current || originalRun !== runId.current || (automatic && (!pilotActive.current || epoch !== pilotEpoch.current))) {
      if (serial === requestSerial.current) { requestPending.current = false; setBusy(false); setRequestOptions(null); }
      return;
    }
    lastRequestAt.current = Date.now();
    const delay = automatic ? roomRef.current?.autopilotCooldownMs ?? 1000 : roomRef.current?.aiCooldownMs ?? 8000;
    setCooldownUntil(lastRequestAt.current + delay);
    if (automatic) setPilotStatus('Luna is choosing the next landing');
    socket.current!.timeout(25000).emit('assist', selectedOptions, (error: Error | null, response: Reply<{ insight: Insight; metrics: Metrics }>) => {
      if (serial !== requestSerial.current) return;
      requestPending.current = false;
      setRequestOptions(null);
      setBusy(false);
      if (error) { stopAutopilot('Stopped after a timeout. Usage may still be charged.'); setNotice('Luna took too long. Keep playing; usage will sync with the room.'); return; }
      if (!response.ok) {
        setNotice(response.error);
        if (response.retryAfterMs) setCooldownUntil(Date.now() + response.retryAfterMs);
        if (response.code !== 'busy' && response.code !== 'cooldown') stopAutopilot(`Stopped: ${response.error}`);
        else if (pilotActive.current) setPilotStatus('Waiting for the room request slot');
        return;
      }
      setMetrics(response.data.metrics);
      const insight = response.data.insight;
      if (originalRun !== runId.current || game.current?.pieceId !== insight.pieceId) insight.status = 'stale';
      setInsights(current => [insight, ...current].slice(0, 12));
      if (automatic && pilotActive.current && epoch === pilotEpoch.current && !document.hidden) {
        if (!applyInsight(insight)) { stopAutopilot('Stopped: the model move could not be applied.'); return; }
        if (game.current?.status === 'over') stopAutopilot('Run complete');
        else setPilotStatus('Move played. Preparing the next request.');
      }
    });
  }

  function applyInsight(insight: Insight) {
    if (!insight.placement || !game.current || !active.current || !socket.current?.connected || game.current.status === 'over' || insight.status !== 'ready') return false;
    if (insight.pieceId !== game.current.pieceId) { setNotice('That move belongs to a previous piece.'); return false; }
    const refreshed = refreshPlacement(game.current, insight.placement);
    if (!refreshed) { setNotice('That landing is no longer reachable.'); return false; }
    const paused = game.current.status === 'paused';
    if (paused) game.current.act('resume');
    for (const action of refreshed.path) game.current.act(action);
    if (paused && game.current.view().status !== 'over') game.current.act('pause');
    setInsights(current => current.map(entry => entry.id === insight.id ? { ...entry, status: 'stale' } : entry));
    refresh();
    void flush();
    return true;
  }

  function applySuggestion() { if (currentInsight && !pilotActive.current) applyInsight(currentInsight); }

  function editTokens() {
    toggleAutopilot(false);
    if (game.current?.status === 'playing') act('pause');
    setTokenText(configuredTokenText.current);
    setEditingTokens(true);
  }

  function cancelTokenSetup() {
    setTokenText(configuredTokenText.current);
    setEditingTokens(false);
  }

  async function restart(newText?: string) {
    if (!socket.current?.connected || !game.current || requestPending.current) return;
    stopAutopilot();
    if (!await flushAll()) return;
    setJoining(true);
    const receive = (error: Error | null, response: Reply<JoinResult>) => {
      setJoining(false);
      if (error) { setNotice('Could not restart. Check your connection.'); return; }
      if (!response.ok) { setNotice(response.error); return; }
      installSession(response.data);
      setNotice('');
    };
    if (newText === undefined) socket.current.timeout(8000).emit('restart', receive);
    else socket.current.timeout(8000).emit('configure', { text: newText }, receive);
  }

  const onFlush = useEffectEvent(flush);
  const onAct = useEffectEvent(act);
  const onJoin = useEffectEvent(join);
  const onStopPilot = useEffectEvent(stopAutopilot);
  const onPilotStep = useEffectEvent(() => {
    if (!pilotActive.current || document.hidden || !active.current) return;
    if (game.current?.status === 'over') { stopAutopilot('Run complete'); return; }
    void assist(true);
  });

  useEffect(() => {
    const timer = setInterval(() => onPilotStep(), 100);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const connection: GameSocket = io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 750, reconnectionDelayMax: 4000 });
    socket.current = connection;
    connection.on('connect', () => { setConnected(true); autoJoining.current = false; });
    connection.on('connect_error', () => { setConnected(false); setNotice('Cannot reach the room. Reconnecting.'); });
    connection.on('disconnect', () => {
      onStopPilot('Stopped because the connection changed.');
      requestSerial.current += 1;
      requestPending.current = false;
      setRequestOptions(null);
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
    return () => { active.current = false; pilotActive.current = false; pilotEpoch.current += 1; connection.disconnect(); socket.current = null; };
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
    const onVisibility = () => { if (document.hidden) { onStopPilot('Stopped while the page is hidden.'); if (game.current?.status === 'playing') onAct('pause'); } };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { cancelAnimationFrame(request); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

  const playerEntry = room?.leaderboard.find(candidate => candidate.id === playerId);
  const roomMetrics = playerEntry?.metrics;
  const currentMetrics = roomMetrics && roomMetrics.requests >= metrics.requests ? roomMetrics : metrics;
  const rates = room?.pricing?.snapshot?.usdPerMillion;
  const cost = rates ? costForUsage(currentMetrics, rates) : null;
  const unmeteredRequests = playerEntry?.unmeteredRequests ?? 0;
  const efficiencyScore = cost && unmeteredRequests === 0 ? pointsPerCent(view.score, cost.total) : null;

  return {
    room, connected, joined, joining, name, setName, playerId, view, metrics: currentMetrics, insights,
    cost, efficiencyScore, unmeteredRequests,
    busy, cooldownUntil, notice, setNotice, options, setOptions, game, isProjector,
    tokenText, setTokenText, editingTokens, editTokens, cancelTokenSetup,
    autopilot, pilotStatus, toggleAutopilot, requestOptions,
    join: () => join(), startTokenRun: () => joined ? void restart(tokenText) : join(), act, assist: () => assist(), applySuggestion, restart,
  };
}

export type GameController = ReturnType<typeof useGame>;