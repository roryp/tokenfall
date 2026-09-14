import { createApplication } from './app.ts';
import { loadConfig } from './config.ts';
import { PRICE_REFRESH_MS, refreshTokenPricing } from './pricing.ts';

const config = loadConfig();
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
  void application.close();
});
application.server.listen(config.port, config.host ?? '127.0.0.1', () => {
  console.log(`Tetris listening on ${config.host ?? '127.0.0.1'}:${config.port}`);
  console.log(`Play: ${config.publicUrl ?? `http://127.0.0.1:${config.port}`}`);
  console.log(`Room ${application.room.code} | ${config.deployment} | reasoning: none`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { clearInterval(pricingTimer); void application.close().then(() => process.exit(0)); });