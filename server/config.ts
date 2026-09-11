import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export interface AppConfig {
  port: number;
  endpoint: string;
  deployment: string;
  tenantId: string;
  dataDirectory: string;
  publicUrl?: string;
}

export function loadConfig(): AppConfig {
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
  const values = { ...azd, ...local, ...process.env };
  if (!values.AZURE_OPENAI_ENDPOINT || !values.AZURE_OPENAI_DEPLOYMENT || !values.AZURE_TENANT_ID) throw new Error('Azure configuration is missing. Provision with azd or configure the server environment.');
  const port = Number(values.PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  return {
    port, endpoint: values.AZURE_OPENAI_ENDPOINT, deployment: values.AZURE_OPENAI_DEPLOYMENT,
    tenantId: values.AZURE_TENANT_ID, dataDirectory: path.join(ROOT, 'data'), publicUrl: values.PUBLIC_BASE_URL,
  };
}