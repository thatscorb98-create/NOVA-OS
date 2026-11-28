/**
 * Throwaway PostgreSQL for the local database suites.
 *
 * If NOVA_TEST_PG_URL points at a reachable server, that server is used and
 * nothing is started or stopped. Otherwise this module starts the embedded
 * PostgreSQL binaries installed in this folder (or the binaries named by
 * NOVA_TEST_PG_BIN) against `.pgdata`, and stops them when the run finishes.
 *
 * The suites then drop and recreate their own databases, so they never run
 * against a database that contains real rows.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL = 'postgres://postgres@127.0.0.1:55432/postgres';
const require = createRequire(import.meta.url);

export function baseUrl() {
  return process.env.NOVA_TEST_PG_URL?.trim() || DEFAULT_URL;
}

/** Same server, different database name. */
export function urlForDatabase(name) {
  const url = new URL(baseUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

function findBinDir() {
  if (process.env.NOVA_TEST_PG_BIN) return process.env.NOVA_TEST_PG_BIN;

  try {
    // The package's `exports` map only exposes its entry point, so derive the
    // package root from `dist/index.js` instead of resolving package.json.
    const entry = require.resolve('@embedded-postgres/linux-x64');
    const embedded = join(dirname(entry), '..', 'native', 'bin');
    if (existsSync(join(embedded, 'initdb'))) return embedded;
  } catch {
    // The optional package is not installed (for example on a non-Linux host).
  }

  const local = join(HERE, 'node_modules', '@embedded-postgres', 'linux-x64', 'native', 'bin');
  if (existsSync(join(local, 'initdb'))) return local;

  const which = spawnSync('which', ['initdb'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return dirname(which.stdout.trim());
  return null;
}

async function canConnect(connectionString) {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 1500,
  });

  try {
    await client.connect();
    await client.query('select 1');
    await client.end();
    return true;
  } catch {
    try {
      await client.end();
    } catch {
      // The connection never opened.
    }
    return false;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make sure a Postgres server is reachable.
 *
 * @returns {Promise<{url: string, started: boolean, stop: () => Promise<void>}>}
 */
export async function ensurePostgres() {
  if (await canConnect(baseUrl())) {
    console.log(`Using the Postgres already running at ${new URL(baseUrl()).host}.`);
    return { url: baseUrl(), started: false, stop: async () => {} };
  }

  const requested = new URL(baseUrl());
  if (!['127.0.0.1', 'localhost', '::1'].includes(requested.hostname)) {
    throw new Error(
      `No Postgres is reachable at ${requested.host}. Start it, or set NOVA_TEST_PG_URL to a running server.`,
    );
  }

  const bin = findBinDir();
  if (!bin) {
    throw new Error(
      [
        'No Postgres server is reachable and no local binaries were found.',
        'Either:',
        '  - set NOVA_TEST_PG_URL to a running throwaway Postgres, or',
        '  - run `npm install` in supabase/tests/local (installs the embedded Linux binaries), or',
        '  - set NOVA_TEST_PG_BIN to a directory containing initdb and postgres.',
      ].join('\n'),
    );
  }

  const dataDir = join(HERE, '.pgdata');
  const port = requested.port || '5432';
  const user = decodeURIComponent(requested.username || 'postgres');
  const logPath = join(dataDir, 'server.log');

  if (!existsSync(join(dataDir, 'PG_VERSION'))) {
    mkdirSync(dataDir, { recursive: true });
    const init = spawnSync(
      join(bin, 'initdb'),
      ['-D', dataDir, '-U', user, '--auth=trust', '--encoding=UTF8', '--no-sync'],
      { encoding: 'utf8' },
    );
    if (init.status !== 0) {
      throw new Error(`initdb failed in ${dataDir}:\n${init.stderr || init.stdout}`);
    }
  }

  const log = openSync(logPath, 'a');
  const child = spawn(
    join(bin, 'postgres'),
    [
      '-D',
      dataDir,
      '-p',
      port,
      '-k',
      dataDir,
      '-c',
      'listen_addresses=127.0.0.1',
      '-c',
      'fsync=off',
    ],
    { stdio: ['ignore', log, log] },
  );

  const localUrl = new URL(baseUrl());
  localUrl.hostname = '127.0.0.1';
  const url = localUrl.toString();

  const stop = async () => {
    if (existsSync(join(bin, 'pg_ctl'))) {
      spawnSync(join(bin, 'pg_ctl'), ['-D', dataDir, 'stop', '-m', 'fast', '-w'], {
        encoding: 'utf8',
        timeout: 15000,
      });
    }

    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await canConnect(url)) {
      console.log(`Started throwaway Postgres on 127.0.0.1:${port} (${dataDir}).`);
      return { url, started: true, stop };
    }

    if (child.exitCode !== null) {
      throw new Error(`Postgres exited with code ${child.exitCode}. See ${logPath}.`);
    }

    await wait(250);
  }

  await stop();
  throw new Error(`Postgres did not become ready within 30 seconds. See ${logPath}.`);
}
