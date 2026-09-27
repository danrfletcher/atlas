/**
 * G9b: Documented command splitter and argv builder for API folder click actions.
 *
 * Commands are executed directly as an argv array via `child_process.spawn(argv[0], argv.slice(1))`
 * without ever passing through a shell (`shell: false`). Shell features (pipes, redirects, &&,
 * globbing, ~, env-var expansion) are unsupported in v1.
 *
 * Tokens are split on whitespace outside quotes. Single and double quotes group arguments.
 * Unbalanced quotes are rejected with an error. Placeholders `{field}` are replaced directly
 * within each token, ensuring each token maps to exactly one argv element regardless of spaces,
 * quotes, newlines, or hostile characters in the field value.
 */

export const MAX_ARG_LENGTH = 100 * 1024; // 100 KB

export interface TokenizeResultSuccess {
	ok: true;
	tokens: string[];
}

export interface TokenizeResultFailure {
	ok: false;
	error: string;
}

export type TokenizeResult = TokenizeResultSuccess | TokenizeResultFailure;

/**
 * Splits a command string into tokens by whitespace, respecting single and double quotes.
 * Returns an error if any quote is left unclosed.
 */
export function tokenizeCommand(command: string): TokenizeResult {
	const trimmed = command.trim();
	if (!trimmed) {
		return { ok: true, tokens: [] };
	}

	const tokens: string[] = [];
	let current = "";
	let inQuote: "'" | '"' | null = null;
	let escaped = false;
	let hasTokenChar = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];

		if (escaped) {
			current += char;
			escaped = false;
			hasTokenChar = true;
			continue;
		}

		if (char === "\\") {
			if (inQuote === '"' || inQuote === "'") {
				// Peek next char
				const next = command[i + 1];
				if (next === inQuote || next === "\\") {
					escaped = true;
					continue;
				}
			} else if (i + 1 < command.length && (command[i + 1] === " " || command[i + 1] === "\t" || command[i + 1] === '"' || command[i + 1] === "'")) {
				escaped = true;
				continue;
			}
			current += char;
			hasTokenChar = true;
			continue;
		}

		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
				hasTokenChar = true;
			} else {
				current += char;
				hasTokenChar = true;
			}
			continue;
		}

		if (char === '"' || char === "'") {
			inQuote = char;
			hasTokenChar = true;
			continue;
		}

		if (char === " " || char === "\t" || char === "\n") {
			if (hasTokenChar) {
				tokens.push(current);
				current = "";
				hasTokenChar = false;
			}
			continue;
		}

		current += char;
		hasTokenChar = true;
	}

	if (inQuote) {
		return { ok: false, error: "Unbalanced quote in command" };
	}

	if (hasTokenChar) {
		tokens.push(current);
	}

	return { ok: true, tokens };
}

/**
 * Extracts unique placeholder names from a command string.
 * Matches `{fieldName}` where fieldName is composed of letters, digits, and underscores.
 */
export function extractPlaceholders(command: string): string[] {
	const matches = command.match(/\{([a-zA-Z0-9_]+)\}/g);
	if (!matches) return [];
	const seen = new Set<string>();
	const names: string[] = [];
	for (const m of matches) {
		const name = m.slice(1, -1);
		if (!seen.has(name)) {
			seen.add(name);
			names.push(name);
		}
	}
	return names;
}

export interface ValidationSuccess {
	ok: true;
	tokens: string[];
	placeholders: string[];
}

export interface ValidationFailure {
	ok: false;
	error: string;
}

export type CommandValidationResult = ValidationSuccess | ValidationFailure;

/**
 * Validates a command string for syntax (non-empty, balanced quotes) and checks that all
 * referenced placeholders exist in `availableExtraFields`.
 */
export function validateCommand(command: string, availableExtraFields?: string[]): CommandValidationResult {
	const trimmed = command.trim();
	if (!trimmed) {
		return { ok: false, error: "Command cannot be empty" };
	}

	const tokenResult = tokenizeCommand(trimmed);
	if (!tokenResult.ok) {
		return tokenResult;
	}

	if (tokenResult.tokens.length === 0) {
		return { ok: false, error: "Command cannot be empty" };
	}

	const placeholders = extractPlaceholders(trimmed);
	if (availableExtraFields !== undefined) {
		const availableSet = new Set(availableExtraFields);
		for (const p of placeholders) {
			if (!availableSet.has(p)) {
				return { ok: false, error: `Unknown placeholder: {${p}}` };
			}
		}
	}

	return { ok: true, tokens: tokenResult.tokens, placeholders };
}

export interface ResolveArgvSuccess {
	ok: true;
	argv: string[];
}

export interface ResolveArgvFailure {
	ok: false;
	error: string;
	missingPlaceholder?: string;
	overlength?: boolean;
}

export type ResolveArgvResult = ResolveArgvSuccess | ResolveArgvFailure;

/**
 * Resolves command tokens into a final argv array by substituting placeholders with values from `extra`.
 *
 * Each token becomes exactly one argv element. Hostile field values (e.g. `; rm -rf ~`, `$(touch ...)`,
 * newlines, leading flags) remain intact as a literal argument string.
 *
 * If a placeholder has no value (missing/null/undefined), resolution fails.
 * If any substituted value exceeds `MAX_ARG_LENGTH` (100 KB), resolution fails.
 */
export function resolveArgv(tokens: string[], extra: Record<string, unknown> | undefined): ResolveArgvResult {
	const argv: string[] = [];

	for (const token of tokens) {
		// Check for placeholders in this token
		const placeholderMatches = token.match(/\{([a-zA-Z0-9_]+)\}/g);
		if (!placeholderMatches) {
			argv.push(token);
			continue;
		}

		let resolvedToken = token;
		for (const m of placeholderMatches) {
			const name = m.slice(1, -1);
			if (extra === undefined || !Object.prototype.hasOwnProperty.call(extra, name) || extra[name] === undefined || extra[name] === null) {
				return {
					ok: false,
					error: `Missing value for placeholder: {${name}}`,
					missingPlaceholder: name,
				};
			}

			const valStr = String(extra[name]);
			if (valStr.length > MAX_ARG_LENGTH) {
				return {
					ok: false,
					error: `Field value exceeds ${MAX_ARG_LENGTH / 1024} KB limit`,
					overlength: true,
				};
			}

			// If the entire token is exactly this placeholder, substitute it directly
			if (resolvedToken === m) {
				resolvedToken = valStr;
			} else {
				resolvedToken = resolvedToken.split(m).join(valStr);
			}
		}

		argv.push(resolvedToken);
	}

	return { ok: true, argv };
}

/**
 * Previews resolved argv for the Test button in the modal.
 */
export function previewArgv(
	command: string,
	extra?: Record<string, unknown>,
	availableExtraFields?: string[]
): { ok: true; argv: string[] } | { ok: false; error: string } {
	const validation = validateCommand(command, availableExtraFields);
	if (!validation.ok) return validation;

	const resolved = resolveArgv(validation.tokens, extra ?? {});
	if (!resolved.ok) return { ok: false, error: resolved.error };

	return { ok: true, argv: resolved.argv };
}
