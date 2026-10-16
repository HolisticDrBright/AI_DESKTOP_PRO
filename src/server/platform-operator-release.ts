/**
 * This Desktop's own switch for the platform operator console (/operator and /api/operator/*). `blocked` refuses
 * every operator route before it reads a cookie, a body or the network; the operator API, the operator sign-in, the
 * proposal review and the suspension service each hold their own release as well, and no operator pool or operator
 * account exists. Changing it is a reviewed change after the security review, never a configuration value.
 */
export const DESKTOP_PLATFORM_OPERATOR_CONSOLE_RELEASE: 'blocked' | 'qualification' = 'blocked';
