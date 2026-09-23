import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export interface AppConfig {
  port: number;
  host?: '127.0.0.1' | '0.0.0.0';
  endpoint: string;
  deployment: string;
  tenantId: string;
  dataDirectory: string;
  publicUrl?: string;
  pricingRegion?: string;
  managedIdentityClientId?: string;
  sqliteJournalMode?: 'WAL' | 'DELETE';
  localMaintenance?: boolean;
  trustProxyHops?: number;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const configPath = path.join(ROOT, '.azure', 'config.json');
  let azd: Record<string, string> = {};
  if (existsSync(configPath)) {
    const azdConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    const environment = azdConfig.defaultEnvironment;
    if (typeof environment === 'string' && /^[\w-]+$/.test(environment)) {
      const environmentPath = path.join(ROOT, '.azure', environment, '.env');
      if (existsSync(environmentPath)) azd = parse(readFileSync(environmentPath));
    }
  }
  const localPath = path.join(ROOT, '.env');
  const local = existsSync(localPath) ? parse(readFileSync(localPath)) : {};
  const values = { ...azd, ...local, ...environment };
  if (!values.AZURE_OPENAI_ENDPOINT || !values.AZURE_OPENAI_DEPLOYMENT || !values.AZURE_TENANT_ID) throw new Error('Azure configuration is missing. Provision with azd or configure the server environment.');
  const port = Number(values.PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  const host = values.HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new Error('HOST must be loopback or 0.0.0.0.');
  const sqliteJournalMode = values.SQLITE_JOURNAL_MODE ?? 'WAL';
  if (sqliteJournalMode !== 'WAL' && sqliteJournalMode !== 'DELETE') throw new Error('Unsupported SQLite journal mode.');
  const localMaintenance = values.LOCAL_ROOM_MAINTENANCE === 'true';
  if (localMaintenance && (host !== '127.0.0.1' || values.NODE_ENV === 'production' || values.AZURE_CLIENT_ID)) throw new Error('Unauthenticated room maintenance is restricted to a local loopback development server.');
  const trustProxyHops = Number(values.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 5.');
  return {
    port, host, endpoint: values.AZURE_OPENAI_ENDPOINT, deployment: values.AZURE_OPENAI_DEPLOYMENT,
    tenantId: values.AZURE_TENANT_ID, dataDirectory: path.resolve(values.DATA_DIRECTORY ?? path.join(ROOT, 'data')), publicUrl: values.PUBLIC_BASE_URL,
    pricingRegion: values.AZURE_LOCATION,
    managedIdentityClientId: values.AZURE_CLIENT_ID, sqliteJournalMode, localMaintenance, trustProxyHops,
  };
}