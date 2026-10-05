import type { E2EConfig } from './web/node_modules/e2e/dist/index.js';
import { web } from './web/node_modules/@e2e-dev/web/dist/index.js';

// Dependencies are installed once under web/. No model/provider is configured.
export default {
  projectId: 'codex-usage-workbench',
  tests: ['tests/e2e/*.e2e.ts'],
  workers: 1,
  retries: 0,
  timeout: 90000,
  actionTimeout: 15000,
  assertionTimeout: 10000,
  output: '.e2e',
  trace: 'on',
  reporters: ['list', 'markdown'],
  targets: [{
    name: 'desktop-chromium',
    engine: web({ browser: 'chromium', viewport: { width: 1600, height: 1100 } }),
    app: {
      url: 'http://127.0.0.1:0',
      command: {
        executable: 'uv',
        args: ['run', '--no-project', '--with', './[test]', 'python', 'tests/e2e/serve_fixture.py', '--port', '{port}'],
        env: { E2E_TELEMETRY_DISABLED: '1', PYTHONPATH: 'src' },
        startupTimeout: 60000,
        log: '.e2e/logs/fixture-server.log',
      },
    },
  }],
} satisfies E2EConfig;
