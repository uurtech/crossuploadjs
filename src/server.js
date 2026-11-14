#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

export { createApp, loadConfig };

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const config = loadConfig();
  const { server } = createApp(config);
  server.listen(config.port, config.host, () => {
    console.log(`\nCrossUpload core is running`);
    console.log(`  Local:        http://localhost:${config.port}`);
    console.log(`  Phone URL:    ${config.publicUrl}  (QR codes point here; set PUBLIC_URL to change)`);
    console.log(`  Widget:       ${config.publicUrl}/v1/widget.js`);
    if (config.demo) console.log(`  Demo form:    http://localhost:${config.port}/`);
    if (config.generatedSecret) {
      console.log(`\n  SECRET_KEY was not set, so a temporary one was generated:`);
      console.log(`  ${config.secretKey}`);
      console.log(`  Set SECRET_KEY in .env to keep it across restarts.`);
    }
    console.log('');
  });
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.(); // open SSE streams would otherwise keep the process alive
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
