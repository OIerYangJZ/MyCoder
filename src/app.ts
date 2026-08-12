/**
 * Application identity.
 *
 * Every user-visible name the kernel claims on a filesystem lives here, and
 * nowhere else. Spec §15 says the binary name is a placeholder and that
 * rebranding must not affect the protocol — that only stays true if there is one
 * place to rebrand.
 *
 * The name matters more than it looks. `~/.config/agent/` is a directory name
 * with no owner: it is exactly what a dozen unrelated tools would each pick, and
 * the first one to write a `config.toml` there wins. A specific name is not
 * vanity, it is not colliding with somebody else's state.
 */

/** Directory and binary name. Lowercase: it becomes a path component. */
export const APP_NAME = 'mycoder';

/** Human-facing name, for help text and status output. */
export const APP_DISPLAY_NAME = 'MyCoder';

/** Per-project configuration directory, inside the workspace. */
export const PROJECT_DIR = '.mycoder';

/**
 * Project directories still read for compatibility.
 *
 * `.agent` is the name the spec documents, and existing checkouts use it. It is
 * read but never written, and the primary always wins — so a repository that has
 * both is unambiguous rather than merged.
 */
export const LEGACY_PROJECT_DIRS: readonly string[] = ['.agent'];

/** Prefix for directory-override environment variables. */
export const ENV_PREFIX = 'MYCODER';

export const ENV_CONFIG_DIR = `${ENV_PREFIX}_CONFIG_DIR`;
export const ENV_DATA_DIR = `${ENV_PREFIX}_DATA_DIR`;
export const ENV_CACHE_DIR = `${ENV_PREFIX}_CACHE_DIR`;

/**
 * Project directories to search, primary first.
 *
 * Callers that *write* must use `projectDir()`; only lookups walk the fallbacks.
 */
export function projectDirCandidates(workspaceRoot: string): string[] {
  return [`${workspaceRoot}/${PROJECT_DIR}`, ...LEGACY_PROJECT_DIRS.map((d) => `${workspaceRoot}/${d}`)];
}

/** The single directory new files are written to. */
export function projectDir(workspaceRoot: string): string {
  return `${workspaceRoot}/${PROJECT_DIR}`;
}
