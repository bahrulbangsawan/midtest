import { useEffect, useState } from 'react';
import {
  ChevronRightIcon,
  FolderIcon,
  LockOpenIcon,
  RotateCwIcon,
  ShieldCheckIcon,
  XIcon,
} from 'lucide-react';

import { Chat } from './Chat';
import { Notice } from './Notice';
import { SettingsPage } from './SettingsPage';
import { Sidebar } from './Sidebar';
import type {
  AgentInfo,
  AppSettings,
  ConnectionStatus,
  PermissionState,
  ProviderId,
} from '@/lib/app-types';
import { providerLabel } from '@/lib/app-types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';

type Page = 'chat' | 'settings';

interface WorkspaceShellProps {
  settings: AppSettings;
  settingsReady: boolean;
  agent: AgentInfo | null;
  status: ConnectionStatus;
  statusLabel: string;
  connectionError: string | null;
  applicationError: string | null;
  notice: string | null;
  permission: PermissionState;
  permissionError: string | null;
  changingPermission: boolean;
  changingModel: boolean;
  openingWorkspace: boolean;
  onDismissNotice: () => void;
  onSelectProvider: (provider: ProviderId) => void;
  onSelectModel: (modelId: string) => void;
  onSetPermission: (mode: 'ask' | 'full') => void;
  onAddWorkspace: () => void;
  onSelectWorkspace: (path: string) => void;
  onForgetWorkspace: (path: string) => void;
  onCreateThread: (path?: string) => void;
  onSelectThread: (path: string, threadId: string) => void;
  onRenameThread: (path: string, threadId: string, title: string) => void;
  onDeleteThread: (path: string, threadId: string) => void;
  onSidebarCollapsedChange: (collapsed: boolean) => void;
  onUiScaleChange: (scale: AppSettings['uiScale']) => void;
  onBrowserChange: (browser: AppSettings['browser']) => void;
  onSettingsReplaced: (settings: AppSettings) => void;
  onRetry: () => void;
  onFirstPrompt: (prompt: string) => void;
}

export function WorkspaceShell(props: WorkspaceShellProps) {
  const {
    settings,
    settingsReady,
    agent,
    status,
    statusLabel,
    connectionError,
    applicationError,
    notice,
    permission,
    permissionError,
    changingPermission,
    changingModel,
    openingWorkspace,
  } = props;
  const [page, setPage] = useState<Page>('chat');
  const [narrow, setNarrow] = useState(false);
  const [narrowExpanded, setNarrowExpanded] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 860px)');
    const update = () => {
      setNarrow(media.matches);
      if (!media.matches) setNarrowExpanded(false);
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const collapsed = narrow ? !narrowExpanded : settings.sidebarCollapsed;
  const workspace = settings.workspaces.find((item) => item.path === settings.selectedWorkspace);
  const thread = workspace?.threads.find((item) => item.id === workspace.selectedThreadId);
  const model = agent?.models.find((item) => item.id === agent.selectedModel);

  function setCollapsed(next: boolean) {
    if (narrow) setNarrowExpanded(!next);
    else props.onSidebarCollapsedChange(next);
  }

  return (
    <TooltipProvider>
      <main className="app-frame flex h-[100dvh] min-h-0 w-full min-w-0 overflow-hidden bg-background text-foreground">
        <Sidebar
          settings={settings}
          activePage={page}
          collapsed={collapsed}
          openingWorkspace={openingWorkspace}
          onCollapsedChange={setCollapsed}
          onOpenChat={() => setPage('chat')}
          onOpenSettings={() => setPage('settings')}
          onAddWorkspace={props.onAddWorkspace}
          onSelectWorkspace={props.onSelectWorkspace}
          onForgetWorkspace={props.onForgetWorkspace}
          onCreateThread={props.onCreateThread}
          onSelectThread={props.onSelectThread}
          onRenameThread={props.onRenameThread}
          onDeleteThread={props.onDeleteThread}
        />

        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <header className="app-header flex h-14 shrink-0 items-center gap-2 border-b border-border px-4 sm:px-5">
            {page === 'chat' ? (
              <div className="flex min-w-0 items-center gap-1.5 text-sm">
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="max-w-[24vw] truncate text-muted-foreground" title={workspace?.path}>{workspace?.name ?? 'No workspace'}</span>
                <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
                <span className="max-w-[32vw] truncate font-medium" title={thread?.title}>{thread?.title ?? 'New thread'}</span>
              </div>
            ) : (
              <span className="text-sm font-medium">Settings</span>
            )}

            <div className="ml-auto flex min-w-0 items-center gap-2">
              {permission === 'nyala' ? (
                <span className="permission-badge permission-full" title="Tool permission requests are approved automatically">
                  <LockOpenIcon /> <span className="hidden lg:inline">Izin penuh menyala</span>
                </span>
              ) : permission === 'mati' ? (
                <span className="permission-badge" title="Sensitive tool actions ask for approval">
                  <ShieldCheckIcon /> <span className="hidden lg:inline">Ask permission</span>
                </span>
              ) : null}
              <div className="connection-badge" role="status" aria-live="polite">
                <span className={cn('status-indicator', `status-${status}`)} />
                <span className="hidden sm:inline">{statusLabel}</span>
              </div>
            </div>
          </header>

          {(connectionError || applicationError || permissionError || permission === 'tidak-diketahui' || notice) ? (
            <div className="notice-stack shrink-0 px-4 pt-3 sm:px-5">
              {connectionError ? (
                <Notice
                  tone="error"
                  title="Agent unavailable"
                  action={<Button variant="outline" size="sm" onClick={props.onRetry}><RotateCwIcon /> Retry</Button>}
                >
                  {connectionError}
                </Notice>
              ) : null}
              {applicationError ? <Notice tone="error" title="Application action failed">{applicationError}</Notice> : null}
              {permissionError ? <Notice tone="error" title="Permission setting was not saved">{permissionError}</Notice> : null}
              {permission === 'tidak-diketahui' ? (
                <Notice tone="warning" title="Permission state unknown">
                  Status izin penuh tidak diketahui. Mulai ulang aplikasi sebelum menjalankan tindakan sensitif.
                </Notice>
              ) : null}
              {notice ? (
                <Notice
                  tone="success"
                  action={<button type="button" onClick={props.onDismissNotice} className="icon-button size-7" aria-label="Dismiss notification"><XIcon /></button>}
                >
                  {notice}
                </Notice>
              ) : null}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-hidden">
            {page === 'chat' ? (
              <Chat
                key={`${agent?.sessionId ?? 'disconnected'}:${workspace?.selectedThreadId ?? 'new'}`}
                connected={status === 'tersambung'}
                connecting={status === 'menyambung'}
                provider={agent?.id ?? settings.defaultProvider}
                models={agent?.models ?? []}
                selectedModel={agent?.selectedModel ?? settings.selectedModels[settings.defaultProvider] ?? null}
                supportsModelSelection={agent?.supportsModelSelection ?? false}
                changingModel={changingModel}
                permission={permission}
                changingPermission={changingPermission}
                workspaceName={workspace?.name ?? 'workspace'}
                onSelectProvider={props.onSelectProvider}
                onSelectModel={props.onSelectModel}
                onSetPermission={props.onSetPermission}
                onFirstPrompt={props.onFirstPrompt}
                onOpenWorkspace={props.onAddWorkspace}
              />
            ) : (
              <SettingsPage
                settings={settings}
                agent={agent}
                status={status}
                statusLabel={statusLabel}
                permission={permission}
                changingPermission={changingPermission}
                changingModel={changingModel}
                openingWorkspace={openingWorkspace}
                onSelectProvider={props.onSelectProvider}
                onSelectModel={props.onSelectModel}
                onSetPermission={props.onSetPermission}
                onAddWorkspace={props.onAddWorkspace}
                onSelectWorkspace={props.onSelectWorkspace}
                onSidebarCollapsedChange={props.onSidebarCollapsedChange}
                onUiScaleChange={props.onUiScaleChange}
                onBrowserChange={props.onBrowserChange}
                onSettingsReplaced={props.onSettingsReplaced}
              />
            )}
          </div>

          {!settingsReady ? <span className="sr-only" role="status">Loading saved settings</span> : null}
          <span className="sr-only">Current provider: {providerLabel(agent?.id ?? settings.defaultProvider)}. Current model: {model?.label ?? 'agent default'}.</span>
        </section>
      </main>
    </TooltipProvider>
  );
}
