import { createApplication } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const application = createApplication(config);
application.server.on('error', error => {
  console.error(error.message);
  process.exitCode = 1;
  void application.close();
});
application.server.listen(config.port, '127.0.0.1', () => {
  console.log(`Tokenfall: http://127.0.0.1:${config.port}`);
  console.log(`Projector: http://127.0.0.1:${config.port}/?view=room`);
  console.log(`Room ${application.room.code} | ${config.deployment} | reasoning: none`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void application.close().then(() => process.exit(0)); });