import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import { z } from 'zod';
import { ACTIONS } from '../shared/game.ts';
import { MAX_TOKEN_ALLOWANCE } from '../shared/protocol.ts';
import type { ClientEvents, ServerEvents, Reply, RoomResetResult } from '../shared/protocol.ts';
import { ROOT } from './config.ts';
import type { AppConfig } from './config.ts';
import { LunaGateway, RequestError } from './model.ts';
import type { ModelGateway } from './model.ts';
import { Room } from './room.ts';
import { countTokens, tokenChips } from './tokens.ts';

const nameSchema = z.string().trim().min(2).max(16).regex(/^[\p{L}\p{N} _-]+$/u, 'Use letters, numbers, spaces, underscores or hyphens.');
const tokenLimitSchema = z.number().int().min(1).max(MAX_TOKEN_ALLOWANCE);
const setupSchema = z.object({ text: z.string().min(1).max(500), tokenLimit: tokenLimitSchema.optional() }).strict();
const allowanceSchema = z.object({ tokenLimit: tokenLimitSchema }).strict();
const joinSchema = z.object({ name: nameSchema, room: z.string().length(6), token: z.string().length(64).optional(), text: z.string().min(1).max(500).optional(), classic: z.boolean().optional(), tokenLimit: tokenLimitSchema.optional() }).strict();
const inputSchema = z.object({
  runId: z.string().uuid(), sequence: z.number().int().positive(), frame: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  events: z.array(z.object({ frame: z.number().int().nonnegative(), action: z.enum(ACTIONS) }).strict()).max(64),
}).strict();
const aiSchema = z.object({ cache: z.boolean(), compression: z.boolean(), reasoning: z.boolean().optional(), mcp: z.boolean().optional(), autopilot: z.boolean().optional() }).strict();

export function errorReply(error: unknown): Reply<never> {
  if (error instanceof RequestError) return { ok: false, error: error.message, code: error.code, retryAfterMs: error.retryAfterMs };
  if (error instanceof z.ZodError) return { ok: false, error: error.issues[0]?.message ?? 'Invalid request.', code: 'validation' };
  console.error('Request failed:', error instanceof Error ? error.message : 'Unknown error');
  return { ok: false, error: 'Luna is unavailable right now. Your game can continue manually.', code: 'unavailable', retryAfterMs: 8000 };
}

export function createApplication(config: AppConfig, gateway: ModelGateway = new LunaGateway(config)) {
  if (config.localMaintenance && (config.host === '0.0.0.0' || config.managedIdentityClientId || process.env.NODE_ENV === 'production')) throw new Error('Unauthenticated room maintenance is restricted to a local loopback development server.');
  const app = express();
  const server = createServer(app);
  const room = new Room(config, gateway);
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/health', (_request, response) => response.json({ status: 'ok', model: config.deployment, reasoning: 'none', reasoningOptions: ['none', 'low'] }));
  app.get('/api/room', (_request, response) => response.setHeader('Cache-Control', 'no-store').json(room.view()));
  const tokenWindows = new Map<string, { start: number; count: number }>();
  app.post('/api/tokenize', (request, response) => {
    try {
      const { text } = z.object({ text: z.string().max(500) }).strict().parse(request.body);
      const address = request.ip ?? 'unknown';
      const now = Date.now();
      for (const [key, window] of tokenWindows) if (now - window.start >= 60000) tokenWindows.delete(key);
      const window = tokenWindows.get(address) ?? { start: now, count: 0 };
      window.count += 1;
      tokenWindows.set(address, window);
      if (window.count > 300) { response.status(429).json({ error: 'Token lab is busy. Try again in a moment.' }); return; }
      response.json({ count: countTokens(text), tokens: tokenChips(text, 256), encoding: 'o200k_base', estimate: true });
    } catch (error) { response.status(400).json(errorReply(error)); }
  });
  app.use('/api/maintenance', (request, response, next) => {
    if (!config.localMaintenance) { response.status(404).json({ error: 'Not found.' }); return; }
    const address = server.address();
    const host = request.headers.host;
    const localHost = address && typeof address !== 'string' && ['127.0.0.1', 'localhost'].some(name => host === `${name}:${address.port}`);
    const localPeer = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '');
    const origin = request.headers.origin;
    if (!localHost || !localPeer || request.headers.forwarded || request.headers['x-forwarded-for'] || request.headers['x-forwarded-host'] || origin !== `http://${host}` || request.headers['x-room-maintenance'] !== '1') {
      response.status(403).json({ error: 'Room maintenance is available only from this local app.' }); return;
    }
    if (!request.is('application/json')) { response.status(415).json({ error: 'A JSON request is required.' }); return; }
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  const resetModeSchema = z.enum(['all', 'scores']);
  app.post('/api/maintenance/preview', (request, response) => {
    try {
      const { mode } = z.object({ mode: resetModeSchema }).strict().parse(request.body);
      response.json(room.previewReset(mode));
    } catch (error) { response.status(error instanceof z.ZodError ? 400 : 409).json(errorReply(error)); }
  });
  app.post('/api/maintenance/reset', async (request, response) => {
    try {
      const { mode, confirmRoom, confirmationId } = z.object({ mode: resetModeSchema, confirmRoom: z.string().length(6), confirmationId: z.string().uuid() }).strict().parse(request.body);
      const reset = await room.reset(mode, confirmRoom, confirmationId);
      const result: RoomResetResult = { id: randomUUID(), room: room.code, mode, before: reset.before, after: reset.after!, backup: path.basename(reset.backupPath!) };
      io.emit('roomReset', { id: result.id, mode });
      io.emit('room', room.view());
      response.json(result);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof RequestError) response.status(error instanceof z.ZodError || error.code === 'validation' ? 400 : 409).json(errorReply(error));
      else {
        console.error('Room reset failed:', error instanceof Error ? error.message : 'Unknown error');
        response.status(500).json({ error: 'The reset could not be completed. No data was cleared. Check the server backup directory and refresh the preview.' });
      }
    }
  });
  app.use('/api', (_request, response) => response.status(404).json({ error: 'Not found.' }));
  app.use(express.static(path.join(ROOT, 'web', 'dist'), { maxAge: 0 }));
  app.get('/{*path}', (_request, response) => response.sendFile(path.join(ROOT, 'web', 'dist', 'index.html')));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(400).json({ error: error instanceof SyntaxError ? 'Invalid JSON.' : 'Request could not be processed.' });
  });

  const io = new Server<ClientEvents, ServerEvents>(server, {
    maxHttpBufferSize: 65536,
    pingInterval: 20000,
    pingTimeout: 20000,
    allowRequest: (request, done) => {
      if (!request.headers.origin) { done(null, true); return; }
      try {
        const origin = new URL(request.headers.origin).host;
        const publicHost = room.publicUrl() ? new URL(room.publicUrl()!).host : null;
        done(null, origin === request.headers.host || origin === publicHost);
      } catch { done(null, false); }
    },
  });
  const joinWindows = new Map<string, { started: number; count: number }>();
  io.on('connection', socket => {
    socket.emit('room', room.view());
    socket.on('join', (payload, respond) => {
      if (typeof respond !== 'function') return;
      try {
        const data = joinSchema.parse(payload);
        const now = Date.now();
        for (const [key, window] of joinWindows) if (now - window.started >= 60000) joinWindows.delete(key);
        const address = socket.handshake.address;
        const window = joinWindows.get(address) ?? { started: now, count: 0 };
        window.count += 1;
        joinWindows.set(address, window);
        if (window.count > 150) throw new RequestError('Too many join attempts. Try again shortly.', 'rate', 30000);
        respond({ ok: true, data: room.join(data.name, data.room, data.token, socket.id, data.text, data.classic, data.tokenLimit) });
        io.emit('room', room.view());
      } catch (error) { respond(errorReply(error)); }
    });
    socket.on('inputs', (payload, respond) => {
      if (typeof respond !== 'function') return;
      try { respond({ ok: true, data: room.inputs(room.playerFor(socket.id), inputSchema.parse(payload)) }); }
      catch (error) { respond(errorReply(error)); }
    });
    socket.on('restart', respond => {
      if (typeof respond !== 'function') return;
      try { respond({ ok: true, data: room.restart(room.playerFor(socket.id)) }); }
      catch (error) { respond(errorReply(error)); }
    });
    socket.on('configure', (payload, respond) => {
      if (typeof respond !== 'function') return;
      try {
        const data = setupSchema.parse(payload);
        respond({ ok: true, data: room.restart(room.playerFor(socket.id), data.text, data.tokenLimit) });
      }
      catch (error) { respond(errorReply(error)); }
    });
    socket.on('allowance', (payload, respond) => {
      if (typeof respond !== 'function') return;
      try { respond({ ok: true, data: room.setAllowance(room.playerFor(socket.id), allowanceSchema.parse(payload).tokenLimit) }); }
      catch (error) { respond(errorReply(error)); }
    });
    socket.on('inspect', respond => {
      if (typeof respond !== 'function') return;
      try { respond({ ok: true, data: room.inspect(room.playerFor(socket.id)) }); }
      catch (error) { respond(errorReply(error)); }
    });
    socket.on('assist', async (payload, respond) => {
      if (typeof respond !== 'function') return;
      try {
        const player = room.playerFor(socket.id);
        const pending = room.assist(player, aiSchema.parse(payload));
        socket.emit('usage', room.usage(player));
        const data = await pending;
        respond({ ok: true, data });
        io.emit('room', room.view());
      } catch (error) { respond(errorReply(error)); }
      finally {
        const player = [...room.players.values()].find(candidate => candidate.socketId === socket.id);
        if (player) socket.emit('usage', room.usage(player));
      }
    });
    socket.on('disconnect', () => { room.disconnect(socket.id); io.emit('room', room.view()); });
  });
  const broadcast = setInterval(() => {
    io.emit('room', room.view());
    for (const player of room.players.values()) if (player.socketId) io.to(player.socketId).emit('usage', room.usage(player));
  }, 500);
  broadcast.unref();
  return {
    app, server, io, room,
    close: async () => {
      clearInterval(broadcast);
      await new Promise<void>(resolve => io.close(() => resolve()));
      room.close();
    },
  };
}