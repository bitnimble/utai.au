import classNames from 'classnames';
import { Moon, Sun } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { appSettingsPresenter, appSettingsStore } from 'src/settings/app_settings_presenter';
import styles from './theme_toggle.module.css';

export const ThemeToggle = observer(function ThemeToggle({ className }: { className?: string }) {
  const label = appSettingsStore.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <button
      type="button"
      className={classNames(styles.toggle, className)}
      onClick={() => appSettingsPresenter.toggleTheme()}
      title={label}
      aria-label={label}
      data-testid="theme-toggle"
    >
      {appSettingsStore.theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
    </button>
  );
});
