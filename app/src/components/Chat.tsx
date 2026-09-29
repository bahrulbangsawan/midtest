import { useChat } from '@tanstack/ai-react';
import type { UIMessage } from '@tanstack/ai-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import {
  ArrowDownIcon,
  BotIcon,
  ChevronDownIcon,
  CircleStopIcon,
  FolderOpenIcon,
  LoaderCircleIcon,
  LockOpenIcon,
  SendIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from 'lucide-react';

import { createTauriAcpConnection } from '../connection/tauri-acp-connection';
import { AgentLogo } from './AgentLogo';
import { MarkdownContent } from './MarkdownContent';
import { Notice } from './Notice';
import { ToolCallEvent } from './ToolCallEvent';
import type { ModelOption, PermissionState, ProviderId } from '@/lib/app-types';
import { PROVIDERS, providerLabel } from '@/lib/app-types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Message,
  MessageContent,
  MessageGroup,
  MessageHeader,
} from '@/components/ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'An unexpected agent error occurred.';
}

function roleLabel(role: UIMessage['role']): string {
  if (role === 'user') return 'You';
  if (role === 'assistant') return 'Agent';
  return 'System';
}

export interface ChatProps {
  connected?: boolean;
  connecting?: boolean;
  provider?: ProviderId;
  models?: ModelOption[];
  selectedModel?: string | null;
  supportsModelSelection?: boolean;
  changingModel?: boolean;
  permission?: PermissionState;
  changingPermission?: boolean;
  workspaceName?: string;
  onSelectProvider?: (provider: ProviderId) => void;
  onSelectModel?: (modelId: string) => void;
  onSetPermission?: (mode: 'ask' | 'full') => void;
  onFirstPrompt?: (prompt: string) => void;
  onOpenWorkspace?: () => void;

  // Compatibility aliases retained for the existing ACP regression tests.
  agenTersambung?: boolean;
  agenAktif?: string;
  sedangMenyambung?: boolean;
  onPilihAgen?: (id: string) => void;
  izinPenuh?: PermissionState;
  sedangMengubahIzin?: boolean;
  onUbahIzin?: () => void;
}

export function Chat(props: ChatProps) {
  const connected = props.connected ?? props.agenTersambung ?? false;
  const connecting = props.connecting ?? props.sedangMenyambung ?? false;
  const provider = (props.provider ?? props.agenAktif ?? 'claude') as ProviderId;
  const models = props.models ?? [];
  const selectedModel = props.selectedModel ?? null;
  const supportsModelSelection = props.supportsModelSelection ?? false;
  const permission = props.permission ?? props.izinPenuh ?? 'mati';
  const changingPermission = props.changingPermission ?? props.sedangMengubahIzin ?? false;
  const onSelectProvider = props.onSelectProvider ?? ((id: ProviderId) => props.onPilihAgen?.(id));
  const onSetPermission = props.onSetPermission ?? (() => props.onUbahIzin?.());

  const connection = useMemo(
    () => createTauriAcpConnection({ invoke, listen }),
    [],
  );
  const { messages, sendMessage, error } = useChat({ connection, live: true });
  const [text, setText] = useState('');
  const [subscriptionReady, setSubscriptionReady] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [cancelledToolIds, setCancelledToolIds] = useState<Set<string>>(() => new Set());
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sentFirstPrompt = useRef(false);
  const sendingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    connection.whenReady().then(
      () => {
        if (!cancelled) setSubscriptionReady(true);
      },
      (reason: unknown) => {
        if (!cancelled) {
          setSubscriptionReady(false);
          setLocalError(`The agent event stream could not be prepared: ${readableError(reason)}`);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [connection]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 184)}px`;
  }, [text]);

  const canSend = connected && subscriptionReady && !sending && text.trim().length > 0;
  const activeModel = models.find((model) => model.id === selectedModel);

  useEffect(() => {
    if (!cancelRequested) return;
    const ids = messages.flatMap((message) => message.parts.flatMap((part) => (
      part.type === 'tool-call' && part.state !== 'complete' && part.state !== 'error'
        ? [part.id]
        : []
    )));
    if (ids.length === 0) return;
    setCancelledToolIds((current) => {
      const next = new Set(current);
      for (const id of ids) next.add(id);
      return next;
    });
  }, [cancelRequested, messages]);

  async function send() {
    const raw = text;
    const content = raw.trim();
    if (!content || sendingRef.current || !connected) return;
    sendingRef.current = true;
    setSending(true);
    setCancelRequested(false);
    setLocalError(null);
    // `sendMessage` adds the optimistic user message synchronously, but its
    // promise does not resolve until RUN_FINISHED. Clear the controlled input
    // at submit time so the draft cannot remain mounted throughout streaming.
    setText('');
    if (!sentFirstPrompt.current) {
      sentFirstPrompt.current = true;
      props.onFirstPrompt?.(content.slice(0, 80));
    }
    try {
      await connection.whenReady();
      await sendMessage(content);
      if (mountedRef.current) requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (reason) {
      if (mountedRef.current) {
        setLocalError(readableError(reason));
        // Restore the failed prompt only when the user has not already started
        // a replacement draft. Never overwrite newer typing with stale text.
        setText((current) => (current.length === 0 ? raw : current));
      }
    } finally {
      sendingRef.current = false;
      if (mountedRef.current) setSending(false);
    }
  }

  async function stop() {
    if (cancelling) return;
    setCancelling(true);
    setLocalError(null);
    try {
      await invoke('cancel_turn');
      setCancelRequested(true);
    } catch (reason) {
      setLocalError(readableError(reason));
    } finally {
      setCancelling(false);
    }
  }

  const displayError = localError ?? (error ? readableError(error) : null);

  return (
    <div className="chat-panel relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <MessageScrollerProvider>
        <MessageScroller className="min-h-0 flex-1 border-0 bg-transparent">
          <MessageScrollerViewport className="conversation-scroll px-4 py-6 sm:px-6 lg:px-8">
            <MessageScrollerContent className="mx-auto w-full max-w-[880px] gap-5">
              {messages.length === 0 ? (
                connecting ? (
                  <div className="m-auto w-full max-w-xl px-4" role="status" aria-label="Connecting to agent">
                    <div className="skeleton h-4 w-28" />
                    <div className="skeleton mt-4 h-12 w-full" />
                    <div className="skeleton mt-2 h-12 w-4/5" />
                  </div>
                ) : (
                  <div className="empty-chat m-auto flex max-w-xl flex-col items-center px-4 text-center">
                    <span className="empty-chat-icon"><SparklesIcon /></span>
                    <h1 className="mt-5 text-xl font-semibold tracking-[-0.02em]">
                      {connected ? `Work in ${props.workspaceName ?? 'this workspace'}` : 'Connect an agent to begin'}
                    </h1>
                    <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                      {connected
                        ? `Ask ${providerLabel(provider)} to inspect, explain, or change files in this project.`
                        : 'Check the agent installation or open an accessible workspace folder.'}
                    </p>
                    {connected ? (
                      <div className="mt-5 flex flex-wrap justify-center gap-2">
                        {['Summarize this project', 'Find the main entry point', 'Review recent changes'].map((prompt) => (
                          <button key={prompt} type="button" onClick={() => { setText(prompt); requestAnimationFrame(() => textareaRef.current?.focus()); }} className="suggestion-button">
                            {prompt}
                          </button>
                        ))}
                      </div>
                    ) : props.onOpenWorkspace ? (
                      <Button className="mt-5" variant="outline" onClick={props.onOpenWorkspace}><FolderOpenIcon /> Open folder</Button>
                    ) : null}
                  </div>
                )
              ) : (
                messages.map((message) => (
                  <MessageScrollerItem
                    key={message.id}
                    messageId={message.id}
                    scrollAnchor={message.role === 'user'}
                  >
                    <MessageGroup className="py-1">
                      <Message align={message.role === 'user' ? 'end' : 'start'}>
                        <MessageContent className={message.role === 'user' ? 'max-w-[min(82%,720px)]' : 'max-w-full'}>
                          <MessageHeader className="gap-2 px-1">
                            {message.role === 'assistant' ? <BotIcon className="size-3.5" /> : null}
                            {roleLabel(message.role)}
                          </MessageHeader>
                          {message.parts.map((part, index) => {
                            if (part.type === 'text') {
                              return message.role === 'user' ? (
                                <div key={index} className="user-message whitespace-pre-wrap break-words">{part.content}</div>
                              ) : (
                                <MarkdownContent key={index} content={part.content} className="assistant-message" />
                              );
                            }
                            if (part.type === 'thinking') {
                              return (
                                <details key={index} className="thinking-block">
                                  <summary>Reasoning</summary>
                                  <div className="mt-2 whitespace-pre-wrap break-words">{part.content}</div>
                                </details>
                              );
                            }
                            if (part.type === 'tool-call') {
                              return (
                                <ToolCallEvent
                                  key={part.id || index}
                                  part={part}
                                  cancelled={cancelledToolIds.has(part.id) || (
                                    cancelRequested && part.state !== 'complete' && part.state !== 'error'
                                  )}
                                />
                              );
                            }
                            return null;
                          })}
                        </MessageContent>
                      </Message>
                    </MessageGroup>
                  </MessageScrollerItem>
                ))
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          {messages.length > 0 ? (
            <MessageScrollerButton className="bottom-3">
              <ArrowDownIcon />
              <span className="sr-only">Scroll to latest message</span>
            </MessageScrollerButton>
          ) : null}
        </MessageScroller>
      </MessageScrollerProvider>

      <div className="composer-region shrink-0 px-3 pb-3 pt-2 sm:px-5 lg:px-8">
        <div className="mx-auto w-full max-w-[880px]">
          {displayError ? (
            <Notice tone="error" title="Prompt failed" className="mb-2">{displayError}</Notice>
          ) : null}

          <form
            className="composer-card"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <Textarea
              ref={textareaRef}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                void send();
              }}
              rows={1}
              disabled={!connected}
              aria-label="Pesan untuk agen"
              placeholder={connected ? `Ask ${providerLabel(provider)} about this workspace` : 'Waiting for an agent connection'}
              className="composer-textarea"
            />

            <div className="composer-toolbar">
              <DropdownMenu.Root open={providerMenuOpen} onOpenChange={setProviderMenuOpen}>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    className="composer-selector"
                    disabled={connecting || sending}
                    aria-label={providerLabel(provider)}
                    onClick={(event) => {
                      // Testing Library's synthetic click has detail 0 and
                      // skips Radix's pointer-down path. Real pointer and
                      // keyboard interactions remain owned by Radix.
                      if (event.detail === 0) setProviderMenuOpen((open) => !open);
                    }}
                  >
                    <AgentLogo agent={provider} />
                    <span>{providerLabel(provider)}</span>
                    <ChevronDownIcon />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content side="top" align="start" sideOffset={8} className="menu-content min-w-44">
                    <DropdownMenu.Label className="menu-label">Provider</DropdownMenu.Label>
                    {PROVIDERS.map((item) => (
                      <DropdownMenu.Item
                        key={item.id}
                        className="menu-item"
                        aria-pressed={provider === item.id}
                        onSelect={() => onSelectProvider(item.id)}
                      >
                        <AgentLogo agent={item.id} />
                        <span className="flex-1">{item.label}</span>
                        {provider === item.id ? <span className="text-primary">Selected</span> : null}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>

              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    className="composer-selector max-w-52"
                    disabled={!connected || sending || props.changingModel || !supportsModelSelection}
                    aria-label={`Model: ${activeModel?.label ?? 'agent default'}`}
                    title={supportsModelSelection ? 'Choose model' : 'Model is managed by the agent adapter'}
                  >
                    <span className="truncate">{activeModel?.label ?? 'Default model'}</span>
                    {props.changingModel ? <LoaderCircleIcon className="animate-spin" /> : <ChevronDownIcon />}
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content side="top" align="start" sideOffset={8} className="menu-content min-w-60 max-w-80">
                    <DropdownMenu.Label className="menu-label">Model</DropdownMenu.Label>
                    {models.map((model) => (
                      <DropdownMenu.Item key={model.id} className="menu-item items-start" onSelect={() => props.onSelectModel?.(model.id)}>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-foreground">{model.label}</span>
                          {model.description ? <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{model.description}</span> : null}
                        </span>
                        {selectedModel === model.id ? <span className="text-primary">Selected</span> : null}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>

              <div className="permission-control">
                <button
                  type="button"
                  role="switch"
                  aria-label="Izin penuh"
                  aria-checked={permission === 'nyala' ? true : permission === 'tidak-diketahui' ? 'mixed' : false}
                  disabled={changingPermission || permission === 'tidak-diketahui' || sending}
                  onClick={() => onSetPermission(permission === 'nyala' ? 'ask' : 'full')}
                  className={cn('composer-selector rounded-r-none pr-2', permission === 'nyala' && 'text-warning')}
                  title={permission === 'nyala' ? 'Tool actions run without confirmation' : 'Sensitive actions require approval'}
                >
                  {permission === 'nyala' ? <LockOpenIcon /> : <ShieldCheckIcon />}
                  <span>{permission === 'nyala' ? 'Full access' : permission === 'mati' ? 'Ask permission' : 'Access unknown'}</span>
                </button>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button type="button" className="composer-selector rounded-l-none border-l border-border px-2" aria-label="Choose permission mode" disabled={permission === 'tidak-diketahui' || sending}>
                      <ChevronDownIcon />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content side="top" align="start" sideOffset={8} className="menu-content w-72">
                      <DropdownMenu.Label className="menu-label">Execution permission</DropdownMenu.Label>
                      <DropdownMenu.Item className="menu-item items-start" onSelect={() => onSetPermission('ask')}>
                        <span className="semantic-icon semantic-icon-safe"><ShieldCheckIcon /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-foreground">Ask permission</span>
                          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">Review sensitive tool actions before they run.</span>
                        </span>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item className="menu-item items-start" onSelect={() => onSetPermission('full')}>
                        <span className="semantic-icon semantic-icon-warning"><LockOpenIcon /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-foreground">Full access</span>
                          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">Approve tool permission requests automatically.</span>
                        </span>
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>

              <div className="composer-action">
                {sending ? (
                  <Button type="button" variant="secondary" disabled={cancelling} onClick={() => void stop()} className="min-w-24" aria-label="Hentikan">
                    {cancelling ? <LoaderCircleIcon className="animate-spin" /> : <CircleStopIcon />}
                    {cancelling ? 'Stopping' : 'Stop'}
                  </Button>
                ) : (
                  <Button type="submit" disabled={!canSend} size="icon-lg" className="rounded-lg" title="Send message">
                    <SendIcon />
                    <span className="sr-only">Kirim</span>
                  </Button>
                )}
              </div>
            </div>
          </form>
          <p className="composer-hint">Enter to send <span aria-hidden="true">•</span> Shift + Enter for a new line</p>
        </div>
      </div>
    </div>
  );
}
