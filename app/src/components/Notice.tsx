import type { ReactNode } from 'react';
import { AlertCircleIcon, CheckCircle2Icon, InfoIcon, TriangleAlertIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

type Tone = 'info' | 'success' | 'warning' | 'error';

const icons = {
  info: InfoIcon,
  success: CheckCircle2Icon,
  warning: TriangleAlertIcon,
  error: AlertCircleIcon,
};

export function Notice({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const Icon = icons[tone];
  return (
    <div className={cn('notice', `notice-${tone}`, className)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium text-foreground">{title}</p> : null}
        <div
          role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}
          className="text-sm leading-relaxed"
        >
          {children}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
