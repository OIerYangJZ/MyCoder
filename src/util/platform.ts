/**
 * Platform directory abstraction (spec §21.1).
 *
 * The spec names `~/.local/share/agent/sessions/` as the default and notes that
 * macOS may map to Application Support. Rather than hard-code either, resolve
 * once here so tests can redirect everything with a single override.
 */

import { homedir } from 'node:os';
import * as path from 'node:path';

import { APP_NAME, ENV_CACHE_DIR, ENV_CONFIG_DIR, ENV_DATA_DIR } from '../app.ts';

export interface KernelDirs {
  /** User configuration: config.toml, remotes.toml, skills/, agents/. */
  config: string;
  /** Session store: sessions/<id>/. */
  data: string;
  /** Ephemeral scratch. */
  cache: string;
  home: string;
}

export interface ResolveDirsOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Test override: puts every directory under one root. */
  root?: string;
}

export function resolveKernelDirs(opts: ResolveDirsOptions = {}): KernelDirs {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;

  if (opts.root) {
    return {
      config: path.join(opts.root, 'config'),
      data: path.join(opts.root, 'data'),
      cache: path.join(opts.root, 'cache'),
      home,
    };
  }

  // An explicit MYCODER_* override wins on every platform: it is what CI and the
  // security tests use to keep a run out of the developer's real session store.
  const explicitConfig = env[ENV_CONFIG_DIR];
  const explicitData = env[ENV_DATA_DIR];
  const explicitCache = env[ENV_CACHE_DIR];

  if (platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support', APP_NAME);
    return {
      config: explicitConfig ?? path.join(home, '.config', APP_NAME),
      data: explicitData ?? support,
      cache: explicitCache ?? path.join(home, 'Library', 'Caches', APP_NAME),
      home,
    };
  }

  if (platform === 'win32') {
    const appData = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return {
      config: explicitConfig ?? path.join(appData, APP_NAME),
      data: explicitData ?? path.join(localAppData, APP_NAME),
      cache: explicitCache ?? path.join(localAppData, APP_NAME, 'cache'),
      home,
    };
  }

  // XDG.
  const xdgConfig = env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  const xdgData = env.XDG_DATA_HOME ?? path.join(home, '.local', 'share');
  const xdgCache = env.XDG_CACHE_HOME ?? path.join(home, '.cache');
  return {
    config: explicitConfig ?? path.join(xdgConfig, APP_NAME),
    data: explicitData ?? path.join(xdgData, APP_NAME),
    cache: explicitCache ?? path.join(xdgCache, APP_NAME),
    home,
  };
}

export function sessionsDir(dirs: KernelDirs): string {
  return path.join(dirs.data, 'sessions');
}

export function sessionDir(dirs: KernelDirs, sessionId: string): string {
  return path.join(sessionsDir(dirs), sessionId);
}
