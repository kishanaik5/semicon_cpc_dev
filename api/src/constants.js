/**
 * Account types. Change the values here (and in web/src/constants.js) to rename them;
 * migrate.js remaps legacy values on startup.
 */
export const ACCOUNT_TYPES = ['INDIVIDUAL', 'ORGANIZATION'];
export const DEFAULT_ACCOUNT_TYPE = 'INDIVIDUAL';
export const LEGACY_ACCOUNT_TYPE_MAP = { STUDENT: 'INDIVIDUAL', CORPORATE: 'ORGANIZATION' };
