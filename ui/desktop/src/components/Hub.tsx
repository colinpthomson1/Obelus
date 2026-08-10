/**
 * Hub Component
 *
 * The empty-chat landing screen introduces Obelus's evidence-led point of view
 * while keeping the existing general-agent workflow honest. Submitting creates
 * a session and navigates to /pair for the rest of the chat lifecycle.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Braces, FilePenLine, Search } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import { AppEvents } from '../constants/events';
import ChatInput from './ChatInput';
import { ChatInputCard } from './ChatInputCard';
import { ChatState } from '../types/chatState';
import 'react-toastify/dist/ReactToastify.css';
import { View, ViewOptions } from '../utils/navigationUtils';
import { useConfig } from './ConfigContext';
import { getInitialWorkingDir } from '../utils/workingDir';
import { createSession } from '../sessions';
import LoadingGoose from './LoadingGoose';
import { ObelusLockup } from './brand/ObelusBrand';
import { UserInput } from '../types/message';
import {
  createNextChatExtensionDraft,
  selectNextChatExtensions,
  type NextChatExtensionDraft,
} from '../utils/nextChatExtensions';

const i18n = defineMessages({
  category: { id: 'hub.category', defaultMessage: 'Evidence-led AI workspace' },
  headline: { id: 'hub.headline', defaultMessage: 'What should we examine?' },
  description: {
    id: 'hub.description',
    defaultMessage:
      'Bring a question, document, or task. Obelus can research, reason, write, code, and work with the tools you connect—keeping the work visible in the conversation.',
  },
  research: { id: 'hub.capabilityResearch', defaultMessage: 'Research' },
  researchDescription: {
    id: 'hub.capabilityResearchDescription',
    defaultMessage: 'Find, compare, and synthesize information',
  },
  create: { id: 'hub.capabilityCreate', defaultMessage: 'Create' },
  createDescription: {
    id: 'hub.capabilityCreateDescription',
    defaultMessage: 'Draft, revise, explain, and structure ideas',
  },
  build: { id: 'hub.capabilityBuild', defaultMessage: 'Build' },
  buildDescription: {
    id: 'hub.capabilityBuildDescription',
    defaultMessage: 'Write code, automate tasks, and use tools',
  },
  startThread: { id: 'hub.startThread', defaultMessage: 'Start a new research thread' },
  privacy: {
    id: 'hub.privacy',
    defaultMessage:
      'Your files stay on this device unless you choose to share them with a model or connected tool.',
  },
});

export default function Hub({
  setView,
}: {
  setView: (view: View, viewOptions?: ViewOptions) => void;
}) {
  const intl = useIntl();
  const { extensionsList } = useConfig();
  const [workingDir, setWorkingDir] = useState(getInitialWorkingDir());
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [nextChatExtensionDraft, setNextChatExtensionDraft] =
    useState<NextChatExtensionDraft | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const draftForMenu = useMemo(
    () => nextChatExtensionDraft ?? createNextChatExtensionDraft(extensionsList),
    [extensionsList, nextChatExtensionDraft]
  );

  // rAF is more reliable than autoFocus across async render boundaries.
  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frameId);
  }, []);

  const handleNextChatExtensionDraftChange = useCallback((draft: NextChatExtensionDraft) => {
    setNextChatExtensionDraft(draft);
  }, []);

  const handleSubmit = async (input: UserInput) => {
    const { msg: userMessage, images } = input;
    if (!(images.length > 0 || userMessage.trim()) || isCreatingSession) return;

    setIsCreatingSession(true);

    try {
      const selectedExtensions = nextChatExtensionDraft
        ? selectNextChatExtensions(extensionsList, nextChatExtensionDraft)
        : [];
      const sessionOptions =
        selectedExtensions.length > 0
          ? { extensionConfigs: selectedExtensions }
          : { allExtensions: extensionsList };

      const session = await createSession(workingDir, sessionOptions);
      setNextChatExtensionDraft(null);

      window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED));
      window.dispatchEvent(
        new CustomEvent(AppEvents.ADD_ACTIVE_SESSION, {
          detail: { sessionId: session.id, initialMessage: { msg: userMessage, images } },
        })
      );

      setView('pair', {
        disableAnimation: true,
        resumeSessionId: session.id,
        initialMessage: { msg: userMessage, images },
      });
    } catch (error) {
      console.error('Failed to create session:', error);
      setIsCreatingSession(false);
    }
  };

  return (
    <div className="relative h-full min-h-0 overflow-y-auto bg-background-primary">
      <div className="mx-auto flex min-h-full w-full max-w-[1040px] flex-col justify-center px-6 py-20 md:px-12">
        <header className="max-w-[760px]">
          <ObelusLockup className="mb-10 h-10" />
          <p className="mb-4 font-mono text-xs font-medium uppercase tracking-[0.14em] text-brand-blue-dark dark:text-brand-aqua">
            {intl.formatMessage(i18n.category)}
          </p>
          <h1 className="max-w-[680px] text-[clamp(2.5rem,6vw,4.75rem)] font-semibold leading-[0.98] tracking-[-0.045em] text-text-primary">
            {intl.formatMessage(i18n.headline)}
          </h1>
          <p className="mt-6 max-w-[700px] text-lg leading-7 text-text-secondary">
            {intl.formatMessage(i18n.description)}
          </p>
        </header>

        <div className="mt-10 grid max-w-[920px] grid-cols-1 border-y border-border-primary sm:grid-cols-3">
          {[
            {
              icon: Search,
              title: intl.formatMessage(i18n.research),
              description: intl.formatMessage(i18n.researchDescription),
            },
            {
              icon: FilePenLine,
              title: intl.formatMessage(i18n.create),
              description: intl.formatMessage(i18n.createDescription),
            },
            {
              icon: Braces,
              title: intl.formatMessage(i18n.build),
              description: intl.formatMessage(i18n.buildDescription),
            },
          ].map(({ icon: Icon, title, description }, index) => (
            <div
              key={title}
              className={`flex gap-3 py-4 sm:px-5 ${index === 0 ? 'sm:pl-0' : 'border-t border-border-primary sm:border-l sm:border-t-0'}`}
            >
              <Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-blue dark:text-brand-aqua" />
              <div>
                <p className="font-semibold text-text-primary">{title}</p>
                <p className="mt-0.5 text-sm leading-5 text-text-secondary">{description}</p>
              </div>
            </div>
          ))}
        </div>

        <section className="mt-10 w-full max-w-[920px]" aria-labelledby="new-thread-title">
          <div className="mb-3 flex items-center justify-between gap-4 px-1">
            <h2 id="new-thread-title" className="text-sm font-semibold text-text-primary">
              {intl.formatMessage(i18n.startThread)}
            </h2>
            <span className="hidden font-mono text-xs text-text-tertiary sm:inline">
              Evidence at conversation speed.
            </span>
          </div>
          <ChatInputCard className="border-border-tertiary shadow-md focus-within:border-brand-blue focus-within:ring-2 focus-within:ring-brand-blue/15 dark:focus-within:border-brand-aqua dark:focus-within:ring-brand-aqua/15">
            <ChatInput
              sessionId={null}
              handleSubmit={handleSubmit}
              chatState={isCreatingSession ? ChatState.LoadingConversation : ChatState.Idle}
              onStop={() => {}}
              initialValue=""
              setView={setView}
              totalTokens={0}
              accumulatedInputTokens={0}
              accumulatedOutputTokens={0}
              droppedFiles={[]}
              onFilesProcessed={() => {}}
              messages={[]}
              disableAnimation={false}
              onWorkingDirChange={setWorkingDir}
              inputRef={inputRef}
              nextChatExtensionDraft={draftForMenu}
              onNextChatExtensionDraftChange={handleNextChatExtensionDraftChange}
            />
          </ChatInputCard>
          <p className="mt-3 max-w-[680px] px-1 text-xs leading-5 text-text-tertiary">
            {intl.formatMessage(i18n.privacy)}
          </p>
        </section>
      </div>

      {isCreatingSession && (
        <div className="pointer-events-none fixed bottom-4 left-4 z-20 rounded-md border border-border-primary bg-background-primary px-3 shadow-md">
          <LoadingGoose chatState={ChatState.LoadingConversation} />
        </div>
      )}
    </div>
  );
}
