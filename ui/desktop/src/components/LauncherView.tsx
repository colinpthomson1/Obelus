import { useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { defineMessages, useIntl } from '../i18n';
import { getInitialWorkingDir } from '../utils/workingDir';
import { ObelusMark } from './brand/ObelusBrand';

const messages = defineMessages({
  placeholder: {
    id: 'launcher.placeholder',
    defaultMessage: 'Ask Obelus to research, write, build, or explain…',
  },
  inputLabel: {
    id: 'launcher.inputLabel',
    defaultMessage: 'Start a new Obelus research thread',
  },
  submit: {
    id: 'launcher.submit',
    defaultMessage: 'Open research thread',
  },
});

export default function LauncherView() {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const intl = useIntl();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      const initialMessage = query;
      setQuery('');
      window.electron.createChatWindow({ query: initialMessage, dir: getInitialWorkingDir() });
      setTimeout(() => {
        window.electron.closeWindow();
      }, 200);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Close on Escape
    if (e.key === 'Escape') {
      window.electron.closeWindow();
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-transparent p-1.5">
      <form
        onSubmit={handleSubmit}
        className="flex h-full w-full items-center overflow-hidden rounded-xl border border-border-tertiary bg-background-primary/95 shadow-lg backdrop-blur-xl transition-[border-color,box-shadow] duration-200 focus-within:border-brand-blue focus-within:ring-2 focus-within:ring-brand-blue/20 dark:focus-within:border-brand-aqua dark:focus-within:ring-brand-aqua/25"
      >
        <div className="flex h-full w-16 shrink-0 items-center justify-center bg-brand-ink">
          <ObelusMark tone="cloud" decorative className="h-8 w-8" />
        </div>
        <label htmlFor="obelus-launcher-input" className="sr-only">
          {intl.formatMessage(messages.inputLabel)}
        </label>
        <input
          ref={inputRef}
          id="obelus-launcher-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent px-5 text-lg text-text-primary outline-none placeholder:text-text-secondary focus-visible:outline-none"
          placeholder={intl.formatMessage(messages.placeholder)}
          autoFocus
        />
        <button
          type="submit"
          disabled={!query.trim()}
          aria-label={intl.formatMessage(messages.submit)}
          className="mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-brand-blue text-brand-cloud transition-colors duration-200 hover:bg-brand-blue-dark focus-visible:ring-2 focus-visible:ring-brand-aqua focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-35"
        >
          <ArrowUp className="h-5 w-5" />
        </button>
      </form>
    </div>
  );
}
