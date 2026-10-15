/** Account types shown in the UI (the backend stores them as plain strings on users.account_type). */
export const ACCOUNT_TYPES = [
  { value: 'INDIVIDUAL', label: 'Individual', plural: 'Individuals' },
  { value: 'ORGANIZATION', label: 'Organization', plural: 'Organizations' },
];
export const DEFAULT_ACCOUNT_TYPE = 'INDIVIDUAL';
export const ACCOUNT_LABEL = Object.fromEntries(ACCOUNT_TYPES.map((t) => [t.value, t.label]));
export const accountLabel = (v) => ACCOUNT_LABEL[v] || v;
