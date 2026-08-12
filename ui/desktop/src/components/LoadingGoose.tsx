import GooseLogo from './GooseLogo';
import { ChatState } from '../types/chatState';
import { defineMessages, useIntl } from '../i18n';
import { ObelusLoader } from './brand/ObelusLoader';

interface LoadingGooseProps {
  message?: string;
  chatState?: ChatState;
}

const i18n = defineMessages({
  loadingConversation: {
    id: 'loadingGoose.loadingConversation',
    defaultMessage: 'Opening the research thread…',
  },
  thinking: {
    id: 'loadingGoose.thinking',
    defaultMessage: 'Obelus is examining the request…',
  },
  streaming: {
    id: 'loadingGoose.streaming',
    defaultMessage: 'Obelus is building the response…',
  },
  waiting: {
    id: 'loadingGoose.waiting',
    defaultMessage: 'Waiting for your direction…',
  },
  compacting: {
    id: 'loadingGoose.compacting',
    defaultMessage: 'Refining the conversation…',
  },
  idle: {
    id: 'loadingGoose.idle',
    defaultMessage: 'Ready',
  },
  restartingAgent: {
    id: 'loadingGoose.restartingAgent',
    defaultMessage: 'Restarting the session…',
  },
});

const STATE_ICONS: Record<ChatState, React.ReactNode> = {
  [ChatState.LoadingConversation]: <ObelusLoader variant="obelus-resolve" announce={false} />,
  [ChatState.Thinking]: <ObelusLoader variant="proof-pulse" announce={false} />,
  [ChatState.Streaming]: <ObelusLoader variant="proof-pulse" announce={false} />,
  [ChatState.WaitingForUserInput]: <GooseLogo size="small" hover={false} />,
  [ChatState.Compacting]: <ObelusLoader variant="obelus-resolve" announce={false} />,
  [ChatState.Idle]: <GooseLogo size="small" hover={false} />,
  [ChatState.RestartingAgent]: <ObelusLoader variant="proof-pulse" announce={false} />,
};

const STATE_MESSAGE_KEYS: Record<ChatState, keyof typeof i18n> = {
  [ChatState.LoadingConversation]: 'loadingConversation',
  [ChatState.Thinking]: 'thinking',
  [ChatState.Streaming]: 'streaming',
  [ChatState.WaitingForUserInput]: 'waiting',
  [ChatState.Compacting]: 'compacting',
  [ChatState.Idle]: 'idle',
  [ChatState.RestartingAgent]: 'restartingAgent',
};

const LoadingGoose = ({ message, chatState = ChatState.Idle }: LoadingGooseProps) => {
  const intl = useIntl();
  const displayMessage = message || intl.formatMessage(i18n[STATE_MESSAGE_KEYS[chatState]]);
  const icon = STATE_ICONS[chatState];

  return (
    <div className="w-full animate-fade-slide-up" aria-live="polite">
      <div
        data-testid="loading-indicator"
        className="flex items-center gap-2 py-2 font-mono text-xs text-text-secondary"
      >
        {icon}
        {displayMessage}
      </div>
    </div>
  );
};

export default LoadingGoose;
