// Amounts are decimal strings in the asset's units, as the API sends and takes them. These
// helpers convert and compare them without floating point.

const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

function parts(amount: string, name: string): [string, string] {
  const match = typeof amount === "string" ? DECIMAL.exec(amount) : null;
  if (!match) throw new TypeError(`${name} must be a decimal string, such as "12.5"`);
  return [match[1] as string, match[2] ?? ""];
}

function checkDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new TypeError("decimals must be the asset's decimals, a whole number from 0 to 255");
  }
}

/**
 * An amount in the asset's smallest units: `toUnits("1.5", 6)` is `1500000n`. An asset's
 * decimals come from `assets.list()`. An amount more precise than that is refused.
 */
function toUnits(amount: string, decimals: number): bigint {
  checkDecimals(decimals);
  const [whole, fraction] = parts(amount, "amount");
  if (/[1-9]/.test(fraction.slice(decimals))) {
    throw new RangeError(`${amount} has more decimals than the asset's ${decimals}`);
  }
  return BigInt(whole + fraction.slice(0, decimals).padEnd(decimals, "0"));
}

/** An amount of smallest units, in the API's canonical form: `fromUnits(1500000n, 6)` is `"1.5"`. */
function fromUnits(units: bigint | number | string, decimals: number): string {
  checkDecimals(decimals);
  let n: bigint;
  if (typeof units === "bigint") n = units;
  else if (typeof units === "number" && Number.isSafeInteger(units)) n = BigInt(units);
  else if (typeof units === "string" && /^[0-9]+$/.test(units)) n = BigInt(units);
  else throw new TypeError("units must be a whole number: a bigint, a safe integer or digits");
  if (n < 0n) throw new RangeError("units can't be negative");
  const digits = n.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Compares two amounts: -1 when a is less than b, 0 when they're equal, 1 when it's more. */
function compare(a: string, b: string): -1 | 0 | 1 {
  const [aWhole, aFraction] = parts(a, "a");
  const [bWhole, bFraction] = parts(b, "b");
  if (aWhole.length !== bWhole.length) return aWhole.length < bWhole.length ? -1 : 1;
  if (aWhole !== bWhole) return aWhole < bWhole ? -1 : 1;
  const length = Math.max(aFraction.length, bFraction.length);
  const x = aFraction.padEnd(length, "0");
  const y = bFraction.padEnd(length, "0");
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

/** Amount helpers, exact for any amount: no floating point. */
export const Amounts = Object.freeze({ toUnits, fromUnits, compare });
