/**
 * The settings section stylesheet, injected for the plugin lifetime. Colors
 * ride the Harness `--dsw-*` tokens so the page re-themes with whatever
 * theme is active; one class family (`dpm-*`) keeps it collision-free.
 *
 * @module dsh-deep-plugin-manager/client/styles
 */

export const SECTION_STYLES = `
.dpm-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 720px;
  color: var(--dsw-alias-label-primary);
}
.dpm-heading {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dpm-intro {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.dpm-note {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dpm-install {
  display: flex;
  gap: 8px;
}
.dpm-install input {
  flex: 1;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-specific-input-major);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
}
.dpm-install input:focus-visible {
  outline: 2px solid var(--dsw-alias-button-ghost-active-border);
  outline-offset: 1px;
}
.dpm-install input::placeholder { color: var(--dsw-alias-label-caption); }
.dpm-button {
  height: 34px;
  padding: 0 14px;
  border: 0;
  border-radius: 8px;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.dpm-button:hover { background: var(--dsw-alias-button-primary-hover); }
.dpm-button:focus-visible {
  outline: 2px solid var(--dsw-alias-button-ghost-active-border);
  outline-offset: 1px;
}
.dpm-button:disabled {
  opacity: 0.6;
  cursor: default;
}
.dpm-button.quiet {
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l2);
}
.dpm-button.quiet:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dpm-button.danger {
  background: transparent;
  color: var(--dsw-alias-state-error-primary);
  border: 1px solid var(--dsw-alias-border-l2);
}
.dpm-button.danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); }
.dpm-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dpm-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px 12px;
  padding: 12px 14px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
}
.dpm-main {
  flex: 1 1 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dpm-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dpm-version {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  margin-left: 6px;
}
.dpm-pkg {
  font-size: 11px;
  color: var(--dsw-alias-label-caption);
  margin-left: 6px;
}
.dpm-spec {
  font-size: 12px;
  color: var(--dsw-alias-label-caption);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dpm-desc {
  font-size: 12px;
  line-height: 17px;
  color: var(--dsw-alias-label-secondary);
  margin-top: 2px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dpm-state {
  flex: none;
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  background: transparent;
}
.dpm-switch {
  flex: none;
  position: relative;
  width: 36px;
  height: 20px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  cursor: pointer;
  padding: 0;
  transition: background var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    border-color var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.dpm-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  background: var(--dsw-alias-label-secondary);
  transition: transform var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease),
    background var(--ds-transition-duration-fast, 0.1s) var(--ds-ease-in-out, ease);
}
.dpm-switch[aria-checked='true'] {
  background: var(--dsw-alias-state-success-primary);
  border-color: transparent;
}
.dpm-switch[aria-checked='true']::after {
  transform: translateX(16px);
  background: var(--dsw-alias-label-primary-foreground);
}
.dpm-switch:focus-visible {
  outline: 2px solid var(--dsw-alias-button-ghost-active-border);
  outline-offset: 1px;
}
.dpm-switch:disabled {
  opacity: 0.6;
  cursor: default;
}
.dpm-state.on {
  color: var(--dsw-alias-state-success-primary);
  border-color: var(--dsw-alias-state-success-primary);
}
.dpm-state:focus-visible {
  outline: 2px solid var(--dsw-alias-button-ghost-active-border);
  outline-offset: 1px;
}
.dpm-actions {
  flex: none;
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.dpm-badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-label);
}
.dpm-banner {
  font-size: 13px;
  line-height: 19px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
}
.dpm-banner.ok {
  color: var(--dsw-alias-state-success-primary);
  border-color: var(--dsw-alias-state-success-primary);
  background: var(--dsw-alias-state-success-tertiary);
}
.dpm-banner.error {
  color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-state-error-secondary);
  overflow-wrap: anywhere;
}
.dpm-banner.info {
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
}
.dpm-detail {
  margin: 6px 0 0;
  font-size: 11px;
  font-family: var(--ds-font-family-code, monospace);
  white-space: pre-wrap;
  word-break: break-word;
  color: inherit;
  opacity: 0.75;
}
.dpm-empty {
  margin: 0;
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary);
}
.dpm-detail-toggle {
  border: 0;
  background: none;
  padding: 0;
  margin-left: 8px;
  font: inherit;
  font-size: 11px;
  text-decoration: underline;
  cursor: pointer;
  color: inherit;
}
`
