/**
 * Update Command Handler
 *
 * Handles `ccs update` command - checks for updates and installs latest version.
 * Uses npm/yarn/pnpm/bun package managers exclusively.
 */

import { spawn } from 'child_process';
import { initUI, header, ok, fail, warn, info, color } from '../utils/ui';
import {
  buildPackageManagerEnv,
  detectCurrentInstall,
  formatManualUpdateCommand,
  readInstalledPackageState,
  type CurrentInstall,
  type InstalledPackageState,
} from '../utils/package-manager-detector';
import { compareVersionsWithPrerelease } from '../utils/update-checker';
import { getVersion } from '../utils/version';

/**
 * Options for the update command
 */
export interface UpdateOptions {
  force?: boolean;
  beta?: boolean;
}

type TargetTag = 'latest' | 'dev';

type UpdateCheckResult =
  | {
      status: 'update_available';
      current?: string;
      latest?: string;
      message?: string;
      reason?: string;
    }
  | {
      status: 'check_failed';
      message?: string;
      latest?: string;
      current?: string;
      reason?: string;
    }
  | {
      status: 'no_update';
      reason?: string;
      latest?: string;
      current?: string;
      message?: string;
    };

export interface UpdateCommandDeps {
  initUI: typeof initUI;
  getVersion: typeof getVersion;
  detectCurrentInstall: typeof detectCurrentInstall;
  buildPackageManagerEnv: typeof buildPackageManagerEnv;
  formatManualUpdateCommand: typeof formatManualUpdateCommand;
  readInstalledPackageState: typeof readInstalledPackageState;
  compareVersionsWithPrerelease: typeof compareVersionsWithPrerelease;
  checkForUpdates: (
    currentVersion: string,
    interactive: boolean,
    channel: 'npm' | 'direct',
    targetTag: TargetTag
  ) => Promise<UpdateCheckResult>;
  spawn: typeof spawn;
}

async function loadCheckForUpdates(
  currentVersion: string,
  interactive: boolean,
  channel: 'npm' | 'direct',
  targetTag: TargetTag
): Promise<UpdateCheckResult> {
  const { checkForUpdates } = await import('../utils/update-checker');
  return checkForUpdates(
    currentVersion,
    interactive,
    channel,
    targetTag
  ) as Promise<UpdateCheckResult>;
}

const defaultDeps: UpdateCommandDeps = {
  initUI,
  getVersion,
  detectCurrentInstall,
  buildPackageManagerEnv,
  formatManualUpdateCommand,
  readInstalledPackageState,
  compareVersionsWithPrerelease,
  checkForUpdates: loadCheckForUpdates,
  spawn,
};

async function resolveTargetVersion(
  currentVersion: string,
  targetTag: TargetTag,
  deps: UpdateCommandDeps
): Promise<string | undefined> {
  const result = await deps.checkForUpdates(currentVersion, true, 'npm', targetTag);

  if (result.status === 'update_available' && result.latest) {
    return result.latest;
  }

  if (result.status === 'no_update') {
    return currentVersion;
  }

  return undefined;
}

/**
 * Handle the update command
 * Checks for updates and installs the latest version
 */
export async function handleUpdateCommand(
  options: UpdateOptions = {},
  injectedDeps: Partial<UpdateCommandDeps> = {}
): Promise<void> {
  const deps = { ...defaultDeps, ...injectedDeps };
  await deps.initUI();
  const { force = false, beta = false } = options;
  const targetTag: TargetTag = beta ? 'dev' : 'latest';
  const currentInstall = deps.detectCurrentInstall();
  const currentVersion = deps.getVersion();

  console.log('');
  console.log(header('Checking for updates...'));
  console.log('');

  // Force reinstall - skip update check
  if (force) {
    console.log(info(`Force reinstall from @${targetTag} channel...`));
    console.log('');
    const expectedVersion = await resolveTargetVersion(currentVersion, targetTag, deps);
    await performNpmUpdate(currentInstall, targetTag, true, expectedVersion, deps);
    return;
  }

  const updateResult = await deps.checkForUpdates(currentVersion, true, 'npm', targetTag);

  if (updateResult.status === 'check_failed') {
    handleCheckFailed(
      updateResult.message ?? 'Update check failed',
      targetTag,
      currentInstall,
      deps
    );
    return;
  }

  if (updateResult.status === 'no_update') {
    handleNoUpdate(updateResult.reason);
    return;
  }

  // Update available
  console.log(warn(`Update available: ${updateResult.current} -> ${updateResult.latest}`));
  console.log('');

  // Check if this is a downgrade (e.g., stable to older dev)
  const isDowngrade =
    updateResult.latest &&
    updateResult.current &&
    deps.compareVersionsWithPrerelease(updateResult.latest, updateResult.current) < 0;

  // This happens when stable user requests @dev but @dev base is older
  if (isDowngrade && beta) {
    console.log(
      warn(
        'WARNING: Downgrading from ' +
          (updateResult.current || 'unknown') +
          ' to ' +
          (updateResult.latest || 'unknown')
      )
    );
    console.log(warn('Dev channel may be behind stable.'));
    console.log('');
  }

  // Show beta warning
  if (beta) {
    console.log(warn('Installing from @dev channel (unstable)'));
    console.log(warn('Not recommended for production use'));
    console.log(info('Use `ccs update` (without --beta) to return to stable'));
    console.log('');
  }

  await performNpmUpdate(currentInstall, targetTag, false, updateResult.latest, deps);
}

/**
 * Handle failed update check
 */
function handleCheckFailed(
  message: string,
  targetTag: string = 'latest',
  currentInstall: CurrentInstall = defaultDeps.detectCurrentInstall(),
  deps: UpdateCommandDeps = defaultDeps
): void {
  console.log(fail(message));
  console.log('');
  console.log(warn('Possible causes:'));
  console.log('  - Network connection issues');
  console.log('  - Firewall blocking requests');
  console.log('  - GitHub/npm API temporarily unavailable');
  console.log('');
  console.log('Try again later or update manually:');
  console.log(color(`  ${deps.formatManualUpdateCommand(targetTag, currentInstall)}`, 'command'));
  console.log('');
  process.exit(1);
}

/**
 * Handle no update available
 */
function handleNoUpdate(reason: string | undefined): void {
  const version = getVersion();

  let message = `You are already on the latest version (${version})`;

  switch (reason) {
    case 'dismissed':
      message = `Update dismissed. You are on version ${version}`;
      console.log(warn(message));
      break;
    case 'cached':
      message = `No updates available (cached result). You are on version ${version}`;
      console.log(info(message));
      break;
    default:
      console.log(ok(message));
  }
  console.log('');
  process.exit(0);
}

/**
 * Perform update verification against the current install.
 */
async function verifyCurrentInstallVersion(
  currentInstall: CurrentInstall,
  targetTag: string,
  expectedVersion?: string,
  previousState?: InstalledPackageState,
  isReinstall: boolean = false,
  deps: UpdateCommandDeps = defaultDeps
): Promise<void> {
  const nextState = deps.readInstalledPackageState(currentInstall);
  const installedVersion = nextState.version;
  if (!installedVersion) {
    console.log('');
    console.log(
      fail('Update finished, but CCS could not verify the current installation version.')
    );
    console.log('');
    console.log('Current install remains ambiguous. Re-run manually:');
    console.log(color(`  ${deps.formatManualUpdateCommand(targetTag, currentInstall)}`, 'command'));
    console.log('');
    process.exit(1);
    return;
  }

  const installChanged =
    previousState !== undefined &&
    (previousState.version !== nextState.version ||
      previousState.packageJsonMtimeMs !== nextState.packageJsonMtimeMs ||
      previousState.scriptMtimeMs !== nextState.scriptMtimeMs);

  if (expectedVersion && installedVersion !== expectedVersion) {
    const postUpdateResult = await deps.checkForUpdates(
      installedVersion,
      true,
      'npm',
      targetTag as TargetTag
    );

    if (postUpdateResult.status === 'no_update') {
      return;
    }

    if (
      postUpdateResult.status === 'update_available' &&
      postUpdateResult.latest === installedVersion
    ) {
      return;
    }

    const comparison = deps.compareVersionsWithPrerelease(installedVersion, expectedVersion);
    if (comparison < 0 || installedVersion === previousState?.version) {
      console.log('');
      console.log(
        fail(
          `Update completed outside the current installation. Current binary still reports ${installedVersion}; expected ${expectedVersion}.`
        )
      );
      if (previousState?.version && previousState.version === installedVersion) {
        console.log(
          warn(
            `The current install path did not change from ${previousState.version}; another package manager likely updated a different copy of CCS.`
          )
        );
      }
      console.log('');
      console.log('Re-run manually against the current install:');
      console.log(
        color(`  ${deps.formatManualUpdateCommand(targetTag, currentInstall)}`, 'command')
      );
      console.log('');
      process.exit(1);
      return;
    }
  }

  if (
    isReinstall &&
    previousState?.version &&
    installedVersion === previousState.version &&
    !installChanged
  ) {
    console.log('');
    console.log(
      warn(
        `Reinstall completed, but CCS could not prove that the current installation changed from ${previousState.version}. Verify the current binary manually if this reinstall was meant to repair a same-version install.`
      )
    );
  }
}

function runChildProcess(
  deps: UpdateCommandDeps,
  command: string,
  args: string[],
  options: {
    isWindows: boolean;
    env: NodeJS.ProcessEnv;
    filterCleanupWarnings?: boolean;
  }
): Promise<number> {
  return new Promise((resolve, reject) => {
    const { isWindows, env, filterCleanupWarnings = false } = options;
    const child = isWindows
      ? deps.spawn(`${command} ${args.join(' ')}`, [], {
          stdio: ['inherit', 'inherit', 'pipe'],
          shell: true,
          env: { ...env, NODE_NO_WARNINGS: '1' },
        })
      : deps.spawn(command, args, { stdio: 'inherit', env });

    if (isWindows && filterCleanupWarnings && child.stderr) {
      let stderrBuffer = '';
      child.stderr.on('data', (data: Buffer) => {
        stderrBuffer += data.toString();
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() || '';
        for (const line of lines) {
          if (!/npm warn cleanup/i.test(line)) {
            process.stderr.write(line + '\n');
          }
        }
      });
      child.stderr.on('close', () => {
        if (stderrBuffer && !/npm warn cleanup/i.test(stderrBuffer)) {
          process.stderr.write(stderrBuffer);
        }
      });
    }

    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

async function performNpmUpdate(
  currentInstall: CurrentInstall,
  targetTag: string = 'latest',
  isReinstall: boolean = false,
  expectedVersion?: string,
  deps: UpdateCommandDeps = defaultDeps
): Promise<void> {
  const packageManager = currentInstall.manager;
  let updateCommand: string;
  let updateArgs: string[];
  let cacheCommand: string | null;
  let cacheArgs: string[] | null;
  const childEnv = deps.buildPackageManagerEnv(currentInstall);
  const previousState = deps.readInstalledPackageState(currentInstall);

  switch (packageManager) {
    case 'npm':
      updateCommand = 'npm';
      updateArgs = ['install', '-g', `@kaitranntt/ccs@${targetTag}`];
      cacheCommand = 'npm';
      cacheArgs = ['cache', 'clean', '--force'];
      break;
    case 'yarn':
      updateCommand = 'yarn';
      updateArgs = ['global', 'add', `@kaitranntt/ccs@${targetTag}`];
      cacheCommand = 'yarn';
      cacheArgs = ['cache', 'clean'];
      break;
    case 'pnpm':
      updateCommand = 'pnpm';
      updateArgs = ['add', '-g', `@kaitranntt/ccs@${targetTag}`];
      cacheCommand = 'pnpm';
      cacheArgs = ['store', 'prune'];
      break;
    case 'bun':
      updateCommand = 'bun';
      updateArgs = ['add', '-g', `@kaitranntt/ccs@${targetTag}`];
      // On Windows, bun's global bin symlink may not update properly without removal first
      // Pre-remove to ensure clean reinstall (mirrors dev-install.sh behavior)
      cacheCommand = process.platform === 'win32' ? 'bun' : null;
      cacheArgs = process.platform === 'win32' ? ['remove', '-g', '@kaitranntt/ccs'] : null;
      break;
    default:
      updateCommand = 'npm';
      updateArgs = ['install', '-g', `@kaitranntt/ccs@${targetTag}`];
      cacheCommand = 'npm';
      cacheArgs = ['cache', 'clean', '--force'];
  }

  console.log(info(`${isReinstall ? 'Reinstalling' : 'Updating'} via ${packageManager}...`));
  console.log('');

  const isWindows = process.platform === 'win32';

  if (cacheCommand && cacheArgs) {
    // For bun on Windows, we pre-remove instead of cache clear
    const isBunPreRemove = packageManager === 'bun' && cacheArgs.includes('remove');
    const stepMessage = isBunPreRemove
      ? 'Removing existing installation...'
      : 'Clearing package cache...';
    const failMessage = isBunPreRemove
      ? 'Pre-removal failed, proceeding anyway...'
      : 'Cache clearing failed, proceeding anyway...';

    console.log(info(stepMessage));
    try {
      const cacheCode = await runChildProcess(deps, cacheCommand, cacheArgs, {
        isWindows,
        env: childEnv,
      });
      if (cacheCode !== 0) {
        console.log(warn(failMessage));
      }
    } catch {
      console.log(warn(failMessage));
    }
  }

  try {
    const exitCode = await runChildProcess(deps, updateCommand, updateArgs, {
      isWindows,
      env: childEnv,
      filterCleanupWarnings: true,
    });

    if (exitCode === 0) {
      if (expectedVersion || previousState?.version) {
        await verifyCurrentInstallVersion(
          currentInstall,
          targetTag,
          expectedVersion,
          previousState,
          isReinstall,
          deps
        );
      }
      console.log('');
      console.log(ok(`${isReinstall ? 'Reinstall' : 'Update'} successful!`));
      console.log('');
      console.log(`Run ${color('ccs --version', 'command')} to verify`);
      console.log(info(`Tip: Use ${color('ccs config', 'command')} for web-based configuration`));
      console.log('');
    } else {
      console.log('');
      console.log(fail(`${isReinstall ? 'Reinstall' : 'Update'} failed`));
      console.log('');
      console.log('Try manually:');
      console.log(
        color(`  ${deps.formatManualUpdateCommand(targetTag, currentInstall)}`, 'command')
      );
      console.log('');
    }

    process.exit(exitCode || 0);
  } catch {
    console.log('');
    console.log(fail(`Failed to run ${packageManager} ${isReinstall ? 'reinstall' : 'update'}`));
    console.log('');
    console.log('Try manually:');
    console.log(color(`  ${deps.formatManualUpdateCommand(targetTag, currentInstall)}`, 'command'));
    console.log('');
    process.exit(1);
  }
}
