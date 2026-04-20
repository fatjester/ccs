import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getBrowserConfig,
  mutateUnifiedConfig,
} from '../../../../src/config/unified-config-loader';
import * as chromeReuse from '../../../../src/utils/browser/chrome-reuse';
import { getBrowserStatus } from '../../../../src/utils/browser/browser-status';
import {
  getEffectiveClaudeBrowserAttachConfig,
  resolveOptionalBrowserAttachRuntime,
} from '../../../../src/utils/browser/browser-settings';
import * as codexDetector from '../../../../src/targets/codex-detector';

describe('browser status', () => {
  let tempHome = '';
  let originalCcsHome: string | undefined;
  let originalBrowserUserDataDir: string | undefined;
  let originalBrowserProfileDir: string | undefined;
  let originalBrowserDevtoolsPort: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'ccs-browser-status-'));
    originalCcsHome = process.env.CCS_HOME;
    originalBrowserUserDataDir = process.env.CCS_BROWSER_USER_DATA_DIR;
    originalBrowserProfileDir = process.env.CCS_BROWSER_PROFILE_DIR;
    originalBrowserDevtoolsPort = process.env.CCS_BROWSER_DEVTOOLS_PORT;

    process.env.CCS_HOME = tempHome;
    delete process.env.CCS_BROWSER_USER_DATA_DIR;
    delete process.env.CCS_BROWSER_PROFILE_DIR;
    delete process.env.CCS_BROWSER_DEVTOOLS_PORT;
  });

  afterEach(() => {
    if (originalCcsHome !== undefined) {
      process.env.CCS_HOME = originalCcsHome;
    } else {
      delete process.env.CCS_HOME;
    }

    if (originalBrowserUserDataDir !== undefined) {
      process.env.CCS_BROWSER_USER_DATA_DIR = originalBrowserUserDataDir;
    } else {
      delete process.env.CCS_BROWSER_USER_DATA_DIR;
    }

    if (originalBrowserProfileDir !== undefined) {
      process.env.CCS_BROWSER_PROFILE_DIR = originalBrowserProfileDir;
    } else {
      delete process.env.CCS_BROWSER_PROFILE_DIR;
    }

    if (originalBrowserDevtoolsPort !== undefined) {
      process.env.CCS_BROWSER_DEVTOOLS_PORT = originalBrowserDevtoolsPort;
    } else {
      delete process.env.CCS_BROWSER_DEVTOOLS_PORT;
    }

    rmSync(tempHome, { recursive: true, force: true });
  });

  it('returns a disabled Claude lane with the recommended managed user-data dir by default', async () => {
    const codexSpy = spyOn(codexDetector, 'getCodexBinaryInfo').mockReturnValue({
      path: '/usr/local/bin/codex',
      needsShell: false,
      version: 'codex-cli 0.120.0',
      features: ['config-overrides'],
    });

    try {
      const status = await getBrowserStatus();

      expect(status.claude).toMatchObject({
        enabled: false,
        state: 'disabled',
        source: 'config',
        effectiveUserDataDir: join(tempHome, '.ccs', 'browser', 'chrome-user-data'),
        devtoolsPort: 9222,
        managedMcpServerName: 'ccs-browser',
      });
      expect(status.claude.launchCommands.linux).toContain('--remote-debugging-port=9222');
      expect(status.codex).toMatchObject({
        enabled: true,
        state: 'enabled',
        serverName: 'ccs_browser',
        supportsConfigOverrides: true,
      });
    } finally {
      codexSpy.mockRestore();
    }
  });

  it('prefers CCS_BROWSER_USER_DATA_DIR over config when an env override is present', async () => {
    mutateUnifiedConfig((config) => {
      config.browser = {
        claude: {
          enabled: true,
          user_data_dir: '/config-browser',
          devtools_port: 9333,
        },
        codex: {
          enabled: true,
        },
      };
    });
    process.env.CCS_BROWSER_USER_DATA_DIR = '/env-browser';
    process.env.CCS_BROWSER_DEVTOOLS_PORT = '9444';

    const runtimeSpy = spyOn(chromeReuse, 'resolveBrowserRuntimeEnv').mockResolvedValue({
      CCS_BROWSER_USER_DATA_DIR: '/env-browser',
      CCS_BROWSER_DEVTOOLS_HOST: '127.0.0.1',
      CCS_BROWSER_DEVTOOLS_PORT: '9444',
      CCS_BROWSER_DEVTOOLS_HTTP_URL: 'http://127.0.0.1:9444',
      CCS_BROWSER_DEVTOOLS_WS_URL: 'ws://127.0.0.1/devtools/browser/test',
    });
    const codexSpy = spyOn(codexDetector, 'getCodexBinaryInfo').mockReturnValue({
      path: '/usr/local/bin/codex',
      needsShell: false,
      version: 'codex-cli 0.120.0',
      features: ['config-overrides'],
    });

    try {
      const status = await getBrowserStatus();

      expect(status.claude).toMatchObject({
        enabled: true,
        state: 'ready',
        source: 'CCS_BROWSER_USER_DATA_DIR',
        effectiveUserDataDir: '/env-browser',
        devtoolsPort: 9444,
      });
      expect(status.claude.runtimeEnv?.CCS_BROWSER_DEVTOOLS_PORT).toBe('9444');
    } finally {
      runtimeSpy.mockRestore();
      codexSpy.mockRestore();
    }
  });

  it('returns a structured warning when the managed browser dir does not exist yet', async () => {
    mutateUnifiedConfig((config) => {
      config.browser = {
        claude: {
          enabled: true,
          user_data_dir: '',
          devtools_port: 9222,
        },
        codex: {
          enabled: true,
        },
      };
    });

    const resolution = await resolveOptionalBrowserAttachRuntime(
      getEffectiveClaudeBrowserAttachConfig(getBrowserConfig())
    );

    expect(resolution.runtimeEnv).toBeUndefined();
    expect(resolution.warning).toContain('Claude Browser Attach is not ready yet.');
    expect(resolution.warning).toContain(
      `Managed user-data dir: ${join(tempHome, '.ccs', 'browser', 'chrome-user-data')}`
    );
    expect(resolution.warning).toContain('CCS will continue without browser tools for this launch.');
    expect(resolution.warning).toContain('ccs browser doctor');
    expect(resolution.warning).toContain('.ccs/config.yaml');
  });

  it('returns the same structured warning when the managed browser dir exists but no attach session is running', async () => {
    mutateUnifiedConfig((config) => {
      config.browser = {
        claude: {
          enabled: true,
          user_data_dir: '',
          devtools_port: 9222,
        },
        codex: {
          enabled: true,
        },
      };
    });
    mkdirSync(join(tempHome, '.ccs', 'browser', 'chrome-user-data'), { recursive: true });

    const resolution = await resolveOptionalBrowserAttachRuntime(
      getEffectiveClaudeBrowserAttachConfig(getBrowserConfig())
    );

    expect(resolution.runtimeEnv).toBeUndefined();
    expect(resolution.warning).toContain('Claude Browser Attach is not ready yet.');
    expect(resolution.warning).toContain(
      `Managed user-data dir: ${join(tempHome, '.ccs', 'browser', 'chrome-user-data')}`
    );
    expect(resolution.warning).toContain('CCS will continue without browser tools for this launch.');
    expect(resolution.warning).toContain('ccs browser doctor');
    expect(resolution.warning).toContain('CCS_BROWSER_USER_DATA_DIR / CCS_BROWSER_DEVTOOLS_PORT');
  });

  it('reports browser_not_running when attach metadata is missing', async () => {
    mutateUnifiedConfig((config) => {
      config.browser = {
        claude: {
          enabled: true,
          user_data_dir: '/tmp/browser-profile',
          devtools_port: 9222,
        },
        codex: {
          enabled: true,
        },
      };
    });

    const runtimeSpy = spyOn(chromeReuse, 'resolveBrowserRuntimeEnv').mockRejectedValue(
      new Error('Chrome reuse metadata not found: /tmp/browser-profile/DevToolsActivePort')
    );
    const codexSpy = spyOn(codexDetector, 'getCodexBinaryInfo').mockReturnValue({
      path: '/usr/local/bin/codex',
      needsShell: false,
      version: 'codex-cli 0.120.0',
      features: ['config-overrides'],
    });

    try {
      const status = await getBrowserStatus();

      expect(status.claude.state).toBe('browser_not_running');
      expect(status.claude.detail).toContain('DevToolsActivePort');
      expect(status.claude.nextStep).toContain('--remote-debugging-port=9222');
    } finally {
      runtimeSpy.mockRestore();
      codexSpy.mockRestore();
    }
  });

  it('preserves legacy metadata-based port discovery when only CCS_BROWSER_PROFILE_DIR is set', async () => {
    process.env.CCS_BROWSER_PROFILE_DIR = '/legacy-browser';

    const runtimeSpy = spyOn(chromeReuse, 'resolveBrowserRuntimeEnv').mockResolvedValue({
      CCS_BROWSER_USER_DATA_DIR: '/legacy-browser',
      CCS_BROWSER_DEVTOOLS_HOST: '127.0.0.1',
      CCS_BROWSER_DEVTOOLS_PORT: '50123',
      CCS_BROWSER_DEVTOOLS_HTTP_URL: 'http://127.0.0.1:50123',
      CCS_BROWSER_DEVTOOLS_WS_URL: 'ws://127.0.0.1/devtools/browser/legacy',
    });
    const codexSpy = spyOn(codexDetector, 'getCodexBinaryInfo').mockReturnValue({
      path: '/usr/local/bin/codex',
      needsShell: false,
      version: 'codex-cli 0.120.0',
      features: ['config-overrides'],
    });

    try {
      const status = await getBrowserStatus();

      expect(runtimeSpy.mock.calls[0]?.[0]).toEqual({
        profileDir: '/legacy-browser',
        devtoolsPort: undefined,
      });
      expect(status.claude.runtimeEnv?.CCS_BROWSER_DEVTOOLS_PORT).toBe('50123');
    } finally {
      runtimeSpy.mockRestore();
      codexSpy.mockRestore();
    }
  });

  it('always forwards an explicit port for config-backed browser attach sessions', async () => {
    mutateUnifiedConfig((config) => {
      config.browser = {
        claude: {
          enabled: true,
          user_data_dir: '/tmp/config-browser',
          devtools_port: 9222,
        },
        codex: {
          enabled: true,
        },
      };
    });

    const runtimeSpy = spyOn(chromeReuse, 'resolveBrowserRuntimeEnv').mockResolvedValue({
      CCS_BROWSER_USER_DATA_DIR: '/tmp/config-browser',
      CCS_BROWSER_DEVTOOLS_HOST: '127.0.0.1',
      CCS_BROWSER_DEVTOOLS_PORT: '9222',
      CCS_BROWSER_DEVTOOLS_HTTP_URL: 'http://127.0.0.1:9222',
      CCS_BROWSER_DEVTOOLS_WS_URL: 'ws://127.0.0.1/devtools/browser/config',
    });
    const codexSpy = spyOn(codexDetector, 'getCodexBinaryInfo').mockReturnValue({
      path: '/usr/local/bin/codex',
      needsShell: false,
      version: 'codex-cli 0.120.0',
      features: ['config-overrides'],
    });

    try {
      await getBrowserStatus();

      expect(runtimeSpy.mock.calls[0]?.[0]).toEqual({
        profileDir: '/tmp/config-browser',
        devtoolsPort: '9222',
      });
    } finally {
      runtimeSpy.mockRestore();
      codexSpy.mockRestore();
    }
  });
});
