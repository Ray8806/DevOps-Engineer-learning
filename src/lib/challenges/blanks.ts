/**
 * Blanks are written as {{id}} in challenge files and commands. Kept apart
 * from the content schema so the browser can use it without loading zod.
 */
export const BLANK_PATTERN = /\{\{([a-z][a-z0-9-]*)\}\}/g;
