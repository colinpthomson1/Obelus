import React, { useCallback, useEffect, useRef, useState } from 'react';
import { IpcRendererEvent } from 'electron';
import { Outlet, useLocation } from 'react-router';
import { motion } from 'framer-motion';
import { Menu, PanelLeft } from 'lucide-react';
import { defineMessages, useIntl } from '../../i18n';
import { Button } from '../ui/button';
import ChatSessionsContainer from '../ChatSessionsContainer';
import { useChatContext } from '../../contexts/ChatContext';
import {
  MAX_NAV_WIDTH,
  MIN_NAV_WIDTH,
  NavigationProvider,
  useNavigationContext,
} from './NavigationContext';
import { Navigation } from './NavigationPanel';
import { Z_INDEX } from './constants';
import { cn } from '../../utils';
import { UserInput } from '../../types/message';

const i18n = defineMessages({
  openNavigation: {
    id: 'appLayout.openNavigation',
    defaultMessage: 'Open navigation',
  },
  collapseNavigation: {
    id: 'appLayout.collapseNavigation',
    defaultMessage: 'Collapse navigation',
  },
  resizeNavigation: {
    id: 'appLayout.resizeNavigation',
    defaultMessage: 'Resize navigation',
  },
});

interface AppLayoutContentProps {
  activeSessions: Array<{
    sessionId: string;
    initialMessage?: UserInput;
    noAutoSubmit?: boolean;
  }>;
}

const AppLayoutContent: React.FC<AppLayoutContentProps> = ({ activeSessions }) => {
  const intl = useIntl();
  const location = useLocation();
  const safeIsMacOS = (window?.electron?.platform || 'darwin') === 'darwin';
  const chatContext = useChatContext();
  const isOnPairRoute = location.pathname === '/pair';

  const [isFullScreen, setIsFullScreen] = useState(false);

  useEffect(() => {
    if (!safeIsMacOS) return;
    window.electron
      .getIsFullScreen()
      .then(setIsFullScreen)
      .catch(() => {});
    const handler = (_event: IpcRendererEvent, ...args: unknown[]) => {
      setIsFullScreen(Boolean(args[0]));
    };
    window.electron.on('fullscreen-change', handler);
    return () => window.electron.off('fullscreen-change', handler);
  }, [safeIsMacOS]);

  const { isNavExpanded, setIsNavExpanded, navWidth, setNavWidth } = useNavigationContext();
  const [isDragging, setIsDragging] = useState(false);
  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      isResizing.current = true;
      startX.current = e.clientX;
      startWidth.current = navWidth;
      setIsDragging(true);
      e.preventDefault();
    },
    [navWidth]
  );

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const step = event.shiftKey ? 16 : 8;
      let nextWidth: number | null = null;

      if (event.key === 'ArrowLeft') nextWidth = navWidth - step;
      if (event.key === 'ArrowRight') nextWidth = navWidth + step;
      if (event.key === 'Home') nextWidth = MIN_NAV_WIDTH;
      if (event.key === 'End') nextWidth = MAX_NAV_WIDTH;

      if (nextWidth !== null) {
        event.preventDefault();
        setNavWidth(nextWidth);
      }
    },
    [navWidth, setNavWidth]
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      setNavWidth(startWidth.current + (e.clientX - startX.current));
    };
    const handleMouseUp = () => {
      if (isResizing.current) {
        isResizing.current = false;
        setIsDragging(false);
      }
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [setNavWidth]);

  if (!chatContext) {
    throw new Error('AppLayoutContent must be used within ChatProvider');
  }

  const { setChat } = chatContext;

  const needsTrafficLightInset = safeIsMacOS && !isFullScreen;
  const navToggleTitle = intl.formatMessage(
    isNavExpanded ? i18n.collapseNavigation : i18n.openNavigation
  );

  return (
    <div className="relative flex h-full w-full flex-1 flex-row bg-brand-paper animate-fade-in dark:bg-brand-ink">
      <div
        style={{ zIndex: Z_INDEX.HEADER }}
        className={cn(
          'absolute flex items-center',
          needsTrafficLightInset ? 'left-24 top-3' : 'left-4 top-3'
        )}
      >
        <Button
          onClick={() => setIsNavExpanded(!isNavExpanded)}
          className={cn(
            'no-drag !h-11 !w-11 rounded-md p-0',
            isNavExpanded
              ? 'text-brand-cloud hover:!bg-brand-ink-muted focus-visible:!ring-brand-aqua'
              : 'text-text-primary hover:!bg-background-tertiary'
          )}
          variant="ghost"
          size="xs"
          title={navToggleTitle}
          aria-label={navToggleTitle}
        >
          {isNavExpanded ? <PanelLeft className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </Button>
      </div>

      <div className="flex flex-1 w-full h-full min-h-0 flex-row">
        <motion.div
          key="nav"
          initial={false}
          animate={{ width: isNavExpanded ? navWidth : 0 }}
          transition={isDragging ? { duration: 0 } : { duration: 0.28, ease: [0.65, 0, 0.35, 1] }}
          style={{ height: '100%' }}
          className="relative h-full flex-shrink-0 overflow-hidden border-r border-brand-ink-muted bg-brand-ink"
        >
          <div className="h-full w-full overflow-hidden">
            <Navigation reserveWindowControls={needsTrafficLightInset} />
          </div>
          {isNavExpanded && (
            <div
              role="separator"
              aria-label={intl.formatMessage(i18n.resizeNavigation)}
              aria-orientation="vertical"
              aria-valuemin={MIN_NAV_WIDTH}
              aria-valuemax={MAX_NAV_WIDTH}
              aria-valuenow={navWidth}
              tabIndex={0}
              className="absolute right-0 top-0 h-full w-2 cursor-col-resize transition-colors hover:bg-brand-aqua/25 focus-visible:bg-brand-aqua/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-aqua"
              onMouseDown={handleResizeMouseDown}
              onKeyDown={handleResizeKeyDown}
            />
          )}
        </motion.div>

        <main className="min-h-0 flex-1 overflow-hidden bg-background-primary">
          <Outlet />
          {/* Always render ChatSessionsContainer to keep SSE connections alive.
              When navigating away from /pair, hide it with CSS */}
          <div className={isOnPairRoute ? 'contents' : 'hidden'}>
            <ChatSessionsContainer setChat={setChat} activeSessions={activeSessions} />
          </div>
        </main>
      </div>
    </div>
  );
};

interface AppLayoutProps {
  activeSessions: Array<{
    sessionId: string;
    initialMessage?: UserInput;
    noAutoSubmit?: boolean;
  }>;
}

export const AppLayout: React.FC<AppLayoutProps> = ({ activeSessions }) => {
  return (
    <NavigationProvider>
      <AppLayoutContent activeSessions={activeSessions} />
    </NavigationProvider>
  );
};
