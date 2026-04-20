import { getBrowserConfig } from '../../config/unified-config-loader';
import { getCcsPathDisplay } from '../config-manager';
import { getCodexBinaryInfo } from '../../targets/codex-detector';
import { type BrowserRuntimeEnv, resolveBrowserRuntimeEnv } from './chrome-reuse';
import { getBrowserMcpServerName, getBrowserMcpServerPath } from './mcp-installer';
import { getNodePlatformKey } from './platform';
import {
  buildBrowserLaunchCommands,
  buildManagedBrowserAttachSetupOptions,
  type BrowserLaunchCommands,
  getEffectiveClaudeBrowserAttachConfig,
  getRecommendedBrowserUserDataDir,
  isManagedClaudeBrowserAttachConfig,
} from './browser-settings';

export interface ClaudeBrowserStatus {
  enabled: boolean;
  source: 'config' | 'CCS_BROWSER_USER_DATA_DIR' | 'CCS_BROWSER_PROFILE_DIR';
  overrideActive: boolean;
  state: 'disabled' | 'path_missing' | 'browser_not_running' | 'endpoint_unreachable' | 'ready';
  title: string;
  detail: string;
  nextStep: string;
  effectiveUserDataDir: string;
  recommendedUserDataDir: string;
  devtoolsPort: number;
  managedMcpServerName: string;
  managedMcpServerPath: string;
  launchCommands: BrowserLaunchCommands;
  runtimeEnv?: BrowserRuntimeEnv;
}

export interface CodexBrowserStatus {
  enabled: boolean;
  state: 'disabled' | 'enabled' | 'unsupported_build';
  title: string;
  detail: string;
  nextStep: string;
  serverName: string;
  supportsConfigOverrides: boolean;
  binaryPath: string | null;
  version?: string;
}

export interface BrowserStatusPayload {
  claude: ClaudeBrowserStatus;
  codex: CodexBrowserStatus;
}

export async function getBrowserStatus(): Promise<BrowserStatusPayload> {
  const browserConfig = getBrowserConfig();
  return {
    claude: await buildClaudeBrowserStatus(browserConfig),
    codex: buildCodexBrowserStatus(browserConfig),
  };
}

async function buildClaudeBrowserStatus(
  browserConfig = getBrowserConfig()
): Promise<ClaudeBrowserStatus> {
  const effective = getEffectiveClaudeBrowserAttachConfig(browserConfig);
  const launchCommands = buildBrowserLaunchCommands(effective.userDataDir, effective.devtoolsPort);
  const base: Omit<ClaudeBrowserStatus, 'state' | 'title' | 'detail' | 'nextStep'> = {
    enabled: effective.enabled,
    source: effective.source,
    overrideActive: effective.overrideActive,
    effectiveUserDataDir: effective.userDataDir,
    recommendedUserDataDir: getRecommendedBrowserUserDataDir(),
    devtoolsPort: effective.devtoolsPort,
    managedMcpServerName: getBrowserMcpServerName(),
    managedMcpServerPath: getBrowserMcpServerPath(),
    launchCommands,
  };

  if (!effective.enabled) {
    return {
      ...base,
      state: 'disabled',
      title: 'Claude Browser Attach is disabled.',
      detail:
        'CCS will not provision the managed browser MCP runtime for Claude launches until this lane is enabled.',
      nextStep: `Enable Claude Browser Attach in Settings > Browser or in ${getCcsPathDisplay('config.yaml')}, then rerun \`ccs browser doctor\`.`,
    };
  }

  try {
    const runtimeEnv = await resolveBrowserRuntimeEnv({
      profileDir: effective.userDataDir,
      devtoolsPort: effective.hasExplicitDevtoolsPort ? String(effective.devtoolsPort) : undefined,
    });

    return {
      ...base,
      state: 'ready',
      title: 'Claude Browser Attach is ready.',
      detail:
        'CCS can reach the configured Chrome DevTools endpoint for the current attach session.',
      nextStep: 'Launch a Claude-target CCS session to use the managed browser MCP runtime.',
      runtimeEnv,
    };
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes('Chrome profile directory is invalid')) {
      return {
        ...base,
        state: 'path_missing',
        title: 'Claude Browser Attach path is missing.',
        detail: message,
        nextStep: isManagedClaudeBrowserAttachConfig(effective)
          ? buildManagedBrowserAttachSetupOptions(effective).join('\n')
          : `Create or choose a Chrome user-data directory, then launch Chrome with attach mode enabled. Example: ${launchCommands[getNodePlatformKey()]}`,
      };
    }

    if (message.includes('Chrome reuse metadata')) {
      return {
        ...base,
        state: 'browser_not_running',
        title: 'Claude Browser Attach could not find a running browser session.',
        detail: message,
        nextStep: isManagedClaudeBrowserAttachConfig(effective)
          ? buildManagedBrowserAttachSetupOptions(effective).join('\n')
          : `Start Chrome with remote debugging and the configured user-data dir. Example: ${launchCommands[getNodePlatformKey()]}`,
      };
    }

    return {
      ...base,
      state: 'endpoint_unreachable',
      title: 'Claude Browser Attach could not reach the DevTools endpoint.',
      detail: message,
      nextStep: isManagedClaudeBrowserAttachConfig(effective)
        ? buildManagedBrowserAttachSetupOptions(effective).join('\n')
        : `Restart the attach browser session or confirm the configured port. Example: ${launchCommands[getNodePlatformKey()]}`,
    };
  }
}

function buildCodexBrowserStatus(browserConfig = getBrowserConfig()): CodexBrowserStatus {
  if (!browserConfig.codex.enabled) {
    return {
      enabled: false,
      state: 'disabled',
      title: 'Codex Browser Tools are disabled.',
      detail: 'CCS will not inject Playwright MCP browser tooling into Codex-target launches.',
      nextStep:
        'Enable Codex Browser Tools in Settings > Browser to restore the managed Codex browser path.',
      serverName: 'ccs_browser',
      supportsConfigOverrides: false,
      binaryPath: null,
    };
  }

  const binaryInfo = getCodexBinaryInfo({ includeVersion: true, includeFeatures: true });
  const supportsConfigOverrides = Boolean(binaryInfo?.features?.includes('config-overrides'));
  if (!binaryInfo || !supportsConfigOverrides) {
    return {
      enabled: true,
      state: 'unsupported_build',
      title: 'Codex Browser Tools need a Codex build with --config override support.',
      detail: binaryInfo
        ? `Detected Codex at ${binaryInfo.path}, but it does not advertise --config overrides.`
        : 'No Codex binary was detected, so CCS cannot confirm managed browser override support.',
      nextStep: 'Install or upgrade Codex, then rerun browser status/doctor.',
      serverName: 'ccs_browser',
      supportsConfigOverrides,
      binaryPath: binaryInfo?.path ?? null,
      version: binaryInfo?.version,
    };
  }

  return {
    enabled: true,
    state: 'enabled',
    title: 'Codex Browser Tools are enabled.',
    detail: 'CCS can inject the managed Playwright MCP overrides into Codex-target launches.',
    nextStep: 'Use a Codex-target CCS launch to access browser tools.',
    serverName: 'ccs_browser',
    supportsConfigOverrides,
    binaryPath: binaryInfo.path,
    version: binaryInfo.version,
  };
}
