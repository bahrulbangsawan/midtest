import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DropdownMenu } from 'radix-ui';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FilePlus2Icon,
  FolderIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PanelLeftCloseIcon,
  PencilIcon,
  SearchIcon,
  SettingsIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';

import type { AppSettings, ThreadPreference, WorkspacePreference } from '@/lib/app-types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';

interface SidebarProps {
  settings: AppSettings;
  activePage: 'chat' | 'settings';
  collapsed: boolean;
  openingWorkspace: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onOpenChat: () => void;
  onOpenSettings: () => void;
  onAddWorkspace: () => void;
  onSelectWorkspace: (path: string) => void;
  onForgetWorkspace: (path: string) => void;
  onCreateThread: (path?: string) => void;
  onSelectThread: (path: string, threadId: string) => void;
  onRenameThread: (path: string, threadId: string, title: string) => void;
  onDeleteThread: (path: string, threadId: string) => void;
}

interface ThreadAction {
  workspacePath: string;
  thread: ThreadPreference;
}

export function Sidebar({
  settings,
  activePage,
  collapsed,
  openingWorkspace,
  onCollapsedChange,
  onOpenChat,
  onOpenSettings,
  onAddWorkspace,
  onSelectWorkspace,
  onForgetWorkspace,
  onCreateThread,
  onSelectThread,
  onRenameThread,
  onDeleteThread,
}: SidebarProps) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(settings.workspaces.map((workspace) => workspace.path)),
  );
  const [renaming, setRenaming] = useState<ThreadAction | null>(null);
  const [deleting, setDeleting] = useState<ThreadAction | null>(null);
  const [forgetting, setForgetting] = useState<WorkspacePreference | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      for (const workspace of settings.workspaces) next.add(workspace.path);
      return next;
    });
  }, [settings.workspaces]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (collapsed) onCollapsedChange(false);
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [collapsed, onCollapsedChange]);

  const visibleWorkspaces = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return settings.workspaces;
    return settings.workspaces
      .map((workspace) => ({
        ...workspace,
        threads: workspace.threads.filter((thread) =>
          thread.title.toLowerCase().includes(normalized),
        ),
      }))
      .filter((workspace) =>
        workspace.name.toLowerCase().includes(normalized) || workspace.threads.length > 0,
      );
  }, [query, settings.workspaces]);

  function toggleWorkspace(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function beginRename(action: ThreadAction) {
    setRenameValue(action.thread.title);
    setRenaming(action);
  }

  return (
    <>
      <aside
        aria-label="Primary navigation"
        data-collapsed={collapsed}
        className={cn(
          'sidebar flex min-h-0 shrink-0 flex-col border-r border-border bg-sidebar transition-[width,padding] duration-200',
          collapsed ? 'w-[var(--sidebar-collapsed)] px-2' : 'w-[var(--sidebar-width)] px-3',
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2">
          {collapsed ? (
            <Tooltip label="Open MidTest sidebar">
              <button
                type="button"
                onClick={() => onCollapsedChange(false)}
                className="brand-icon-button focus-ring mx-auto grid size-9 shrink-0 place-items-center rounded-lg"
                aria-label="Open MidTest sidebar"
              >
                <img src="/midtest-icon.png" alt="" className="size-8 object-contain" />
              </button>
            </Tooltip>
          ) : (
            <>
              <Tooltip label="Open current MidTest thread">
                <button
                  type="button"
                  onClick={onOpenChat}
                  className="brand-wordmark-button focus-ring min-w-0 flex-1"
                  aria-label="Open current MidTest thread"
                >
                  <img src="/midtest-wordmark.png" alt="MidTest" className="brand-wordmark" />
                </button>
              </Tooltip>
              <Tooltip label="Tutup sidebar">
                <button
                  type="button"
                  onClick={() => onCollapsedChange(true)}
                  className="icon-button ml-auto"
                  aria-label="Tutup sidebar"
                >
                  <PanelLeftCloseIcon />
                </button>
              </Tooltip>
            </>
          )}
        </div>

        {collapsed ? (
          <div className="flex min-h-0 flex-1 flex-col items-center gap-1 pt-2">
            <Tooltip label="Open current thread">
              <button
                type="button"
                onClick={onOpenChat}
                aria-current={activePage === 'chat' ? 'page' : undefined}
                className="icon-button size-9 aria-[current=page]:bg-selected aria-[current=page]:text-foreground"
                aria-label="Open current thread"
              >
                <MessageSquareIcon />
              </button>
            </Tooltip>
            <Tooltip label="Search projects and threads (Command K)">
              <button
                type="button"
                onClick={() => {
                  onCollapsedChange(false);
                  requestAnimationFrame(() => searchRef.current?.focus());
                }}
                className="icon-button size-9"
                aria-label="Search projects and threads"
              >
                <SearchIcon />
              </button>
            </Tooltip>
            <Tooltip label="New thread">
              <button
                type="button"
                onClick={() => {
                  onOpenChat();
                  onCreateThread(settings.selectedWorkspace ?? undefined);
                }}
                className="icon-button size-9"
                aria-label="New thread"
              >
                <FilePlus2Icon />
              </button>
            </Tooltip>
            <div className="my-2 h-px w-7 bg-border" />
            <nav className="scrollbar-thin min-h-0 w-full flex-1 overflow-y-auto" aria-label="Projects">
              <div className="flex flex-col items-center gap-1">
                {settings.workspaces.map((workspace) => (
                  <Tooltip key={workspace.path} label={workspace.name}>
                    <button
                      type="button"
                      aria-current={settings.selectedWorkspace === workspace.path ? 'page' : undefined}
                      onClick={() => {
                        onOpenChat();
                        onSelectWorkspace(workspace.path);
                      }}
                      className="icon-button size-9 aria-[current=page]:bg-selected aria-[current=page]:text-foreground"
                      aria-label={`Open project ${workspace.name}`}
                    >
                      <FolderIcon />
                    </button>
                  </Tooltip>
                ))}
              </div>
            </nav>
            <Tooltip label="Add project folder">
              <button
                type="button"
                onClick={onAddWorkspace}
                disabled={openingWorkspace}
                className="icon-button size-9"
                aria-label="Add project folder"
              >
                <FolderPlusIcon />
              </button>
            </Tooltip>
            <Tooltip label="Settings">
              <button
                type="button"
                onClick={onOpenSettings}
                aria-current={activePage === 'settings' ? 'page' : undefined}
                className="icon-button mb-2 size-9 aria-[current=page]:bg-selected aria-[current=page]:text-foreground"
                aria-label="Settings"
              >
                <SettingsIcon />
              </button>
            </Tooltip>
          </div>
        ) : (
          <>
            <div className="relative mt-2 shrink-0">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search projects and threads"
                placeholder="Search"
                className="h-9 w-full rounded-lg border border-transparent bg-surface pl-8 pr-14 text-sm outline-none placeholder:text-muted-foreground hover:border-border focus:border-focus focus:ring-2 focus:ring-focus/20"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="icon-button absolute right-7 top-1.5 size-6"
                  aria-label="Clear search"
                >
                  <XIcon className="size-3.5" />
                </button>
              ) : (
                <kbd className="pointer-events-none absolute right-2 top-2 rounded border border-border px-1 text-[10px] leading-5 text-muted-foreground">⌘K</kbd>
              )}
            </div>

            <button
              type="button"
              onClick={() => {
                onOpenChat();
                onCreateThread(settings.selectedWorkspace ?? undefined);
              }}
              className="focus-ring mt-2 flex h-9 shrink-0 items-center gap-2 rounded-lg px-2.5 text-sm text-secondary-foreground hover:bg-hover hover:text-foreground"
            >
              <FilePlus2Icon className="size-4" /> New thread
            </button>

            <div className="mt-5 flex shrink-0 items-center gap-2 px-2">
              <p className="flex-1 text-xs font-medium text-secondary-foreground">Projects</p>
              <Tooltip label="Add project folder" side="bottom">
                <button
                  type="button"
                  onClick={onAddWorkspace}
                  disabled={openingWorkspace}
                  className="icon-button size-7"
                  aria-label="Add project folder"
                >
                  <FolderPlusIcon className="size-3.5" />
                </button>
              </Tooltip>
            </div>

            <nav className="scrollbar-thin mt-2 min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-label="Projects and threads">
              <div className="space-y-1 pb-4">
                {visibleWorkspaces.map((workspace) => {
                  const isOpen = expanded.has(workspace.path) || Boolean(query);
                  const activeProject = settings.selectedWorkspace === workspace.path;
                  return (
                    <div key={workspace.path} className="group/project">
                      <div className="flex min-w-0 items-center gap-0.5 rounded-lg hover:bg-hover">
                        <button
                          type="button"
                          onClick={() => toggleWorkspace(workspace.path)}
                          className="icon-button ml-1 size-7 shrink-0"
                          aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${workspace.name}`}
                          aria-expanded={isOpen}
                        >
                          {isOpen ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            onOpenChat();
                            onSelectWorkspace(workspace.path);
                          }}
                          title={workspace.path}
                          className={cn(
                            'focus-ring flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left text-sm',
                            activeProject ? 'text-foreground' : 'text-secondary-foreground',
                          )}
                        >
                          <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                          <span className="truncate font-medium">{workspace.name}</span>
                        </button>
                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger asChild>
                            <button
                              type="button"
                              className="icon-button mr-1 size-7 opacity-0 group-focus-within/project:opacity-100 group-hover/project:opacity-100 data-[state=open]:opacity-100"
                              aria-label={`Project actions for ${workspace.name}`}
                            >
                              <MoreHorizontalIcon className="size-4" />
                            </button>
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content side="right" align="start" sideOffset={6} className="menu-content">
                              <DropdownMenu.Item className="menu-item" onSelect={() => onCreateThread(workspace.path)}>
                                <FilePlus2Icon /> New thread
                              </DropdownMenu.Item>
                              <DropdownMenu.Separator className="menu-separator" />
                              <DropdownMenu.Item className="menu-item text-destructive" onSelect={() => setForgetting(workspace)}>
                                <Trash2Icon /> Forget project
                              </DropdownMenu.Item>
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                      </div>

                      {isOpen ? (
                        <div className="ml-[1.15rem] border-l border-border pl-2">
                          {workspace.threads.map((thread) => {
                            const activeThread = activeProject && workspace.selectedThreadId === thread.id;
                            return (
                              <div key={thread.id} className="group/thread mt-0.5 flex min-w-0 items-center rounded-md hover:bg-hover">
                                <button
                                  type="button"
                                  onClick={() => {
                                    onOpenChat();
                                    onSelectThread(workspace.path, thread.id);
                                  }}
                                  aria-current={activeThread ? 'page' : undefined}
                                  title={thread.title}
                                  className="focus-ring flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground aria-[current=page]:bg-selected aria-[current=page]:text-foreground"
                                >
                                  <MessageSquareIcon className="size-3.5 shrink-0" />
                                  <span className="truncate">{thread.title}</span>
                                </button>
                                <DropdownMenu.Root>
                                  <DropdownMenu.Trigger asChild>
                                    <button
                                      type="button"
                                      className="icon-button mr-1 size-6 opacity-0 group-focus-within/thread:opacity-100 group-hover/thread:opacity-100 data-[state=open]:opacity-100"
                                      aria-label={`Thread actions for ${thread.title}`}
                                    >
                                      <MoreHorizontalIcon className="size-3.5" />
                                    </button>
                                  </DropdownMenu.Trigger>
                                  <DropdownMenu.Portal>
                                    <DropdownMenu.Content side="right" align="start" sideOffset={6} className="menu-content">
                                      <DropdownMenu.Item className="menu-item" onSelect={() => beginRename({ workspacePath: workspace.path, thread })}>
                                        <PencilIcon /> Rename
                                      </DropdownMenu.Item>
                                      <DropdownMenu.Item className="menu-item text-destructive" onSelect={() => setDeleting({ workspacePath: workspace.path, thread })}>
                                        <Trash2Icon /> Delete
                                      </DropdownMenu.Item>
                                    </DropdownMenu.Content>
                                  </DropdownMenu.Portal>
                                </DropdownMenu.Root>
                              </div>
                            );
                          })}
                          <button
                            type="button"
                            onClick={() => onCreateThread(workspace.path)}
                            className="focus-ring mt-0.5 flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-hover hover:text-foreground"
                          >
                            <FilePlus2Icon className="size-3.5" /> New thread
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {visibleWorkspaces.length === 0 ? (
                  <div className="px-3 py-8 text-center text-xs leading-relaxed text-muted-foreground">
                    No projects or threads match “{query}”.
                  </div>
                ) : null}
              </div>
            </nav>

            {settings.workspaces.length === 0 ? (
              <button type="button" onClick={onAddWorkspace} className="mb-3 rounded-lg border border-dashed border-border p-3 text-left text-xs text-muted-foreground hover:border-muted-foreground hover:text-foreground">
                <FolderPlusIcon className="mb-2 size-4" />
                Open a project folder to start a thread.
              </button>
            ) : null}

            <button
              type="button"
              onClick={onOpenSettings}
              aria-current={activePage === 'settings' ? 'page' : undefined}
              className="focus-ring mb-2 flex h-9 shrink-0 items-center gap-2 rounded-lg px-2.5 text-sm text-muted-foreground hover:bg-hover hover:text-foreground aria-[current=page]:bg-selected aria-[current=page]:text-foreground"
            >
              <SettingsIcon className="size-4" /> Settings
            </button>
          </>
        )}
      </aside>

      <Dialog.Root open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content" aria-describedby="rename-thread-description">
            <Dialog.Title className="text-base font-semibold">Rename thread</Dialog.Title>
            <Dialog.Description id="rename-thread-description" className="text-sm text-muted-foreground">
              Use a short name that will still be clear in the project list.
            </Dialog.Description>
            <label className="mt-2 grid gap-2 text-sm">
              Thread name
              <input
                autoFocus
                value={renameValue}
                maxLength={80}
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && renameValue.trim() && renaming) {
                    onRenameThread(renaming.workspacePath, renaming.thread.id, renameValue);
                    setRenaming(null);
                  }
                }}
                className="text-input"
              />
            </label>
            <div className="mt-3 flex justify-end gap-2">
              <Dialog.Close asChild><Button variant="ghost">Cancel</Button></Dialog.Close>
              <Button
                disabled={!renameValue.trim()}
                onClick={() => {
                  if (!renaming) return;
                  onRenameThread(renaming.workspacePath, renaming.thread.id, renameValue);
                  setRenaming(null);
                }}
              >
                Rename
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content" aria-describedby="delete-thread-description">
            <Dialog.Title className="text-base font-semibold">Delete thread?</Dialog.Title>
            <Dialog.Description id="delete-thread-description" className="text-sm leading-relaxed text-muted-foreground">
              “{deleting?.thread.title}” will be removed from this project. This does not delete files from the workspace.
            </Dialog.Description>
            <div className="mt-3 flex justify-end gap-2">
              <Dialog.Close asChild><Button variant="ghost">Cancel</Button></Dialog.Close>
              <Button
                variant="destructive"
                onClick={() => {
                  if (!deleting) return;
                  onDeleteThread(deleting.workspacePath, deleting.thread.id);
                  setDeleting(null);
                }}
              >
                Delete thread
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={forgetting !== null} onOpenChange={(open) => !open && setForgetting(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content" aria-describedby="forget-project-description">
            <Dialog.Title className="text-base font-semibold">Forget project?</Dialog.Title>
            <Dialog.Description id="forget-project-description" className="text-sm leading-relaxed text-muted-foreground">
              “{forgetting?.name}” and its thread list will be removed from MidTest. Files in the folder will not be changed.
            </Dialog.Description>
            <div className="mt-3 flex justify-end gap-2">
              <Dialog.Close asChild><Button variant="ghost">Cancel</Button></Dialog.Close>
              <Button
                variant="destructive"
                onClick={() => {
                  if (!forgetting) return;
                  onForgetWorkspace(forgetting.path);
                  setForgetting(null);
                }}
              >
                Forget project
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
