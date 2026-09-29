import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { useEffect, useRef, useState } from 'react';

import { PermissionDialog } from './components/PermissionDialog';
import { WorkspaceShell } from './components/WorkspaceShell';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type AddWorkspaceResult,
  type AgentInfo,
  type AppSettings,
  type ConnectionStatus,
  type ModelState,
  type PermissionState,
  type ProviderId,
  type ThreadPreference,
} from './lib/app-types';

const EVENT_AGENT_DISCONNECTED = 'agent-disconnected';

function connectionLabel(status: ConnectionStatus): string {
  if (status === 'menyambung') return 'Menyambungkan…';
  if (status === 'tersambung') return 'Tersambung';
  return 'Gagal tersambung';
}

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'An unexpected application error occurred.';
}

function normalizeAgent(info: AgentInfo): AgentInfo {
  return {
    ...info,
    models: Array.isArray(info.models) ? info.models : [],
    selectedModel: info.selectedModel ?? null,
    supportsModelSelection: info.supportsModelSelection ?? false,
  };
}

function newThread(): ThreadPreference {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `thread-${Date.now()}`,
    title: 'New thread',
  };
}

function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const settingsRef = useRef(settings);
  const [settingsReady, setSettingsReady] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>('menyambung');
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState<string | null>(null);
  const [applicationError, setApplicationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const [changingModel, setChangingModel] = useState(false);
  const settingsPersistenceQueue = useRef<Promise<void>>(Promise.resolve());
  const settingsPersistenceVersion = useRef(0);

  const [permission, setPermissionState] = useState<PermissionState>('mati');
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [changingPermission, setChangingPermission] = useState(false);

  useEffect(() => {
    settingsRef.current = settings;
    document.documentElement.dataset.uiScale = settings.uiScale;
  }, [settings]);

  async function connectTo(
    provider: ProviderId,
    workspacePath?: string | null,
    preferredModel?: string | null,
  ) {
    setStatus('menyambung');
    setAgent(null);
    setConnectionError(null);
    setDisconnected(null);

    const args: Record<string, unknown> = { agentId: provider };
    if (workspacePath) args.workspacePath = workspacePath;
    if (preferredModel) args.preferredModel = preferredModel;

    try {
      const info = normalizeAgent(await invoke<AgentInfo>('connect_agent', args));
      setAgent(info);
      setStatus('tersambung');

      // If a previously saved model disappeared, the live adapter's default
      // is authoritative and becomes the next persisted choice.
      if (info.selectedModel) {
        const current = settingsRef.current;
        if (current.selectedModels[provider] !== info.selectedModel) {
          const next = {
            ...current,
            selectedModels: {
              ...current.selectedModels,
              [provider]: info.selectedModel,
            },
          };
          setSettings(next);
          settingsRef.current = next;
          void persistSettings(next);
        }
      }
    } catch (error) {
      setStatus('gagal');
      setConnectionError(readableError(error));
    }
  }

  function persistSettings(value: AppSettings): Promise<boolean> {
    const version = ++settingsPersistenceVersion.current;
    const persist = async (): Promise<boolean> => {
      try {
        const saved = normalizeSettings(
          await invoke<AppSettings>('save_app_settings', { value }),
        );
        // Only the newest snapshot may reconcile React state. Older saves
        // still finish first in the queue, but must never roll the UI back.
        if (version === settingsPersistenceVersion.current) {
          setSettings(saved);
          settingsRef.current = saved;
          setApplicationError(null);
        }
        return true;
      } catch (error) {
        if (version === settingsPersistenceVersion.current) {
          setApplicationError(readableError(error));
        }
        return false;
      }
    };

    const queued = settingsPersistenceQueue.current.then(persist, persist);
    settingsPersistenceQueue.current = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  function commitSettings(value: AppSettings) {
    setSettings(value);
    settingsRef.current = value;
    void persistSettings(value);
  }

  function replaceSettings(value: AppSettings) {
    const normalized = normalizeSettings(value);
    setSettings(normalized);
    settingsRef.current = normalized;
    // A settings mutation made by another backend command (for example saving
    // the Midscene key) becomes the final queued snapshot, so an older UI save
    // cannot overwrite it after the command returns.
    void persistSettings(normalized);
  }

  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    void (async () => {
      let loaded = DEFAULT_SETTINGS;
      try {
        loaded = normalizeSettings(await invoke<AppSettings>('get_app_settings'));
      } catch (error) {
        setApplicationError(
          `Preferences could not be loaded. Defaults are active for this session. ${readableError(error)}`,
        );
      }
      setSettings(loaded);
      settingsRef.current = loaded;
      setSettingsReady(true);
      await connectTo(
        loaded.defaultProvider,
        loaded.selectedWorkspace,
        loaded.selectedModels[loaded.defaultProvider],
      );
    })();
  }, []);

  useEffect(() => {
    invoke<boolean>('get_full_permissions').then(
      (value) => setPermissionState(value ? 'nyala' : 'mati'),
      () => setPermissionState('tidak-diketahui'),
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen(EVENT_AGENT_DISCONNECTED, (event) => {
      const reason = (event.payload as { reason?: unknown } | null)?.reason;
      setDisconnected(
        typeof reason === 'string' ? reason : 'the agent transport closed unexpectedly',
      );
      setStatus('gagal');
    }).then(
      (stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  async function changePermission(target: 'ask' | 'full') {
    if (changingPermission || permission === 'tidak-diketahui') return;
    const enabled = target === 'full';
    if ((permission === 'nyala') === enabled) return;

    setChangingPermission(true);
    setPermissionError(null);
    setPermissionState(enabled ? 'nyala' : 'mati');
    try {
      await invoke('set_full_permissions', { enabled });
    } catch (error) {
      try {
        const actual = await invoke<boolean>('get_full_permissions');
        setPermissionState(actual ? 'nyala' : 'mati');
      } catch {
        setPermissionState('tidak-diketahui');
      }
      setPermissionError(readableError(error));
    } finally {
      setChangingPermission(false);
    }
  }

  async function selectProvider(provider: ProviderId) {
    const current = settingsRef.current;
    if (current.defaultProvider === provider && status === 'tersambung') return;
    const next = { ...current, defaultProvider: provider };
    setSettings(next);
    settingsRef.current = next;
    void persistSettings(next);
    await connectTo(provider, next.selectedWorkspace, next.selectedModels[provider]);
  }

  async function selectModel(modelId: string) {
    if (!agent || changingModel || agent.selectedModel === modelId) return;
    setChangingModel(true);
    setApplicationError(null);
    try {
      const state = await invoke<ModelState>('set_agent_model', { modelId });
      setAgent((current) => current ? {
        ...current,
        models: state.models,
        selectedModel: state.selectedModel,
        supportsModelSelection: state.supportsModelSelection,
      } : current);
      const current = settingsRef.current;
      const next = {
        ...current,
        selectedModels: { ...current.selectedModels, [agent.id]: modelId },
      };
      setSettings(next);
      settingsRef.current = next;
      void persistSettings(next);
    } catch (error) {
      setApplicationError(readableError(error));
    } finally {
      setChangingModel(false);
    }
  }

  async function addWorkspace() {
    if (openingWorkspace) return;
    setOpeningWorkspace(true);
    setApplicationError(null);
    try {
      const selection = await open({
        directory: true,
        multiple: false,
        title: 'Open workspace folder',
      });
      if (selection === null) return;
      const path = Array.isArray(selection) ? selection[0] : selection;
      if (!path) return;
      const result = await invoke<AddWorkspaceResult>('add_workspace', { path });
      const next = normalizeSettings(result.settings);
      setSettings(next);
      settingsRef.current = next;
      setNotice(result.added ? 'Workspace added.' : 'Workspace was already open and is now selected.');
      await connectTo(
        next.defaultProvider,
        next.selectedWorkspace,
        next.selectedModels[next.defaultProvider],
      );
    } catch (error) {
      setApplicationError(readableError(error));
    } finally {
      setOpeningWorkspace(false);
    }
  }

  async function selectWorkspace(path: string) {
    const current = settingsRef.current;
    if (current.selectedWorkspace === path && status === 'tersambung') return;
    const next = { ...current, selectedWorkspace: path };
    setSettings(next);
    settingsRef.current = next;
    void persistSettings(next);
    await connectTo(next.defaultProvider, path, next.selectedModels[next.defaultProvider]);
  }

  async function selectThread(workspacePath: string, threadId: string) {
    const current = settingsRef.current;
    const workspace = current.workspaces.find((item) => item.path === workspacePath);
    if (!workspace || workspace.selectedThreadId === threadId) return;
    const next = {
      ...current,
      selectedWorkspace: workspacePath,
      workspaces: current.workspaces.map((item) =>
        item.path === workspacePath ? { ...item, selectedThreadId: threadId } : item,
      ),
    };
    setSettings(next);
    settingsRef.current = next;
    void persistSettings(next);
    await connectTo(next.defaultProvider, workspacePath, next.selectedModels[next.defaultProvider]);
  }

  async function createThread(workspacePath?: string) {
    const current = settingsRef.current;
    const path = workspacePath ?? current.selectedWorkspace;
    if (!path) {
      await addWorkspace();
      return;
    }
    const thread = newThread();
    const next = {
      ...current,
      selectedWorkspace: path,
      workspaces: current.workspaces.map((workspace) =>
        workspace.path === path
          ? {
              ...workspace,
              threads: [...workspace.threads, thread],
              selectedThreadId: thread.id,
            }
          : workspace,
      ),
    };
    setSettings(next);
    settingsRef.current = next;
    void persistSettings(next);
    await connectTo(next.defaultProvider, path, next.selectedModels[next.defaultProvider]);
  }

  function renameThread(workspacePath: string, threadId: string, title: string) {
    const clean = title.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!clean) return;
    const current = settingsRef.current;
    const next = {
      ...current,
      workspaces: current.workspaces.map((workspace) =>
        workspace.path === workspacePath
          ? {
              ...workspace,
              threads: workspace.threads.map((thread) =>
                thread.id === threadId ? { ...thread, title: clean } : thread,
              ),
            }
          : workspace,
      ),
    };
    commitSettings(next);
  }

  function deleteThread(workspacePath: string, threadId: string) {
    const current = settingsRef.current;
    let shouldReconnect = false;
    const next = {
      ...current,
      workspaces: current.workspaces.map((workspace) => {
        if (workspace.path !== workspacePath) return workspace;
        let threads = workspace.threads.filter((thread) => thread.id !== threadId);
        if (threads.length === 0) threads = [newThread()];
        const deletedActive = workspace.selectedThreadId === threadId;
        if (deletedActive) shouldReconnect = current.selectedWorkspace === workspacePath;
        return {
          ...workspace,
          threads,
          selectedThreadId: deletedActive ? threads[0]?.id : workspace.selectedThreadId,
        };
      }),
    };
    commitSettings(next);
    if (shouldReconnect) {
      void connectTo(next.defaultProvider, workspacePath, next.selectedModels[next.defaultProvider]);
    }
  }

  async function disconnectAgent() {
    try {
      await invoke('disconnect_agent');
    } catch (error) {
      setApplicationError(`The active agent could not be closed cleanly. ${readableError(error)}`);
    }
  }

  function forgetWorkspace(path: string) {
    const current = settingsRef.current;
    const workspaces = current.workspaces.filter((workspace) => workspace.path !== path);
    const selectedWorkspace = current.selectedWorkspace === path
      ? workspaces[0]?.path ?? null
      : current.selectedWorkspace;
    const next = { ...current, workspaces, selectedWorkspace };
    commitSettings(next);
    if (selectedWorkspace) {
      void connectTo(next.defaultProvider, selectedWorkspace, next.selectedModels[next.defaultProvider]);
    } else {
      setAgent(null);
      setStatus('gagal');
      setConnectionError('No workspace is open. Add a folder to continue.');
      void disconnectAgent();
    }
  }

  function setSidebarCollapsed(collapsed: boolean) {
    commitSettings({ ...settingsRef.current, sidebarCollapsed: collapsed });
  }

  function setUiScale(uiScale: AppSettings['uiScale']) {
    commitSettings({ ...settingsRef.current, uiScale });
  }

  const activeWorkspace = settings.workspaces.find(
    (workspace) => workspace.path === settings.selectedWorkspace,
  );
  const activeThread = activeWorkspace?.threads.find(
    (thread) => thread.id === activeWorkspace.selectedThreadId,
  );
  const combinedConnectionError = connectionError ?? (disconnected
    ? `The ${agent?.label ?? settings.defaultProvider} connection closed: ${disconnected}.`
    : null);

  return (
    <>
      <WorkspaceShell
        settings={settings}
        settingsReady={settingsReady}
        agent={agent}
        status={status}
        statusLabel={connectionLabel(status)}
        connectionError={combinedConnectionError}
        applicationError={applicationError}
        notice={notice}
        onDismissNotice={() => setNotice(null)}
        permission={permission}
        permissionError={permissionError}
        changingPermission={changingPermission}
        changingModel={changingModel}
        openingWorkspace={openingWorkspace}
        onSelectProvider={(provider) => void selectProvider(provider)}
        onSelectModel={(modelId) => void selectModel(modelId)}
        onSetPermission={(mode) => void changePermission(mode)}
        onAddWorkspace={() => void addWorkspace()}
        onSelectWorkspace={(path) => void selectWorkspace(path)}
        onForgetWorkspace={forgetWorkspace}
        onCreateThread={(path) => void createThread(path)}
        onSelectThread={(path, id) => void selectThread(path, id)}
        onRenameThread={renameThread}
        onDeleteThread={deleteThread}
        onSidebarCollapsedChange={setSidebarCollapsed}
        onUiScaleChange={setUiScale}
        onBrowserChange={(browser) => commitSettings({ ...settingsRef.current, browser })}
        onSettingsReplaced={replaceSettings}
        onRetry={() => void connectTo(
          settings.defaultProvider,
          settings.selectedWorkspace,
          settings.selectedModels[settings.defaultProvider],
        )}
        onFirstPrompt={(prompt) => {
          if (activeWorkspace && activeThread?.title === 'New thread') {
            renameThread(activeWorkspace.path, activeThread.id, prompt);
          }
        }}
      />
      <PermissionDialog />
    </>
  );
}

export default App;
