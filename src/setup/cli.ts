/** Small, strict flag reader shared by `setup` and `doctor`. */

export type FlagSpec = {
  readonly name: string;
  readonly takesValue: boolean;
};

export type ParsedArguments = {
  readonly values: ReadonlyMap<string, string>;
  readonly present: ReadonlySet<string>;
  readonly errors: readonly string[];
};

export function parseArguments(
  arguments_: readonly string[],
  specs: readonly FlagSpec[],
): ParsedArguments {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const values = new Map<string, string>();
  const present = new Set<string>();
  const errors: string[] = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? '';
    if (!argument.startsWith('--')) {
      errors.push(`Unexpected argument: ${argument}`);
      continue;
    }
    const equalsIndex = argument.indexOf('=');
    const name = equalsIndex >= 0 ? argument.slice(2, equalsIndex) : argument.slice(2);
    const inlineValue = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : null;
    const spec = byName.get(name);
    if (spec === undefined) {
      errors.push(`Unknown option: --${name}`);
      continue;
    }
    present.add(name);
    if (!spec.takesValue) {
      if (inlineValue !== null) {
        errors.push(`--${name} does not take a value`);
      }
      continue;
    }
    if (inlineValue !== null) {
      values.set(name, inlineValue);
      continue;
    }
    const next = arguments_[index + 1];
    if (next === undefined || next.startsWith('--')) {
      errors.push(`--${name} needs a value`);
      continue;
    }
    values.set(name, next);
    index += 1;
  }

  return { values, present, errors };
}

/**
 * A whole number or nothing. "8790abc", "", "-5", and "1e3" are all rejected,
 * because a port that half-parses is a port that quietly means something else.
 */
export function parseStrictInteger(text: string | undefined): number | null {
  if (text === undefined) {
    return null;
  }
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}
