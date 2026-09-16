import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

interface ResetOptions {
  databasePath: string;
  mode?: 'all' | 'scores';
  apply?: boolean;
  confirmRoom?: string;
  backupPath?: string;
  serverStopped?: boolean;
  assertIdle?: () => Promise<void>;
}

interface ResetSummary {
  players: number;
  nonzeroScores: number;
  requests: number;
  usedTokens: number;
  attempts: number;
}

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rowsFor = (database: DatabaseSync) => database.prepare('SELECT * FROM players ORDER BY id').all();
const settingsFor = (database: DatabaseSync) => database.prepare('SELECT * FROM settings ORDER BY key').all();
const summaryFor = (rows: ReturnType<typeof rowsFor>) => rows.reduce<ResetSummary>((summary, record) => {
  const metrics = JSON.parse(String(record.metrics));
  return {
    players: summary.players + 1,
    nonzeroScores: summary.nonzeroScores + Number(Number(record.best_score) > 0),
    requests: summary.requests + Number(metrics.requests ?? 0),
    usedTokens: summary.usedTokens + Number(metrics.input ?? 0) + Number(metrics.output ?? 0),
    attempts: summary.attempts + Number(record.attempts),
  };
}, { players: 0, nonzeroScores: 0, requests: 0, usedTokens: 0, attempts: 0 });

export async function resetRoom(options: ResetOptions) {
  const mode = options.mode ?? 'all';
  assert.ok(mode === 'all' || mode === 'scores', 'Mode must be all or scores.');
  assert.ok(existsSync(options.databasePath), 'Database does not exist; refusing to create one.');
  const database = new DatabaseSync(options.databasePath, { readOnly: !options.apply });
  let transaction = false;
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    const settings = settingsFor(database);
    const room = String(settings.find(setting => setting.key === 'room')?.value ?? '');
    assert.match(room, /^[A-Z0-9]{6}$/, 'A valid saved room is required.');
    if (options.confirmRoom !== undefined) assert.equal(options.confirmRoom, room, 'Room confirmation does not match.');
    const before = rowsFor(database);
    const summary = summaryFor(before);
    if (!options.apply) return { applied: false, mode, room, before: summary, backupPath: null, after: null };
    assert.equal(options.confirmRoom, room, 'Applying requires --confirm-room with the displayed room code.');
    assert.ok(options.serverStopped || options.assertIdle, 'Stop the server first or supply an idle check.');
    await options.assertIdle?.();
    assert.deepEqual(database.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok']);
    const backupPath = options.backupPath ?? path.join(path.dirname(options.databasePath), 'backups', `before-${mode}-reset-${Date.now()}-${randomUUID()}.sqlite`);
    assert.equal(existsSync(backupPath), false, 'Refusing to overwrite an existing backup.');
    mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await backup(database, backupPath);
    chmodSync(backupPath, 0o600);
    const recovery = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.deepEqual(recovery.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok']);
      assert.equal(fingerprint(rowsFor(recovery)), fingerprint(before), 'Backup differs from the source.');
      assert.equal(fingerprint(settingsFor(recovery)), fingerprint(settings));
    } finally { recovery.close(); }
    await options.assertIdle?.();
    database.exec('BEGIN IMMEDIATE');
    transaction = true;
    assert.equal(fingerprint(rowsFor(database)), fingerprint(before), 'Players changed during reset; retry when idle.');
    assert.equal(fingerprint(settingsFor(database)), fingerprint(settings), 'Settings changed during reset.');
    if (mode === 'all') database.exec('DELETE FROM players');
    else database.exec('UPDATE players SET best_score = 0, best_lines = 0, best_level = 1');
    const after = rowsFor(database);
    if (mode === 'all') assert.equal(after.length, 0, 'Leaderboard must be empty.');
    else {
      assert.ok(after.every(record => record.best_score === 0 && record.best_lines === 0 && record.best_level === 1));
      const withoutScores = (rows: typeof after) => rows.map(({ best_score, best_lines, best_level, ...record }) => record);
      assert.equal(fingerprint(withoutScores(after)), fingerprint(withoutScores(before)));
    }
    assert.equal(fingerprint(settingsFor(database)), fingerprint(settings), 'Room settings must be preserved.');
    database.exec('COMMIT');
    transaction = false;
    return { applied: true, mode, room, before: summary, after: summaryFor(after), backupPath };
  } catch (error) {
    if (transaction) database.exec('ROLLBACK');
    throw error;
  } finally { database.close(); }
}

async function main() {
  const { values } = parseArgs({ options: {
    database: { type: 'string' }, mode: { type: 'string', default: 'all' },
    apply: { type: 'boolean', default: false }, 'confirm-room': { type: 'string' },
    backup: { type: 'string' }, 'server-stopped': { type: 'boolean', default: false },
    url: { type: 'string' }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('Usage: node scripts/reset-room.ts --database <path> [--mode all|scores] [--apply --confirm-room <code> --server-stopped]\nDefault: preview only. all clears players, leaderboards, sessions and in-app usage history. scores retains player entries and usage.\nStop the local server before applying and restart afterward. Azure: use scripts/reset-room.ps1 -Azure. Backups and the room code are retained; Azure billing is not reset.');
    return;
  }
  assert.ok(values.database, '--database is required.');
  assert.ok(values.mode === 'all' || values.mode === 'scores', 'Mode must be all or scores.');
  const url = values.url ? new URL(values.url) : null;
  if (url) {
    assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), '--url must address the same local server.');
    assert.equal(url.username + url.password + url.search + url.hash, '', 'Server URL must not contain credentials, query or fragment.');
  }
  const assertIdle = url ? async () => {
    const response = await fetch(new URL('/api/room', url), { signal: AbortSignal.timeout(10000) });
    assert.ok(response.ok, 'The local room is unavailable.');
    const room = await response.json() as { code: string; online: number; allowance: { reserved: number } };
    assert.equal(room.code, values['confirm-room'], 'Server and confirmed room must match.');
    assert.equal(room.online, 0, 'Players are online; stop their games before resetting.');
    assert.equal(room.allowance.reserved, 0, 'AI requests are pending; wait before resetting.');
  } : undefined;
  const result = await resetRoom({
    databasePath: path.resolve(values.database), mode: values.mode, apply: values.apply,
    confirmRoom: values['confirm-room'], backupPath: values.backup ? path.resolve(values.backup) : undefined,
    serverStopped: values['server-stopped'], assertIdle,
  });
  console.log(`RESET_RESULT ${JSON.stringify(result)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Reset failed.'); process.exitCode = 1; });
}