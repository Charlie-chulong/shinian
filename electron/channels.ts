export const CHANNELS = {
  state: 'shinian:get-state',
  dispatch: 'shinian:dispatch',
  changed: 'shinian:state-changed',
  info: 'shinian:get-info',
  export: 'shinian:export',
  import: 'shinian:import',
  openData: 'shinian:open-data-folder',
  backups: 'shinian:list-backups',
  restore: 'shinian:restore-backup',
  quick: 'shinian:open-quick-capture',
  window: 'shinian:window-action',
} as const;
