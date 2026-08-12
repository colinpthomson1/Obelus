import { act, render, screen } from '@testing-library/react';
import type { IpcRendererEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { AppLayout } from './AppLayout';

const mocks = vi.hoisted(() => ({
  fetchSessions: vi.fn(),
  handleNavClick: vi.fn(),
  handleSessionClick: vi.fn(),
  setChat: vi.fn(),
}));

vi.mock('react-router', () => ({
  Outlet: () => null,
  useLocation: () => ({ pathname: '/' }),
}));

vi.mock('../ChatSessionsContainer', () => ({
  default: () => null,
}));

vi.mock('../../contexts/ChatContext', () => ({
  useChatContext: () => ({ setChat: mocks.setChat }),
}));

vi.mock('../ConfigContext', () => ({
  useConfig: () => ({ extensionsList: [] }),
}));

vi.mock('../../hooks/useNavigationSessions', () => ({
  useNavigationSessions: () => ({
    recentSessions: [],
    recentSessionsByProject: [],
    activeSessionId: undefined,
    fetchSessions: mocks.fetchSessions,
    handleNavClick: mocks.handleNavClick,
    handleSessionClick: mocks.handleSessionClick,
  }),
}));

vi.mock('../brand/ObelusBrand', () => ({
  ObelusReverseLockup: ({ className }: { className?: string }) => (
    <div data-testid="obelus-lockup" className={className} />
  ),
}));

vi.mock('../../acp/sessions', () => ({
  acpRenameSession: vi.fn(),
}));

const renderLayout = () =>
  render(
    <IntlTestWrapper>
      <AppLayout activeSessions={[]} />
    </IntlTestWrapper>
  );

const getToggleContainer = () =>
  screen.getByRole('button', { name: 'Collapse navigation' }).parentElement;

const getBrandHeader = () => screen.getByTestId('obelus-lockup').parentElement;

describe('AppLayout window-control spacing', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    Object.assign(window.electron, { platform: 'darwin' });
    vi.mocked(window.electron.getIsFullScreen).mockResolvedValue(false);
    vi.stubGlobal('requestAnimationFrame', (callback: (timestamp: number) => void) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    Object.assign(window.electron, { platform: 'darwin' });
    vi.unstubAllGlobals();
  });

  it('keeps the navigation toggle and brand below macOS window controls until fullscreen', () => {
    let fullscreenHandler: ((event: IpcRendererEvent, ...args: unknown[]) => void) | undefined;

    vi.mocked(window.electron.on).mockImplementation((channel, callback) => {
      if (channel === 'fullscreen-change') fullscreenHandler = callback;
    });

    renderLayout();

    expect(getToggleContainer()).toHaveClass('left-24', 'top-3');
    expect(getBrandHeader()).toHaveClass('h-[104px]');

    act(() => fullscreenHandler?.({} as IpcRendererEvent, true));

    expect(getToggleContainer()).toHaveClass('left-4', 'top-3');
    expect(getToggleContainer()).not.toHaveClass('left-24');
    expect(getBrandHeader()).toHaveClass('h-[72px]');
    expect(getBrandHeader()).not.toHaveClass('h-[104px]');
  });

  it('uses the compact header layout on platforms without macOS traffic lights', () => {
    Object.assign(window.electron, { platform: 'win32' });

    renderLayout();

    expect(getToggleContainer()).toHaveClass('left-4', 'top-3');
    expect(getToggleContainer()).not.toHaveClass('left-24');
    expect(getBrandHeader()).toHaveClass('h-[72px]');
    expect(getBrandHeader()).not.toHaveClass('h-[104px]');
    expect(window.electron.getIsFullScreen).not.toHaveBeenCalled();
    expect(window.electron.on).not.toHaveBeenCalledWith('fullscreen-change', expect.any(Function));
  });
});
