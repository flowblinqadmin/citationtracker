/**
 * e2e/helpers/storage-state.ts — canonical path for the playwright
 * storageState file. Specs don't normally need this constant because
 * playwright.config.ts `use.storageState` threads it into every context;
 * it's exported here for tests that want to write/read the file directly.
 */
export const STORAGE_STATE_PATH = "e2e/.playwright-storage-state.json";
