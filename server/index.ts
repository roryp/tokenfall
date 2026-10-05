import { createApplication } from './app.ts';
import { loadConfig } from './config.ts';
import { PRICE_REFRESH_MS, refreshTokenPricing } from './pricing.ts';
import { startTelemetry, stopTelemetry } from './telemetry.ts';

const config = loadConfig();
const tracing = startTelemetry(config);
const application = createApplication(config);
async function updatePricing() {
  application.room.pricing = await refreshTokenPricing(application.room.pricing, config.deployment, config.pricingRegion ?? '');
  console.log(`Model pricing: ${application.room.pricing.status}`);
}
const pricingTimer = setInterval(() => { void updatePricing(); }, PRICE_REFRESH_MS);
pricingTimer.unref();
void updatePricing();
application.server.on('error', error => {
  clearInterval(pricingTimer);
  console.error(error.message);
  process.exitCode = 1;
  void application.close().then(stopTelemetry);
});
application.server.listen(config.port, config.host ?? '127.0.0.1', () => {
  console.log(`Tetris listening on ${config.host ?? '127.0.0.1'}:${config.port}`);
  console.log(`Play: ${config.publicUrl ?? `http://127.0.0.1:${config.port}`}`);
  console.log(`Room ${application.room.code} | ${config.deployment} | reasoning: off by default, optional low effort`);
  console.log(`Tracing: ${tracing ? 'Application Insights (Foundry)' : 'off'}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { clearInterval(pricingTimer); void application.close().then(stopTelemetry).then(() => process.exit(0)); });