/**
 * A small JSON Schema subset — enough to describe and validate tool inputs.
 *
 * Tool arguments arrive from an untrusted planner, so validation happens before
 * `resolve()` ever sees them. We keep our own validator (rather than zod/ajv) so
 * the exact schema object we validate against is byte-identical to the one we
 * send to the provider; a mismatch between "what the model was told" and "what
 * we enforce" is a real source of tool-call failures.
 */

export type JsonSchema =
  | {
      type: 'string';
      description?: string;
      enum?: readonly string[];
      minLength?: number;
      maxLength?: number;
      pattern?: string;
    }
  | { type: 'number' | 'integer'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'null'; description?: string }
  | { type: 'array'; description?: string; items: JsonSchema; minItems?: number; maxItems?: number }
  | {
      type: 'object';
      description?: string;
      properties: Record<string, JsonSchema>;
      required?: readonly string[];
      additionalProperties?: boolean;
    }
  | { anyOf: readonly JsonSchema[]; description?: string }
  | { const: string | number | boolean | null; description?: string };

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  issues: ValidationIssue[];
}

export function validate<T = unknown>(schema: JsonSchema, value: unknown): ValidationResult<T> {
  const issues: ValidationIssue[] = [];
  walk(schema, value, '$', issues);
  return issues.length === 0 ? { ok: true, value: value as T, issues } : { ok: false, issues };
}

function walk(schema: JsonSchema, value: unknown, at: string, issues: ValidationIssue[]): void {
  if ('anyOf' in schema) {
    for (const alt of schema.anyOf) {
      const sub: ValidationIssue[] = [];
      walk(alt, value, at, sub);
      if (sub.length === 0) return;
    }
    issues.push({ path: at, message: 'does not match any allowed variant' });
    return;
  }

  if ('const' in schema) {
    if (value !== schema.const) {
      issues.push({ path: at, message: `must equal ${JSON.stringify(schema.const)}` });
    }
    return;
  }

  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return void issues.push({ path: at, message: 'must be a string' });
      if (schema.enum && !schema.enum.includes(value)) {
        issues.push({ path: at, message: `must be one of: ${schema.enum.join(', ')}` });
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        issues.push({ path: at, message: `must be at least ${schema.minLength} characters` });
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        issues.push({ path: at, message: `must be at most ${schema.maxLength} characters` });
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
        issues.push({ path: at, message: `must match /${schema.pattern}/` });
      }
      return;
    }

    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return void issues.push({ path: at, message: 'must be a number' });
      }
      if (schema.type === 'integer' && !Number.isInteger(value)) {
        issues.push({ path: at, message: 'must be an integer' });
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        issues.push({ path: at, message: `must be >= ${schema.minimum}` });
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        issues.push({ path: at, message: `must be <= ${schema.maximum}` });
      }
      return;
    }

    case 'boolean':
      if (typeof value !== 'boolean') issues.push({ path: at, message: 'must be a boolean' });
      return;

    case 'null':
      if (value !== null) issues.push({ path: at, message: 'must be null' });
      return;

    case 'array': {
      if (!Array.isArray(value)) return void issues.push({ path: at, message: 'must be an array' });
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        issues.push({ path: at, message: `must have at least ${schema.minItems} items` });
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        issues.push({ path: at, message: `must have at most ${schema.maxItems} items` });
      }
      value.forEach((item, i) => walk(schema.items, item, `${at}[${i}]`, issues));
      return;
    }

    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return void issues.push({ path: at, message: 'must be an object' });
      }
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in obj) || obj[key] === undefined) {
          issues.push({ path: `${at}.${key}`, message: 'is required' });
        }
      }
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in obj && obj[key] !== undefined) walk(sub, obj[key], `${at}.${key}`, issues);
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in schema.properties)) {
            issues.push({ path: `${at}.${key}`, message: 'is not an allowed property' });
          }
        }
      }
      return;
    }

    default:
      issues.push({ path: at, message: 'unsupported schema' });
  }
}

export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((i) => `${i.path} ${i.message}`).join('; ');
}
