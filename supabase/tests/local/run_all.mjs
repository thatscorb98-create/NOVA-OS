/**
 * Run every local database verification:
 *
 *   1. the full migration/assertion suite (node, `pg`);
 *   2. the paused-audit end-to-end harness (Deno, real runQueue + audit.run).
 *
 * Both run against freshly created databases on a throwaway Postgres. When no
 * server is reachable, an embedded one is started for the run.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensurePostgres } from './postgres.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const denoBin = process.env.DENO_BIN?.trim() || 'deno';
const denoVersion = spawnSync(denoBin, ['--version'], { encoding: 'utf8' });

if (denoVersion.status !== 0) {
  console.error(
    [
      `Deno 2 is required for the paused-audit harness but "${denoBin}" could not be run.`,
      'Install Deno from https://deno.com/ or set DENO_BIN to its binary.',
    ].join('\n'),
  );
  process.exit(1);
}

const version = denoVersion.stdout.match(/(\d+)\.(\d+)\.\d+/);
if (version && Number(version[1]) < 2) {
  console.error(`Deno 2 or newer is required; found ${version[1]}.${version[2]}.`);
  process.exit(1);
}

let server;
try {
  server = await ensurePostgres();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const env = { ...process.env, NOVA_TEST_PG_URL: server.url };
const results = [];

try {
  console.log('\n== Postgres migration suite ==\n');
  const suite = spawnSync(process.execPath, [join(HERE, 'postgres_suite.mjs')], {
    stdio: 'inherit',
    env,
  });
  results.push(['Postgres migration suite', suite.status]);

  console.log('\n== Paused-audit end-to-end harness ==\n');
  const e2e = spawnSync(denoBin, ['run', '-A', join(HERE, 'audit_paused_e2e.ts')], {
    stdio: 'inherit',
    env,
  });
  results.push(['Paused-audit end-to-end harness', e2e.status]);
} finally {
  await server.stop();
}

console.log('\n== Summary ==');
let failed = false;
for (const [name, status] of results) {
  console.log(`${status === 0 ? 'PASS' : 'FAIL'}  ${name}`);
  if (status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
