import claudeLogo from '@lobehub/icons-static-svg/icons/claude-color.svg';
import codexLogo from '@lobehub/icons-static-svg/icons/openai.svg';

interface AgentLogoProps {
  agent: string;
  className?: string;
}

export function AgentLogo({ agent, className = 'size-4' }: AgentLogoProps) {
  const isClaude = agent === 'claude';

  return (
    <span className={`grid shrink-0 place-items-center ${className}`} aria-hidden="true">
      <img
        src={isClaude ? claudeLogo : codexLogo}
        alt=""
        className={`size-full object-contain ${isClaude ? '' : 'invert'}`}
      />
    </span>
  );
}
