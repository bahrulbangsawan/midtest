// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { DEFAULT_SETTINGS, type AppSettings } from '@/lib/app-types';

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: native.open }));

const { SettingsPage } = await import('./SettingsPage');

const SETTINGS: AppSettings = {
  ...DEFAULT_SETTINGS,
  workspaces: [{
    path: '/tmp/project',
    name: 'project',
    selectedThreadId: 'thread-1',
    threads: [{ id: 'thread-1', title: 'New thread' }],
  }],
  selectedWorkspace: '/tmp/project',
};

function renderSettings(overrides: Partial<React.ComponentProps<typeof SettingsPage>> = {}) {
  const props: React.ComponentProps<typeof SettingsPage> = {
    settings: SETTINGS,
    agent: {
      id: 'claude',
      label: 'Claude',
      name: 'claude-agent-acp',
      sessionId: 'session-1',
      threadId: 'thread-1',
      cwd: '/tmp/project',
      supportsImagePrompt: false,
      models: [{ id: 'sonnet', label: 'Claude Sonnet' }],
      selectedModel: 'sonnet',
      supportsModelSelection: true,
    },
    status: 'tersambung',
    statusLabel: 'Connected',
    permission: 'mati',
    changingPermission: false,
    changingModel: false,
    openingWorkspace: false,
    onSelectProvider: vi.fn(),
    onSelectModel: vi.fn(),
    onSetPermission: vi.fn(),
    onAddWorkspace: vi.fn(),
    onSelectWorkspace: vi.fn(),
    onSidebarCollapsedChange: vi.fn(),
    onUiScaleChange: vi.fn(),
    onBrowserChange: vi.fn(),
    onSettingsReplaced: vi.fn(),
    ...overrides,
  };
  return { ...render(<SettingsPage {...props} />), props };
}

beforeEach(() => {
  native.invoke.mockReset();
  native.open.mockReset();
  native.open.mockResolvedValue(null);
  native.invoke.mockImplementation((command: string) => {
    if (command === 'get_provider_accounts') return Promise.resolve([]);
    if (command === 'get_midscene_config') return Promise.resolve({
      baseUrl: 'https://openrouter.ai/api/v1',
      modelName: '',
      modelFamily: '',
      apiKeyConfigured: false,
      apiKeySource: 'none',
      configSource: 'new',
      modelFamilies: ['gpt-5', 'qwen2.5-vl'],
    });
    if (command === 'detect_browsers') return Promise.resolve([]);
    if (command === 'get_macos_permissions') return Promise.resolve([]);
    if (command === 'get_app_settings') return Promise.resolve(SETTINGS);
    return Promise.resolve(undefined);
  });
});

afterEach(cleanup);

test('exposes every requested settings section through one responsive inner navigation', () => {
  renderSettings();

  for (const label of [
    'General',
    'Agents',
    'AI Provider Accounts',
    'Midscene / Vision Model',
    'Browser',
    'Permissions',
    'Workspace',
    'Appearance',
    'Advanced',
  ]) {
    const button = screen.getByRole('button', { name: label });
    fireEvent.click(button);
    expect(screen.getByRole('heading', { level: 1, name: label })).toBeDefined();
    expect(button.getAttribute('aria-current')).toBe('page');
  }
});

test('reports external provider authentication and invokes only the fixed vendor login action', async () => {
  native.invoke.mockImplementation((command: string) => {
    if (command === 'get_provider_accounts') return Promise.resolve([
      {
        id: 'codex', provider: 'Codex / OpenAI', adapterAvailable: true,
        adapterPath: '/opt/homebrew/bin/codex-acp', cliAvailable: true,
        authenticationStatus: 'authenticated', account: 'ChatGPT account',
        environment: [], loginCommand: 'codex login', detail: 'Logged in using ChatGPT.',
      },
      {
        id: 'claude', provider: 'Claude / Anthropic', adapterAvailable: true,
        adapterPath: '/opt/homebrew/bin/claude-agent-acp', cliAvailable: true,
        authenticationStatus: 'authenticated', account: 'Claude account',
        environment: [], loginCommand: 'claude auth login', detail: 'Claude CLI is authenticated.',
      },
      {
        id: 'midscene', provider: 'Midscene vision model', adapterAvailable: true,
        cliAvailable: false, authenticationStatus: 'configured', account: null,
        environment: ['MIDSCENE_MODEL_API_KEY is set'], loginCommand: null,
        detail: 'Vision provider is configured.',
      },
    ]);
    return Promise.resolve(undefined);
  });
  renderSettings();
  fireEvent.click(screen.getByRole('button', { name: 'AI Provider Accounts' }));

  expect(await screen.findByRole('heading', { name: 'Codex / OpenAI' })).toBeDefined();
  expect(screen.getByRole('heading', { name: 'Claude / Anthropic' })).toBeDefined();
  expect(screen.getByRole('heading', { name: 'Midscene vision model' })).toBeDefined();
  fireEvent.click(screen.getAllByRole('button', { name: 'Re-authenticate' })[0]);
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('open_provider_login', { provider: 'codex' }));
});

test('keeps the Midscene key masked and blank after save while showing rich test stages', async () => {
  const view = {
    baseUrl: 'https://openrouter.ai/api/v1',
    modelName: 'openai/gpt-5',
    modelFamily: 'gpt-5',
    apiKeyConfigured: true,
    apiKeySource: 'keychain',
    configSource: 'settings',
    modelFamilies: ['gpt-5', 'qwen2.5-vl'],
  } as const;
  native.invoke.mockImplementation((command: string) => {
    if (command === 'get_midscene_config' || command === 'save_midscene_config') return Promise.resolve(view);
    if (command === 'get_app_settings') return Promise.resolve({
      ...SETTINGS,
      midscene: { baseUrl: view.baseUrl, modelName: view.modelName, modelFamily: view.modelFamily },
    });
    if (command === 'test_midscene_connection') return Promise.resolve({
      summary: 'The endpoint accepted a minimal multimodal request.',
      model: view.modelName,
      stages: [
        { id: 'endpoint', label: 'Endpoint reachable', detail: 'The models catalog responded.' },
        { id: 'model', label: 'Model found', detail: view.modelName },
        { id: 'request', label: 'Vision request accepted', detail: 'A non-empty response was returned.' },
      ],
    });
    return Promise.resolve(undefined);
  });
  const { props } = renderSettings();
  fireEvent.click(screen.getByRole('button', { name: 'Midscene / Vision Model' }));

  const secret = await screen.findByLabelText('MIDSCENE_MODEL_API_KEY') as HTMLInputElement;
  expect(secret.type).toBe('password');
  expect(secret.value).toBe('');
  expect(document.body.textContent).not.toContain('stored-secret');
  fireEvent.change(secret, { target: { value: 'stored-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Show API key' }));
  expect(secret.type).toBe('text');
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));

  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('save_midscene_config', {
    value: {
      baseUrl: view.baseUrl,
      modelName: view.modelName,
      modelFamily: view.modelFamily,
      apiKey: 'stored-secret',
    },
  }));
  await waitFor(() => expect(secret.value).toBe(''));
  expect(secret.type).toBe('password');
  expect(props.onSettingsReplaced).toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
  expect(await screen.findByText('Vision request accepted')).toBeDefined();
  expect(screen.getByText('The endpoint accepted a minimal multimodal request.')).toBeDefined();
});

test('disables unsupported Safari and exposes truthful macOS permission actions', async () => {
  native.invoke.mockImplementation((command: string) => {
    if (command === 'detect_browsers') return Promise.resolve([
      { id: 'googleChrome', label: 'Google Chrome', available: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', detail: 'Detected.' },
      { id: 'chromium', label: 'Chromium', available: false, executablePath: null, detail: 'Not found.' },
      { id: 'safari', label: 'Safari', available: false, executablePath: null, detail: 'Unavailable: the current adapter uses Puppeteer.' },
    ]);
    if (command === 'get_macos_permissions') return Promise.resolve([
      { id: 'accessibility', label: 'Accessibility', status: 'granted', detail: 'Verified by macOS.', canRequest: false, canOpenSettings: true },
      { id: 'screenRecording', label: 'Screen Recording', status: 'notGranted', detail: 'Verified by macOS.', canRequest: true, canOpenSettings: true },
      { id: 'fullDiskAccess', label: 'Full Disk Access', status: 'requiresManualVerification', detail: 'macOS does not expose a reliable public check.', canRequest: false, canOpenSettings: true },
    ]);
    return Promise.resolve(undefined);
  });
  const onBrowserChange = vi.fn();
  renderSettings({ onBrowserChange });

  fireEvent.click(screen.getByRole('button', { name: 'Browser' }));
  const safari = await screen.findByRole('radio', { name: /Safari/ });
  expect((safari as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Why Safari is unavailable')).toBeDefined();
  fireEvent.click(screen.getByRole('radio', { name: /Google Chrome/ }));
  expect(onBrowserChange).toHaveBeenCalledWith({
    kind: 'googleChrome',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });

  fireEvent.click(screen.getByRole('button', { name: 'Permissions' }));
  expect(await screen.findByRole('heading', { name: 'Accessibility' })).toBeDefined();
  expect(screen.getByText('Requires manual verification')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Trigger Permission Prompt' }));
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('request_macos_permission', { permission: 'screenRecording' }));
});
