export type ProviderId = 'claude' | 'codex';
export type ConnectionStatus = 'menyambung' | 'tersambung' | 'gagal';
export type PermissionState = 'nyala' | 'mati' | 'tidak-diketahui';
export type UiScale = 'compact' | 'comfortable';
export type BrowserKind = 'googleChrome' | 'chromium' | 'custom';

export interface ModelOption {
  id: string;
  label: string;
  description?: string | null;
}

export interface AgentInfo {
  id: ProviderId;
  label: string;
  name: string;
  sessionId: string;
  threadId: string;
  cwd: string;
  supportsImagePrompt: boolean;
  models: ModelOption[];
  selectedModel?: string | null;
  supportsModelSelection: boolean;
}

export interface ThreadPreference {
  id: string;
  title: string;
}

export interface WorkspacePreference {
  path: string;
  name: string;
  threads: ThreadPreference[];
  selectedThreadId?: string | null;
}

export interface AppSettings {
  fullPermissions: boolean;
  workspaces: WorkspacePreference[];
  selectedWorkspace?: string | null;
  defaultProvider: ProviderId;
  selectedModels: Record<string, string>;
  sidebarCollapsed: boolean;
  uiScale: UiScale;
  midscene: {
    baseUrl?: string | null;
    modelName?: string | null;
    modelFamily?: string | null;
  };
  browser: {
    kind: BrowserKind;
    executablePath?: string | null;
  };
}

export interface MidsceneConfigView {
  baseUrl: string;
  modelName: string;
  modelFamily: string;
  apiKeyConfigured: boolean;
  apiKeySource: 'keychain' | 'environment' | 'none';
  configSource: 'settings' | 'environment' | 'new';
  modelFamilies: string[];
}

export interface MidsceneTestResult {
  summary: string;
  model: string;
  stages: Array<{ id: string; label: string; detail: string }>;
}

export interface ProviderAccountInfo {
  id: 'codex' | 'claude' | 'midscene';
  provider: string;
  adapterAvailable: boolean;
  adapterPath?: string | null;
  cliAvailable: boolean;
  authenticationStatus:
    | 'authenticated'
    | 'notAuthenticated'
    | 'configured'
    | 'notConfigured'
    | 'unknown';
  account?: string | null;
  environment: string[];
  loginCommand?: string | null;
  detail: string;
}

export interface BrowserOption {
  id: 'googleChrome' | 'chromium' | 'safari';
  label: string;
  available: boolean;
  executablePath?: string | null;
  detail: string;
}

export interface MacosPermissionInfo {
  id: string;
  label: string;
  status:
    | 'granted'
    | 'notGranted'
    | 'notRequested'
    | 'requiresManualVerification'
    | 'unsupported'
    | 'notRequired';
  detail: string;
  canRequest: boolean;
  canOpenSettings: boolean;
}

export interface AddWorkspaceResult {
  settings: AppSettings;
  added: boolean;
}

export interface ModelState {
  models: ModelOption[];
  selectedModel?: string | null;
  supportsModelSelection: boolean;
}

export const PROVIDERS: ReadonlyArray<{ id: ProviderId; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
];

export const DEFAULT_SETTINGS: AppSettings = {
  fullPermissions: false,
  workspaces: [],
  selectedWorkspace: null,
  defaultProvider: 'claude',
  selectedModels: {},
  sidebarCollapsed: false,
  uiScale: 'comfortable',
  midscene: {
    baseUrl: null,
    modelName: null,
    modelFamily: null,
  },
  browser: {
    kind: 'googleChrome',
    executablePath: null,
  },
};

export function normalizeSettings(value: Partial<AppSettings> | null | undefined): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    workspaces: Array.isArray(value?.workspaces) ? value.workspaces : [],
    selectedModels: value?.selectedModels ?? {},
    defaultProvider: value?.defaultProvider === 'codex' ? 'codex' : 'claude',
    uiScale: value?.uiScale === 'compact' ? 'compact' : 'comfortable',
    midscene: {
      ...DEFAULT_SETTINGS.midscene,
      ...(value?.midscene ?? {}),
    },
    browser: {
      ...DEFAULT_SETTINGS.browser,
      ...(value?.browser ?? {}),
      kind: value?.browser?.kind === 'chromium' || value?.browser?.kind === 'custom'
        ? value.browser.kind
        : 'googleChrome',
    },
  };
}

export function providerLabel(provider: string): string {
  return PROVIDERS.find((item) => item.id === provider)?.label ?? provider;
}
