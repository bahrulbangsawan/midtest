import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useEffect, useMemo, useState } from 'react';
import {
  BotIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  FolderOpenIcon,
  GaugeIcon,
  InfoIcon,
  KeyRoundIcon,
  LaptopIcon,
  LockKeyholeIcon,
  LockOpenIcon,
  NetworkIcon,
  PaletteIcon,
  PanelLeftIcon,
  RefreshCwIcon,
  SaveIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  TerminalIcon,
  TestTube2Icon,
  UserRoundCogIcon,
  VideoIcon,
  XCircleIcon,
} from 'lucide-react';

import { AgentLogo } from './AgentLogo';
import { Notice } from './Notice';
import type {
  AgentInfo,
  AppSettings,
  BrowserKind,
  BrowserOption,
  ConnectionStatus,
  MacosPermissionInfo,
  MidsceneConfigView,
  MidsceneTestResult,
  PermissionState,
  ProviderAccountInfo,
  ProviderId,
} from '@/lib/app-types';
import { normalizeSettings, PROVIDERS } from '@/lib/app-types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

type SettingsSectionId =
  | 'general'
  | 'agents'
  | 'accounts'
  | 'midscene'
  | 'browser'
  | 'permissions'
  | 'workspace'
  | 'appearance'
  | 'advanced';

interface SettingsPageProps {
  settings: AppSettings;
  agent: AgentInfo | null;
  status: ConnectionStatus;
  statusLabel: string;
  permission: PermissionState;
  changingPermission: boolean;
  changingModel: boolean;
  openingWorkspace: boolean;
  onSelectProvider: (provider: ProviderId) => void;
  onSelectModel: (modelId: string) => void;
  onSetPermission: (mode: 'ask' | 'full') => void;
  onAddWorkspace: () => void;
  onSelectWorkspace: (path: string) => void;
  onSidebarCollapsedChange: (collapsed: boolean) => void;
  onUiScaleChange: (scale: AppSettings['uiScale']) => void;
  onBrowserChange: (browser: AppSettings['browser']) => void;
  onSettingsReplaced: (settings: AppSettings) => void;
}

const NAVIGATION: ReadonlyArray<{
  id: SettingsSectionId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'general', label: 'General', icon: Settings2Icon },
  { id: 'agents', label: 'Agents', icon: BotIcon },
  { id: 'accounts', label: 'AI Provider Accounts', icon: UserRoundCogIcon },
  { id: 'midscene', label: 'Midscene / Vision Model', icon: SparklesIcon },
  { id: 'browser', label: 'Browser', icon: LaptopIcon },
  { id: 'permissions', label: 'Permissions', icon: ShieldCheckIcon },
  { id: 'workspace', label: 'Workspace', icon: FolderIcon },
  { id: 'appearance', label: 'Appearance', icon: PaletteIcon },
  { id: 'advanced', label: 'Advanced', icon: SlidersHorizontalIcon },
];

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'The settings action could not be completed.';
}

function SettingsHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="settings-page-header">
      <div className="min-w-0">
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? <div className="settings-page-action">{action}</div> : null}
    </header>
  );
}

function SettingSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-panel">
      <div className="settings-panel-heading">
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="settings-panel-body">{children}</div>
    </section>
  );
}

function StatusBadge({ value }: { value: string }) {
  const normalized = value.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
  const positive = value === 'authenticated' || value === 'configured' || value === 'granted';
  const negative = value === 'notAuthenticated' || value === 'notConfigured' || value === 'notGranted';
  return (
    <span className={cn('settings-status-badge', positive && 'is-positive', negative && 'is-negative')}>
      {positive ? <CheckCircle2Icon /> : negative ? <XCircleIcon /> : <CircleHelpIcon />}
      {normalized.charAt(0).toUpperCase() + normalized.slice(1)}
    </span>
  );
}

function GeneralSettings({ settings, agent, statusLabel }: Pick<SettingsPageProps, 'settings' | 'agent' | 'statusLabel'>) {
  const workspace = settings.workspaces.find((item) => item.path === settings.selectedWorkspace);
  return (
    <>
      <SettingsHeader
        title="General"
        description="Review the defaults that shape new sessions on this Mac."
      />
      <SettingSection title="Current setup" description="A quick view of the active desktop configuration.">
        <dl className="settings-summary-grid">
          <div><dt>Agent</dt><dd>{agent?.label ?? settings.defaultProvider}</dd></div>
          <div><dt>Connection</dt><dd>{statusLabel}</dd></div>
          <div><dt>Workspace</dt><dd title={workspace?.path}>{workspace?.name ?? 'No workspace'}</dd></div>
          <div><dt>Vision model</dt><dd>{settings.midscene.modelName ?? 'Environment / not configured'}</dd></div>
        </dl>
      </SettingSection>
      <Notice tone="info" title="Configuration stays local">
        Preferences are stored in the Tauri application settings. Midscene API keys are stored separately in macOS Keychain.
      </Notice>
    </>
  );
}

function AgentSettings(props: SettingsPageProps) {
  const selectedModel = props.agent?.models.find((model) => model.id === props.agent?.selectedModel);
  return (
    <>
      <SettingsHeader title="Agents" description="Choose the ACP adapter and model used for new sessions." />
      <SettingSection
        title="Agent default"
        description="Provider and model availability come from the live ACP adapter."
      >
        <div className="settings-choice-grid" role="group" aria-label="Default provider">
          {PROVIDERS.map((provider) => {
            const active = props.settings.defaultProvider === provider.id;
            return (
              <button
                key={provider.id}
                type="button"
                aria-pressed={active}
                onClick={() => props.onSelectProvider(provider.id)}
                className="choice-card"
              >
                <AgentLogo agent={provider.id} className="size-5" />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block text-sm font-medium">{provider.label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {provider.id === 'claude' ? 'Claude Code ACP adapter' : 'OpenAI Codex ACP adapter'}
                  </span>
                </span>
                {active ? <CheckIcon className="size-4 text-primary" /> : null}
              </button>
            );
          })}
        </div>
        <label className="settings-field mt-4 max-w-md" htmlFor="default-agent-model">
          <span>Default model</span>
          <select
            id="default-agent-model"
            aria-label="Default model"
            value={props.agent?.selectedModel ?? ''}
            onChange={(event) => props.onSelectModel(event.target.value)}
            disabled={props.status !== 'tersambung' || props.changingModel || !props.agent?.supportsModelSelection}
            className="select-input"
          >
            {!props.agent?.supportsModelSelection ? (
              <option value="">Managed by {props.settings.defaultProvider === 'claude' ? 'Claude' : 'Codex'}</option>
            ) : null}
            {props.agent?.models.map((model) => (
              <option key={model.id} value={model.id}>{model.label}</option>
            ))}
          </select>
          <small>
            {props.status === 'menyambung'
              ? 'Waiting for the adapter to report supported models.'
              : props.agent?.supportsModelSelection
                ? selectedModel?.description ?? 'Reported by the connected adapter.'
                : 'This adapter manages its own model selection.'}
          </small>
        </label>
      </SettingSection>
    </>
  );
}

function ProviderAccountsSettings({
  settings,
  onOpenMidscene,
}: {
  settings: AppSettings;
  onOpenMidscene: () => void;
}) {
  const [accounts, setAccounts] = useState<ProviderAccountInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<ProviderAccountInfo[]>('get_provider_accounts');
      setAccounts(Array.isArray(result) ? result : []);
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function login(provider: 'codex' | 'claude') {
    setAction(provider);
    setError(null);
    try {
      await invoke('open_provider_login', { provider });
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setAction(null);
    }
  }

  return (
    <>
      <SettingsHeader
        title="AI Provider Accounts"
        description="Inspect external CLI login and adapter availability without exposing credentials."
        action={<Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}><RefreshCwIcon className={cn(loading && 'animate-spin')} /> Refresh</Button>}
      />
      {error ? <Notice tone="error" title="Account status unavailable">{error}</Notice> : null}
      {loading && accounts.length === 0 ? (
        <div className="settings-loading" role="status">Checking provider CLIs and adapters…</div>
      ) : (
        <div className="settings-account-list">
          {accounts.map((account) => {
            const defaultAccount = account.id === settings.defaultProvider;
            return (
              <article className="settings-account-row" key={account.id}>
                <span className="settings-account-icon">
                  {account.id === 'midscene' ? <SparklesIcon /> : <AgentLogo agent={account.id} />}
                </span>
                <div className="settings-account-copy">
                  <div className="settings-account-title">
                    <h2>{account.provider}</h2>
                    {defaultAccount ? <span className="settings-inline-label">Default agent</span> : null}
                  </div>
                  <p>{account.account ?? account.detail}</p>
                  <div className="settings-account-meta">
                    <span>{account.adapterAvailable ? 'Adapter available' : 'Adapter missing'}</span>
                    {account.adapterPath ? <span title={account.adapterPath}>Detected locally</span> : null}
                    {account.environment.map((item) => <span key={item}>{item}</span>)}
                  </div>
                </div>
                <div className="settings-account-actions">
                  <StatusBadge value={account.authenticationStatus} />
                  {account.id === 'midscene' ? (
                    <Button variant="outline" size="sm" onClick={onOpenMidscene}>Configure</Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!account.cliAvailable || action === account.id}
                      onClick={() => void login(account.id as 'codex' | 'claude')}
                    >
                      <TerminalIcon /> {action === account.id ? 'Opening…' : account.authenticationStatus === 'authenticated' ? 'Re-authenticate' : 'Login'}
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <Notice tone="info" title="Authentication remains vendor-owned">
        Codex and Claude login run through their installed CLIs. Midscene uses a separate VLM provider API key.
      </Notice>
    </>
  );
}

function MidsceneSettings({ onSettingsReplaced }: Pick<SettingsPageProps, 'onSettingsReplaced'>) {
  const [config, setConfig] = useState<MidsceneConfigView | null>(null);
  const [baseUrl, setBaseUrl] = useState('https://openrouter.ai/api/v1');
  const [modelName, setModelName] = useState('');
  const [modelFamily, setModelFamily] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<MidsceneTestResult | null>(null);

  function applyView(view: MidsceneConfigView) {
    setConfig(view);
    setBaseUrl(view.baseUrl);
    setModelName(view.modelName);
    setModelFamily(view.modelFamily);
    setApiKey('');
    setShowKey(false);
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      applyView(await invoke<MidsceneConfigView>('get_midscene_config'));
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function syncAppSettings() {
    const stored = normalizeSettings(await invoke<AppSettings>('get_app_settings'));
    onSettingsReplaced(stored);
  }

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    setTestResult(null);
    try {
      const view = await invoke<MidsceneConfigView>('save_midscene_config', {
        value: { baseUrl, modelName, modelFamily, apiKey: apiKey || null },
      });
      applyView(view);
      await syncAppSettings();
      setNotice('Vision model settings were saved. New agent sessions will use this configuration.');
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setError(null);
    setNotice(null);
    setTestResult(null);
    try {
      setTestResult(await invoke<MidsceneTestResult>('test_midscene_connection', {
        value: { baseUrl, modelName, modelFamily, apiKey: apiKey || null },
      }));
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setTesting(false);
    }
  }

  async function removeStoredKey() {
    setSaving(true);
    setError(null);
    try {
      const view = await invoke<MidsceneConfigView>('clear_midscene_api_key');
      applyView(view);
      setNotice(view.apiKeyConfigured
        ? 'The Keychain key was removed. The environment-provided key is now active.'
        : 'The stored API key was removed.');
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <SettingsHeader
        title="Midscene / Vision Model"
        description="Configure the separate multimodal model used for visual grounding."
      />
      {error ? <Notice tone="error" title="Vision model configuration">{error}</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {loading ? <div className="settings-loading" role="status">Loading vision model configuration…</div> : (
        <SettingSection title="Model endpoint" description="OpenRouter is the default for new configurations. Choose a model that actually supports image input.">
          <div className="settings-form-grid">
            <label className="settings-field settings-field-wide">
              <span>Provider preset</span>
              <select aria-label="Provider preset" value={baseUrl === 'https://openrouter.ai/api/v1' ? 'openrouter' : 'custom'} onChange={(event) => {
                if (event.target.value === 'openrouter') setBaseUrl('https://openrouter.ai/api/v1');
              }} className="select-input">
                <option value="openrouter">OpenRouter (default)</option>
                <option value="custom">Custom OpenAI-compatible endpoint</option>
              </select>
              <small>A preset sets the endpoint only. Model compatibility is verified separately.</small>
            </label>
            <label className="settings-field settings-field-wide">
              <span>MIDSCENE_MODEL_BASE_URL</span>
              <input aria-label="MIDSCENE_MODEL_BASE_URL" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} className="text-input" spellCheck={false} />
            </label>
            <label className="settings-field">
              <span>MIDSCENE_MODEL_NAME</span>
              <input aria-label="MIDSCENE_MODEL_NAME" value={modelName} onChange={(event) => setModelName(event.target.value)} className="text-input" placeholder="provider/model-id" spellCheck={false} />
            </label>
            <label className="settings-field">
              <span>MIDSCENE_MODEL_FAMILY</span>
              <select aria-label="MIDSCENE_MODEL_FAMILY" value={modelFamily} onChange={(event) => setModelFamily(event.target.value)} className="select-input">
                <option value="" disabled>Select a compatible family</option>
                {(config?.modelFamilies ?? []).map((family) => <option value={family} key={family}>{family}</option>)}
              </select>
              <small>Arbitrary family strings are rejected by the backend.</small>
            </label>
            <label className="settings-field settings-field-wide">
              <span>MIDSCENE_MODEL_API_KEY</span>
              <span className="settings-secret-field">
                <KeyRoundIcon />
                <input
                  aria-label="MIDSCENE_MODEL_API_KEY"
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  className="text-input"
                  autoComplete="off"
                  placeholder={config?.apiKeyConfigured ? `Configured via ${config.apiKeySource}; enter a new key to replace it` : 'Enter provider API key'}
                />
                <button type="button" onClick={() => setShowKey((value) => !value)} aria-label={showKey ? 'Hide API key' : 'Show API key'}>
                  {showKey ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </span>
              <small>After saving, the key is cleared from this form and remains in macOS Keychain. Environment keys are never copied into the UI.</small>
            </label>
          </div>
          <div className="settings-button-row">
            <Button onClick={() => void save()} disabled={saving || !baseUrl.trim() || !modelName.trim() || !modelFamily}><SaveIcon /> {saving ? 'Saving…' : 'Save configuration'}</Button>
            <Button variant="outline" onClick={() => void testConnection()} disabled={testing || !baseUrl.trim() || !modelName.trim() || !modelFamily}><TestTube2Icon /> {testing ? 'Testing model…' : 'Test Connection'}</Button>
            {config?.apiKeySource === 'keychain' ? <Button variant="ghost" onClick={() => void removeStoredKey()} disabled={saving}>Remove stored key</Button> : null}
          </div>
        </SettingSection>
      )}
      {testResult ? (
        <SettingSection title="Connection verified" description={testResult.summary}>
          <ol className="connection-test-results">
            {testResult.stages.map((stage) => (
              <li key={stage.id}><CheckCircle2Icon /><span><strong>{stage.label}</strong><small>{stage.detail}</small></span></li>
            ))}
          </ol>
        </SettingSection>
      ) : null}
    </>
  );
}

function BrowserSettings({ settings, onBrowserChange }: Pick<SettingsPageProps, 'settings' | 'onBrowserChange'>) {
  const [browsers, setBrowsers] = useState<BrowserOption[]>([]);
  const [customPath, setCustomPath] = useState(settings.browser.executablePath ?? '');
  const [loading, setLoading] = useState(true);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function detect() {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<BrowserOption[]>('detect_browsers');
      setBrowsers(Array.isArray(result) ? result : []);
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void detect(); }, []);
  useEffect(() => { setCustomPath(settings.browser.executablePath ?? ''); }, [settings.browser.executablePath]);

  function choose(browser: BrowserOption) {
    if (!browser.available || !browser.executablePath || browser.id === 'safari') return;
    onBrowserChange({ kind: browser.id as Exclude<BrowserKind, 'custom'>, executablePath: browser.executablePath });
    setCustomPath(browser.executablePath);
    setNotice(`${browser.label} will be used for new automation sessions.`);
  }

  async function saveCustom(pathValue = customPath) {
    setValidating(true);
    setError(null);
    setNotice(null);
    try {
      const validated = await invoke<string>('validate_browser_executable', { path: pathValue });
      setCustomPath(validated);
      onBrowserChange({ kind: 'custom', executablePath: validated });
      setNotice('Custom browser executable validated and saved.');
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setValidating(false);
    }
  }

  async function browse() {
    const selected = await open({ multiple: false, directory: false, title: 'Choose a Chromium browser executable' });
    if (typeof selected !== 'string') return;
    setCustomPath(selected);
    await saveCustom(selected);
  }

  return (
    <>
      <SettingsHeader
        title="Browser"
        description="Choose the Chromium browser used by Puppeteer for web automation and recording."
        action={<Button variant="outline" size="sm" onClick={() => void detect()} disabled={loading}><RefreshCwIcon className={cn(loading && 'animate-spin')} /> Detect</Button>}
      />
      {error ? <Notice tone="error" title="Browser setting">{error}</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      <div className="settings-browser-list" role="radiogroup" aria-label="Automation browser">
        {browsers.map((browser) => {
          const selected = browser.id === settings.browser.kind;
          return (
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              key={browser.id}
              className="settings-browser-row"
              disabled={!browser.available}
              onClick={() => choose(browser)}
            >
              <span className="semantic-icon"><LaptopIcon /></span>
              <span className="settings-browser-copy">
                <strong>{browser.label}</strong>
                <small>{browser.detail}</small>
                {browser.executablePath ? <code>{browser.executablePath}</code> : null}
              </span>
              {selected ? <CheckCircle2Icon className="text-primary" /> : browser.available ? <ChevronRightIcon /> : <span className="settings-unavailable">Unavailable</span>}
            </button>
          );
        })}
      </div>
      <SettingSection title="Custom executable" description="Use another Chrome or Chromium build supported by Puppeteer.">
        <label className="settings-field">
          <span>Executable path</span>
          <div className="settings-inline-field">
            <input aria-label="Executable path" value={customPath} onChange={(event) => setCustomPath(event.target.value)} className="text-input" spellCheck={false} />
            <Button variant="outline" onClick={() => void browse()}><FolderOpenIcon /> Browse</Button>
          </div>
        </label>
        <Button className="mt-3" onClick={() => void saveCustom()} disabled={validating || !customPath.trim()}>{validating ? 'Validating…' : 'Use custom executable'}</Button>
      </SettingSection>
      <Notice tone="info" title="Why Safari is unavailable">
        The installed Midscene web adapter uses Puppeteer. Safari requires a separate WebDriver-compatible adapter, which this project does not currently implement.
      </Notice>
    </>
  );
}

const PERMISSION_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  accessibility: UserRoundCogIcon,
  screenRecording: VideoIcon,
  fullDiskAccess: LockKeyholeIcon,
  automation: TerminalIcon,
  microphone: NetworkIcon,
  camera: VideoIcon,
  localNetwork: NetworkIcon,
};

function PermissionSettings(props: Pick<SettingsPageProps, 'permission' | 'changingPermission' | 'onSetPermission'>) {
  const [permissions, setPermissions] = useState<MacosPermissionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<MacosPermissionInfo[]>('get_macos_permissions');
      setPermissions(Array.isArray(result) ? result : []);
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function permissionAction(command: 'request_macos_permission' | 'open_permission_settings', id: string) {
    setAction(id);
    setError(null);
    try {
      await invoke(command, { permission: id });
      await refresh();
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setAction(null);
    }
  }

  return (
    <>
      <SettingsHeader
        title="Permissions"
        description="Verify macOS privacy access and control how agent tool approvals are handled."
        action={<Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}><RefreshCwIcon className={cn(loading && 'animate-spin')} /> Re-check</Button>}
      />
      {error ? <Notice tone="error" title="Permission check">{error}</Notice> : null}
      <SettingSection title="Agent execution permission" description="This application setting is separate from macOS privacy permissions.">
        <div className="settings-choice-grid" role="radiogroup" aria-label="Default execution permission">
          <button type="button" role="radio" aria-checked={props.permission === 'mati'} disabled={props.changingPermission || props.permission === 'tidak-diketahui'} onClick={() => props.onSetPermission('ask')} className="choice-card items-start">
            <span className="semantic-icon semantic-icon-safe"><ShieldCheckIcon /></span>
            <span className="min-w-0 flex-1 text-left"><span className="block text-sm font-medium">Ask permission</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">Review sensitive agent actions before they run.</span></span>
            {props.permission === 'mati' ? <CheckIcon className="size-4 text-primary" /> : null}
          </button>
          <button type="button" role="radio" aria-checked={props.permission === 'nyala'} disabled={props.changingPermission || props.permission === 'tidak-diketahui'} onClick={() => props.onSetPermission('full')} className="choice-card items-start">
            <span className="semantic-icon semantic-icon-warning"><LockOpenIcon /></span>
            <span className="min-w-0 flex-1 text-left"><span className="block text-sm font-medium">Full access</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">Automatically approve ACP tool permission requests.</span></span>
            {props.permission === 'nyala' ? <CheckIcon className="size-4 text-warning" /> : null}
          </button>
        </div>
      </SettingSection>
      <div className="permission-settings-list">
        {permissions.map((permission) => {
          const Icon = PERMISSION_ICONS[permission.id] ?? ShieldCheckIcon;
          return (
            <article className="permission-settings-row" key={permission.id}>
              <span className="semantic-icon"><Icon /></span>
              <div className="permission-settings-copy"><h2>{permission.label}</h2><p>{permission.detail}</p></div>
              <StatusBadge value={permission.status} />
              <div className="permission-settings-actions">
                {permission.canRequest ? <Button size="sm" variant="outline" disabled={action === permission.id} onClick={() => void permissionAction('request_macos_permission', permission.id)}>Trigger Permission Prompt</Button> : null}
                {permission.canOpenSettings ? <Button size="sm" variant="ghost" disabled={action === permission.id} onClick={() => void permissionAction('open_permission_settings', permission.id)}><ExternalLinkIcon /> Open System Settings</Button> : null}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}

function WorkspaceSettings(props: Pick<SettingsPageProps, 'settings' | 'agent' | 'openingWorkspace' | 'onAddWorkspace' | 'onSelectWorkspace'>) {
  const selectedWorkspace = props.settings.workspaces.find((workspace) => workspace.path === props.settings.selectedWorkspace);
  const fallbackParts = props.agent?.cwd.split(/[\\/]/).filter(Boolean) ?? [];
  const fallbackName = fallbackParts[fallbackParts.length - 1] ?? 'Workspace';
  return (
    <>
      <SettingsHeader title="Workspace" description="Manage the local folders available to agent sessions." />
      <SettingSection title="Current workspace" description="Threads and agent commands run relative to this folder.">
        {selectedWorkspace || props.agent?.cwd ? (
          <div className="workspace-setting-current">
            <span className="semantic-icon"><FolderIcon /></span>
            <div><strong>{selectedWorkspace?.name ?? fallbackName}</strong><code>{selectedWorkspace?.path ?? props.agent?.cwd}</code><small>{selectedWorkspace?.threads.length ?? 1} thread(s)</small></div>
          </div>
        ) : <div className="settings-empty">No workspace is open.</div>}
        {props.settings.workspaces.length > 1 ? (
          <label className="settings-field mt-4 max-w-md"><span>Current project</span><select value={props.settings.selectedWorkspace ?? ''} onChange={(event) => props.onSelectWorkspace(event.target.value)} className="select-input">{props.settings.workspaces.map((workspace) => <option key={workspace.path} value={workspace.path}>{workspace.name}</option>)}</select></label>
        ) : null}
        <Button className="mt-3" variant="outline" onClick={props.onAddWorkspace} disabled={props.openingWorkspace}><FolderOpenIcon /> {props.openingWorkspace ? 'Opening picker…' : 'Open another folder'}</Button>
      </SettingSection>
    </>
  );
}

function AppearanceSettings(props: Pick<SettingsPageProps, 'settings' | 'onUiScaleChange' | 'onSidebarCollapsedChange'>) {
  return (
    <>
      <SettingsHeader title="Appearance" description="Tune information density and the primary sidebar state." />
      <SettingSection title="Interface" description="Changes apply immediately and persist on this device.">
        <div className="settings-form-grid">
          <label className="settings-field"><span>UI density</span><span className="settings-input-icon"><GaugeIcon /><select value={props.settings.uiScale} onChange={(event) => props.onUiScaleChange(event.target.value as AppSettings['uiScale'])} className="select-input"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></span></label>
          <div className="settings-field"><span>Sidebar on launch</span><button type="button" role="switch" aria-checked={!props.settings.sidebarCollapsed} onClick={() => props.onSidebarCollapsedChange(!props.settings.sidebarCollapsed)} className="switch-row"><PanelLeftIcon className="size-4 text-muted-foreground" /><span className="flex-1 text-left text-sm text-foreground">Keep expanded</span><span className={cn('switch-track', !props.settings.sidebarCollapsed && 'is-on')}><span /></span></button></div>
        </div>
      </SettingSection>
    </>
  );
}

function AdvancedSettings({ status, statusLabel, agent }: Pick<SettingsPageProps, 'status' | 'statusLabel' | 'agent'>) {
  return (
    <>
      <SettingsHeader title="Advanced" description="Runtime information for troubleshooting the desktop bridge." />
      <SettingSection title="Application" description="These values are read-only.">
        <dl className="info-list">
          <div><dt><InfoIcon /> Version</dt><dd>0.1.0</dd></div>
          <div><dt><span className={cn('status-indicator', `status-${status}`)} /> Agent connection</dt><dd>{statusLabel}</dd></div>
          <div><dt><TerminalIcon /> Runtime</dt><dd>Tauri 2 + ACP</dd></div>
          <div><dt><FolderIcon /> Session cwd</dt><dd title={agent?.cwd}>{agent?.cwd ?? 'No active session'}</dd></div>
        </dl>
      </SettingSection>
    </>
  );
}

export function SettingsPage(props: SettingsPageProps) {
  const [section, setSection] = useState<SettingsSectionId>('general');
  const currentLabel = useMemo(() => NAVIGATION.find((item) => item.id === section)?.label ?? 'Settings', [section]);

  let content: React.ReactNode;
  if (section === 'agents') content = <AgentSettings {...props} />;
  else if (section === 'accounts') content = <ProviderAccountsSettings settings={props.settings} onOpenMidscene={() => setSection('midscene')} />;
  else if (section === 'midscene') content = <MidsceneSettings onSettingsReplaced={props.onSettingsReplaced} />;
  else if (section === 'browser') content = <BrowserSettings settings={props.settings} onBrowserChange={props.onBrowserChange} />;
  else if (section === 'permissions') content = <PermissionSettings permission={props.permission} changingPermission={props.changingPermission} onSetPermission={props.onSetPermission} />;
  else if (section === 'workspace') content = <WorkspaceSettings settings={props.settings} agent={props.agent} openingWorkspace={props.openingWorkspace} onAddWorkspace={props.onAddWorkspace} onSelectWorkspace={props.onSelectWorkspace} />;
  else if (section === 'appearance') content = <AppearanceSettings settings={props.settings} onUiScaleChange={props.onUiScaleChange} onSidebarCollapsedChange={props.onSidebarCollapsedChange} />;
  else if (section === 'advanced') content = <AdvancedSettings status={props.status} statusLabel={props.statusLabel} agent={props.agent} />;
  else content = <GeneralSettings settings={props.settings} agent={props.agent} statusLabel={props.statusLabel} />;

  return (
    <div className="settings-workspace" aria-label="Settings workspace">
      <aside className="settings-inner-sidebar" aria-label="Settings sections">
        <div className="settings-inner-title"><Settings2Icon /><span>Settings</span></div>
        <nav>
          {NAVIGATION.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} type="button" className={cn('settings-nav-item', section === item.id && 'is-active')} aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)} title={item.label}>
                <Icon /><span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>
      <div className="settings-content-scroll scrollbar-thin">
        <div className="settings-content" data-settings-section={section} aria-label={currentLabel}>{content}</div>
      </div>
    </div>
  );
}
