// KQL safety helpers. The validator, sanitizer, and identifier rules are ports of
// azure-mcp 3.0.0-beta.49 (KqlQueryValidator, KqlSanitizer,
// KustoIdentifierValidator, BaseAzureService.EscapeKqlString), so the
// compatible tools accept and refuse the same input as before. scanKql and the
// checks built on it are stricter, and guard the additive tools.

/** azure-mcp CommandValidationException: a 400 envelope without results. */
export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "CommandValidationException";
    this.status = status;
  }
}

/** .NET ArgumentException: a 400 envelope with results and the troubleshooting link. */
export class ArgumentError extends Error {
  constructor(message, paramName) {
    super(paramName ? `${message} (Parameter '${paramName}')` : message);
    this.name = "ArgumentException";
    this.status = 400;
  }
}

export const MAX_QUERY_LENGTH = 10_000;

const DANGEROUS_COMMANDS = [
  ".drop",
  ".alter",
  ".create",
  ".delete",
  ".set",
  ".append",
  ".set-or-append",
  ".set-or-replace",
  ".ingest",
  ".purge",
  ".execute",
];

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
const TAUTOLOGY = /\bor\s+(\d+\s*==?\s*\d+|true|'[^']*'\s*==?\s*'[^']*')/i;
const MANAGEMENT = new RegExp(`(?:^|[|;])\\s*(?:${DANGEROUS_COMMANDS.map(escapeRegex).join("|")})`, "i");
// Any control command (a dot-word) at the start or after a pipe or semicolon.
const ANY_CONTROL = /(?:^|[|;\n])\s*\.[A-Za-z]/g;

/** Port of KqlQueryValidator.ValidateQuerySafety. Throws ValidationError. */
export function validateQuerySafety(query, maxLength = MAX_QUERY_LENGTH) {
  if (typeof query !== "string" || !query.trim()) throw new ValidationError("Query cannot be empty.");
  if (query.length > maxLength) {
    throw new ValidationError(`Query length exceeds the maximum allowed limit of ${maxLength.toLocaleString("en-US")} characters.`);
  }
  const withoutStrings = query.replace(/'([^']|'')*'/g, "'str'");
  if (TAUTOLOGY.test(withoutStrings)) {
    throw new ValidationError("Suspicious boolean tautology pattern detected. Conditions like 'or 1==1' or 'or true' are not allowed.");
  }
  const match = MANAGEMENT.exec(withoutStrings);
  if (match) {
    const command = match[0].replace(/^[|;]+/, "").trim();
    throw new ValidationError(`Management command '${command}' is not allowed in queries for security reasons.`);
  }
}

/** Port of KqlSanitizer.EscapeIdentifier: ['name'] with doubled quotes. */
export function escapeIdentifier(identifier) {
  return `['${String(identifier).replaceAll("'", "''")}']`;
}

const WHITESPACE_MESSAGE = "The value cannot be an empty string or composed entirely of whitespace.";

/** Port of KustoService.EscapeKqlIdentifier: strip existing brackets, then escape. */
export function escapeKqlIdentifier(identifier) {
  if (typeof identifier !== "string" || !identifier.trim()) throw new ArgumentError(WHITESPACE_MESSAGE, "identifier");
  const unescaped = identifier.replaceAll("['", "").replaceAll('["', "").replaceAll('"]', "").replaceAll("']", "");
  if (!unescaped.trim()) throw new ArgumentError("Identifier is empty after removing escape characters.", "identifier");
  return escapeIdentifier(unescaped);
}

/** Port of BaseAzureService.EscapeKqlString, for single-quoted Resource Graph strings. */
export function escapeKqlString(value) {
  if (!value) return "";
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "''");
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_ .-]*$/;
const IDENTIFIER_BAD = /[|;(){}[\]<>'"`/\\\n\r]/;

/** Port of KustoIdentifierValidator.ValidateIdentifier. */
export function validateIdentifier(identifier, parameterName) {
  if (typeof identifier !== "string" || !identifier.trim()) throw new ValidationError(`${parameterName} cannot be empty.`);
  if (identifier.length > 1024) throw new ValidationError(`${parameterName} length exceeds maximum of 1024 characters.`);
  if (IDENTIFIER_BAD.test(identifier)) {
    throw new ValidationError(`${parameterName} contains invalid characters. Only letters, digits, underscores, spaces, hyphens, and periods are allowed.`);
  }
  if (!IDENTIFIER.test(identifier)) {
    throw new ValidationError(`${parameterName} is not a valid Kusto identifier. Must start with a letter or underscore and contain only letters, digits, underscores, spaces, hyphens, and periods.`);
  }
}

/**
 * Port of KqlSanitizer.SanitizeStringLiterals. Re-encodes single-quoted
 * literals and leaves double-quoted, verbatim (@), obfuscated (h), and comment
 * text untouched.
 */
export function sanitizeStringLiterals(query) {
  let out = "";
  let i = 0;
  const skipQuoted = (quote) => {
    while (i < query.length) {
      out += query[i];
      if (query[i] === quote) {
        i++;
        if (i < query.length && query[i] === quote) {
          out += query[i];
          i++;
        } else {
          break;
        }
      } else {
        i++;
      }
    }
  };
  while (i < query.length) {
    const c = query[i];
    const n = query[i + 1];
    if ((c === "h" || c === "H") && (n === "'" || n === '"' || n === "@")) {
      if (n === "@" && (query[i + 2] === "'" || query[i + 2] === '"')) {
        const quote = query[i + 2];
        out += c + n + quote;
        i += 3;
        skipQuoted(quote);
      } else if (n === "'" || n === '"') {
        out += c + n;
        i += 2;
        skipQuoted(n);
      } else {
        out += c;
        i++;
      }
    } else if (c === "@" && (n === "'" || n === '"')) {
      out += c + n;
      i += 2;
      skipQuoted(n);
    } else if (c === '"') {
      out += c;
      i++;
      skipQuoted('"');
    } else if (c === "/" && n === "/") {
      while (i < query.length && query[i] !== "\n") out += query[i++];
    } else if (c === "'") {
      let value = "";
      i++;
      while (i < query.length) {
        if (query[i] === "'" && query[i + 1] === "'") {
          value += "'";
          i += 2;
        } else if (query[i] === "'") {
          i++;
          break;
        } else {
          value += query[i++];
        }
      }
      out += `'${value.replaceAll("'", "''")}'`;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const IDENT_CHAR = /[A-Za-z0-9_]/;

/**
 * Single-pass KQL lexer that blanks out string literals and drops comments, so
 * structural checks see only code. Handles '...' and "..." (backslash escapes),
 * @'...' and @"..." (doubled-quote escapes), the h/H obfuscation prefix,
 * ```...``` multi-line strings, and // comments. An unterminated literal
 * swallows the rest of the text, which can only hide code from Kusto too.
 */
export function scanKql(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  const readQuoted = (quote, verbatim) => {
    while (i < n) {
      const c = text[i];
      if (!verbatim && c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) {
        if (verbatim && text[i + 1] === quote) {
          i += 2;
          continue;
        }
        i++;
        return;
      }
      i++;
    }
  };
  while (i < n) {
    const c = text[i];
    const prevIdent = i > 0 && IDENT_CHAR.test(text[i - 1]);
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "`" && text.startsWith("```", i)) {
      const end = text.indexOf("```", i + 3);
      i = end < 0 ? n : end + 3;
      out += "''";
      continue;
    }
    let j = i;
    if (!prevIdent && (c === "h" || c === "H") && (text[i + 1] === "'" || text[i + 1] === '"' || (text[i + 1] === "@" && (text[i + 2] === "'" || text[i + 2] === '"')))) j++;
    let verbatim = false;
    if (text[j] === "@" && (text[j + 1] === "'" || text[j + 1] === '"') && (j > i || !prevIdent)) {
      verbatim = true;
      j++;
    }
    if (text[j] === "'" || text[j] === '"') {
      const quote = text[j];
      i = j + 1;
      readQuoted(quote, verbatim);
      out += "''";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// The dot-word an ANY_CONTROL match points at, such as ".drop" or ".set-or-append".
const controlWord = (text, match) => /\.[A-Za-z][\w-]*/.exec(text.slice(match.index))?.[0] ?? match[0].trim();

/** Strip leading whitespace and // comment lines. */
export function stripLeadingComments(text) {
  let rest = String(text);
  for (;;) {
    const trimmed = rest.replace(/^\s+/, "");
    if (trimmed.startsWith("//")) {
      const end = trimmed.indexOf("\n");
      rest = end < 0 ? "" : trimmed.slice(end + 1);
    } else {
      return trimmed;
    }
  }
}

/**
 * A read-only management command: one `.show` command, optionally piped into
 * query operators. Refuses a second statement and any other control command.
 */
export function validateShowCommand(command, maxLength = MAX_QUERY_LENGTH) {
  if (typeof command !== "string" || !command.trim()) throw new ValidationError("Command cannot be empty.");
  if (command.length > maxLength) {
    throw new ValidationError(`Command length exceeds the maximum allowed limit of ${maxLength.toLocaleString("en-US")} characters.`);
  }
  const body = stripLeadingComments(command);
  if (!/^\.show(?![\w-])/i.test(body)) {
    throw new ValidationError("Only .show management commands are allowed by kusto_command. Use kusto_command_write for other control commands.");
  }
  const code = scanKql(body);
  if (code.includes(";")) throw new ValidationError("Only one management command is allowed per call.");
  const rest = code.replace(/^\.show(?![\w-])/i, "");
  for (const match of rest.matchAll(ANY_CONTROL)) {
    const found = controlWord(rest, match);
    throw new ValidationError(`Management command '${found}' is not allowed by kusto_command.`);
  }
  return body;
}

/**
 * kusto_query_v2 check: azure-mcp's validator, then a lexer-based check that
 * no control command hides behind a string or comment trick.
 */
export function validateV2Query(query, maxLength) {
  validateQuerySafety(query, maxLength);
  const code = scanKql(query);
  for (const match of code.matchAll(ANY_CONTROL)) {
    const found = controlWord(code, match);
    if (!/^\.show$/i.test(found)) throw new ValidationError(`Management command '${found}' is not allowed in queries for security reasons.`);
  }
}
