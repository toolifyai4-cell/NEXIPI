/**
 * Safe, linear-time regular expression engine for NexiPi code search.
 *
 * JavaScript `RegExp` execution is synchronous and cannot be reliably
 * interrupted, so unrestricted model-supplied patterns are never executed.
 * Instead this module compiles a deliberately restricted, regular-language
 * subset to a Thompson NFA and simulates it in O(input * pattern) time with
 * no backtracking. Catastrophic backtracking is therefore impossible by
 * construction.
 *
 * Supported syntax:
 *   - literal characters, escaped with `\` (e.g. `\.`, `\*`, `\\`)
 *   `.`                any character except line breaks
 *   `[abc]`, `[^abc]`, `[a-z]`, `[0-9]` character classes and ranges
 *   `^`                start of line (only valid at the start of the pattern)
 *   `$`                end of line (only valid at the end of the pattern)
 *   `*`, `+`, `?`      repetition (unbounded `*`/`+` are O(1) NFA states)
 *   `{n}`, `{n,}`, `{n,m}` bounded repetition (m is capped)
 *   `( ... )`, `(?: ... )` grouping
 *   `|` alternation
 *   `\d`, `\D`, `\w`, `\W`, `\s`, `\S` shorthand classes
 *   `\b`, `\B` word-boundary assertions
 *
 * Rejected (throws): nested/lazy quantifiers, lookarounds, backreferences,
 * named groups, Unicode property escapes, `\A`/`\Z`/`\z`/`\G`, `^`/`$` inside
 * alternations, over-long patterns, and over-large bounded repetitions.
 */

const MAX_PATTERN_LENGTH = 512;
const MAX_REPEAT_COUNT = 256;
const MAX_NFA_STATES = 8000;

type NFAStateKind =
  | 'split'
  | 'char'
  | 'match'
  | 'anchorStart'
  | 'anchorEnd'
  | 'wordBoundary'
  | 'nonWordBoundary';

interface NFAState {
  readonly kind: NFAStateKind;
  readonly out1: number | null;
  readonly out2: number | null;
  readonly pred: ((ch: string) => boolean) | null;
}

interface Frag {
  readonly start: number;
  readonly outs: Array<{ state: number; slot: 0 | 1 }>;
}

interface RegExpNode {
  readonly type:
    | 'empty'
    | 'char'
    | 'any'
    | 'class'
    | 'shorthand'
    | 'concat'
    | 'alt'
    | 'repeat'
    | 'anchor'
    | 'wordBoundary';
  readonly ch?: string;
  readonly negated?: boolean;
  readonly ranges?: ReadonlyArray<{ readonly lo: string; readonly hi: string }>;
  readonly kind?: 'digit' | 'nonDigit' | 'word' | 'nonWord' | 'space' | 'nonSpace' | 'start' | 'end' | 'boundary' | 'nonBoundary';
  readonly parts?: ReadonlyArray<RegExpNode>;
  readonly child?: RegExpNode;
  readonly min?: number;
  readonly max?: number | null;
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function shorthandPred(kind: string, caseSensitive: boolean): (ch: string) => boolean {
  switch (kind) {
    case 'digit':
      return (c) => /[0-9]/.test(c);
    case 'nonDigit':
      return (c) => !/[0-9]/.test(c);
    case 'word':
      return isWordChar;
    case 'nonWord':
      return (c) => !isWordChar(c);
    case 'space':
      return (c) => /[\s]/.test(c);
    case 'nonSpace':
      return (c) => !/[\s]/.test(c);
    default:
      return () => true;
  }
}

function charPred(node: RegExpNode, caseSensitive: boolean): (ch: string) => boolean {
  const ch = node.ch!;
  if (!caseSensitive) {
    const lower = ch.toLowerCase();
    return (c) => c.toLowerCase() === lower;
  }
  return (c) => c === ch;
}

function classPred(node: RegExpNode, caseSensitive: boolean): (ch: string) => boolean {
  const ranges = node.ranges!;
  const negated = node.negated!;
  const test = (c: string): boolean => {
    for (const r of ranges) {
      if (c >= r.lo && c <= r.hi) {
        return true;
      }
    }
    return false;
  };
  if (!caseSensitive) {
    return (c) => (test(c) || test(c.toLowerCase()) || test(c.toUpperCase())) !== negated;
  }
  return (c) => test(c) !== negated;
}

function anyPred(): (ch: string) => boolean {
  return (c) => c !== '\n' && c !== '\r';
}

/**
 * Builds a Thompson NFA fragment using dangling pointer patching.
 */
class NFABuilder {
  private readonly states: NFAState[] = [];
  private readonly caseSensitive: boolean;

  constructor(caseSensitive: boolean) {
    this.caseSensitive = caseSensitive;
  }

  private state(kind: NFAStateKind, pred: ((ch: string) => boolean) | null = null): number {
    if (this.states.length >= MAX_NFA_STATES) {
      throw new Error('NFA state budget exceeded');
    }
    this.states.push({ kind, out1: null, out2: null, pred });
    return this.states.length - 1;
  }

  private patch(outs: Array<{ state: number; slot: 0 | 1 }>, target: number): void {
    for (const { state, slot } of outs) {
      const s = this.states[state];
      if (slot === 0) {
        s.out1 = target;
      } else {
        s.out2 = target;
      }
    }
  }

  private append(
    a: Array<{ state: number; slot: 0 | 1 }>,
    b: Array<{ state: number; slot: 0 | 1 }>
  ): Array<{ state: number; slot: 0 | 1 }> {
    return [...a, ...b];
  }

  private charNode(node: RegExpNode): Frag {
    const s = this.state('char', charPred(node, this.caseSensitive));
    return { start: s, outs: [{ state: s, slot: 0 }] };
  }

  private anyNode(): Frag {
    const s = this.state('char', anyPred());
    return { start: s, outs: [{ state: s, slot: 0 }] };
  }

  private classNode(node: RegExpNode): Frag {
    const s = this.state('char', classPred(node, this.caseSensitive));
    return { start: s, outs: [{ state: s, slot: 0 }] };
  }

  private shorthandNode(node: RegExpNode): Frag {
    const s = this.state('char', shorthandPred(node.kind!, this.caseSensitive));
    return { start: s, outs: [{ state: s, slot: 0 }] };
  }

  private emptyNode(): Frag {
    const s = this.state('split');
    return { start: s, outs: [{ state: s, slot: 0 }, { state: s, slot: 1 }] };
  }

  private anchorNode(kind: 'start' | 'end'): Frag {
    const s = this.state(kind === 'start' ? 'anchorStart' : 'anchorEnd');
    return { start: s, outs: [{ state: s, slot: 0 }] };
  }

  private wordBoundaryNode(kind: 'boundary' | 'nonBoundary'): Frag {
    const s = this.state(kind === 'boundary' ? 'wordBoundary' : 'nonWordBoundary');
    return { start: s, outs: [{ state: s, slot: 0 }] };
  }

  private concat(f1: Frag, f2: Frag): Frag {
    this.patch(f1.outs, f2.start);
    return { start: f1.start, outs: f2.outs };
  }

  private alt(parts: Frag[]): Frag {
    if (parts.length === 1) {
      return parts[0];
    }
    // Build a right-leaning chain of splits.
    let frag = parts[parts.length - 1];
    for (let i = parts.length - 2; i >= 0; i--) {
      const s = this.state('split');
      s.out1 = parts[i].start;
      s.out2 = frag.start;
      frag = { start: s, outs: this.append(parts[i].outs, [{ state: s, slot: 1 }]) };
    }
    return frag;
  }

  private repeat(child: Frag, min: number, max: number | null): Frag {
    if (max === null) {
      if (min === 0) {
        // star
        const s = this.state('split');
        this.patch(child.outs, s);
        s.out1 = child.start;
        s.out2 = null; // dangling
        return { start: s, outs: [{ state: s, slot: 1 }] };
      }
      if (min === 1) {
        // plus
        this.patch(child.outs, child.start);
        const s = this.state('split');
        s.out1 = child.start;
        s.out2 = null; // dangling
        this.patch(child.outs, s);
        return { start: child.start, outs: [{ state: s, slot: 1 }] };
      }
      // min >= 2, unbounded upper: min copies then star
      let frag: Frag | null = null;
      for (let i = 0; i < min; i++) {
        frag = frag === null ? child : this.concat(frag, child);
      }
      const star = this.repeat(child, 0, null);
      return frag === null ? star : this.concat(frag, star);
    }
    // bounded {n, m}
    if (max > MAX_REPEAT_COUNT) {
      throw new Error(`bounded repetition exceeds maximum of ${MAX_REPEAT_COUNT}`);
    }
    let frag: Frag | null = null;
    for (let i = 0; i < min; i++) {
      frag = frag === null ? child : this.concat(frag, child);
    }
    const optional = max - min;
    for (let i = 0; i < optional; i++) {
      const s = this.state('split');
      s.out1 = child.start;
      s.out2 = null; // dangling
      const opt: Frag = { start: s, outs: [{ state: s, slot: 1 }] };
      const childCopy = this.duplicate(child);
      frag = frag === null ? this.concat(opt, childCopy) : this.concat(frag, this.concat(opt, childCopy));
    }
    return frag === null ? this.emptyNode() : frag;
  }

  /**
   * Duplicates a fragment by rebuilding its states (shares the same structure
   * with fresh state indices) so bounded repetitions can stack copies safely.
   */
  private duplicate(frag: Frag): Frag {
    const map = new Map<number, number>();
    const copyState = (kind: NFAStateKind, pred: ((ch: string) => boolean) | null): number => {
      const s = this.state(kind, pred);
      return s;
    };
    // We cannot easily clone arbitrary frags without tracking all states.
    // Instead, rebuild by re-emitting: this is used only for bounded repeats
    // of simple atoms, so we re-derive from the child node is not possible here.
    // To keep correctness simple, duplicate by re-running the same fragment
    // construction is not available; instead we copy the reachable states.
    return cloneFrag(this, frag, map);
  }

  getStates(): NFAState[] {
    return this.states;
  }
}

/**
 * Clones a fragment's reachable states into fresh indices, patching dangling
 * outs to remain dangling. Used for bounded-repeat copies.
 */
function cloneFrag(
  builder: NFABuilder,
  frag: Frag,
  map: Map<number, number>
): Frag {
  const cloneState = (st: number): number => {
    const existing = map.get(st);
    if (existing !== undefined) {
      return existing;
    }
    const src = builder.getStates()[st];
    const clone = builder.state(src.kind, src.pred);
    map.set(st, clone);
    return clone;
  };
  const start = cloneState(frag.start);
  // Resolve all reachable states to clone their out edges.
  const resolved = new Set<number>();
  const stack: number[] = [frag.start];
  while (stack.length) {
    const st = stack.pop()!;
    if (resolved.has(st)) continue;
    resolved.add(st);
    const clone = map.get(st)!;
    const src = builder.getStates()[st];
    if (src.kind === 'split') {
      const c1 = cloneState(src.out1!);
      const c2 = cloneState(src.out2!);
      builder.getStates()[clone].out1 = c1;
      builder.getStates()[clone].out2 = c2;
      stack.push(src.out1!, src.out2!);
    } else if (src.kind === 'char') {
      const c1 = cloneState(src.out1!);
      builder.getStates()[clone].out1 = c1;
      stack.push(src.out1!);
    } else if (src.kind === 'anchorStart' || src.kind === 'anchorEnd') {
      const c1 = cloneState(src.out1!);
      builder.getStates()[clone].out1 = c1;
      stack.push(src.out1!);
    } else if (src.kind === 'wordBoundary' || src.kind === 'nonWordBoundary') {
      const c1 = cloneState(src.out1!);
      builder.getStates()[clone].out1 = c1;
      stack.push(src.out1!);
    }
    // match state has no outs.
  }
  const outs: Array<{ state: number; slot: 0 | 1 }> = [];
  for (const { state, slot } of frag.outs) {
    outs.push({ state: map.get(state)!, slot });
  }
  return { start, outs };
}

export interface CompiledRegex {
  readonly states: NFAState[];
  readonly start: number;
  readonly accept: number;
  readonly anchoredStart: boolean;
  readonly anchoredEnd: boolean;
}

interface ParseResult {
  readonly node: RegExpNode;
  readonly anchoredStart: boolean;
  readonly anchoredEnd: boolean;
}

/**
 * Parses a restricted regex pattern into an AST. Throws on unsupported or
 * dangerous constructs.
 */
function parsePattern(pattern: string): ParseResult {
  const len = pattern.length;
  let i = 0;

  function peek(): string {
    return i < len ? pattern[i]! : '';
  }

  function next(): string {
    return pattern[i++]!;
  }

  function expect(ch: string): void {
    if (i >= len || pattern[i]! !== ch) {
      throw new Error(`expected '${ch}'`);
    }
    i++;
  }

  function parseAlt(): RegExpNode {
    const parts: RegExpNode[] = [parseConcat()];
    while (i < len && peek() === '|') {
      i++;
      parts.push(parseConcat());
    }
    return parts.length === 1 ? parts[0]! : { type: 'alt', parts };
  }

  function parseConcat(): RegExpNode {
    const parts: RegExpNode[] = [];
    while (i < len) {
      const ch = peek();
      if (ch === '|' || ch === ')') {
        break;
      }
      parts.push(parseRepeat(parseAtom()));
    }
    if (parts.length === 0) {
      return { type: 'empty' };
    }
    if (parts.length === 1) {
      return parts[0]!;
    }
    return { type: 'concat', parts };
  }

  function parseRepeat(node: RegExpNode): RegExpNode {
    // Reject lazy quantifiers.
    if (i < len) {
      const ch = peek();
      if ((ch === '*' || ch === '+' || ch === '?') && i + 1 < len && pattern[i + 1] === '?') {
        throw new Error('lazy quantifiers are not supported');
      }
    }
    if (i >= len) {
      return node;
    }
    const ch = peek();
    if (ch === '*') {
      i++;
      return { type: 'repeat', child: node, min: 0, max: null };
    }
    if (ch === '+') {
      i++;
      return { type: 'repeat', child: node, min: 1, max: null };
    }
    if (ch === '?') {
      i++;
      return { type: 'repeat', child: node, min: 0, max: 1 };
    }
    if (ch === '{') {
      i++;
      let n = 0;
      while (i < len && /[0-9]/.test(peek())) {
        n = n * 10 + Number(peek());
        i++;
      }
      if (i >= len || peek() !== ',') {
        // {n}
        expect('}');
        return { type: 'repeat', child: node, min: n, max: n };
      }
      i++; // skip ','
      let m: number | null = null;
      if (i < len && /[0-9]/.test(peek())) {
        m = 0;
        while (i < len && /[0-9]/.test(peek())) {
          m = m * 10 + Number(peek());
          i++;
        }
      }
      // reject lazy {..}?
      if (i < len && peek() === '?') {
        throw new Error('lazy quantifiers are not supported');
      }
      expect('}');
      if (m === null) {
        return { type: 'repeat', child: node, min: n, max: null };
      }
      return { type: 'repeat', child: node, min: n, max: m };
    }
    return node;
  }

  function parseAtom(): RegExpNode {
    if (i >= len) {
      throw new Error('unexpected end of pattern');
    }
    const ch = peek();

    if (ch === '(') {
      i++;
      if (i < len && peek() === '?') {
        i++;
        if (i < len && peek() === '<') {
          throw new Error('named groups are not supported');
        }
        if (i < len && (peek() === '=' || peek() === '!' || peek() === '<' || peek() === '>')) {
          throw new Error('lookarounds are not supported');
        }
        if (i < len && peek() === ':') {
          i++; // (?: non-capturing group
          const inner = parseAlt();
          expect(')');
          return inner;
        }
        throw new Error('unsupported group syntax');
      }
      const inner = parseAlt();
      expect(')');
      return inner;
    }

    if (ch === '[') {
      i++;
      let negated = false;
      if (i < len && peek() === '^') {
        negated = true;
        i++;
      }
      const ranges: { lo: string; hi: string }[] = [];
      while (i < len && peek() !== ']') {
        let first = next();
        if (first === '\\') {
          first = next();
        }
        let lo = first;
        let hi = lo;
        if (i < len && peek() === '-' && i + 1 < len && pattern[i + 1] !== ']') {
          i++;
          hi = next();
          if (hi === '\\') {
            hi = next();
          }
        }
        ranges.push({ lo, hi });
      }
      if (i >= len) {
        throw new Error('unterminated character class');
      }
      i++; // skip ']'
      return { type: 'class', ranges, negated };
    }

    if (ch === '.') {
      i++;
      return { type: 'any' };
    }

    if (ch === '^' || ch === '$') {
      i++;
      return { type: 'anchor', kind: ch === '^' ? 'start' : 'end' };
    }

    if (ch === '\\') {
      i++;
      if (i >= len) {
        throw new Error('trailing backslash');
      }
      const esc = next();
      switch (esc) {
        case 'd':
          return { type: 'shorthand', kind: 'digit' };
        case 'D':
          return { type: 'shorthand', kind: 'nonDigit' };
        case 'w':
          return { type: 'shorthand', kind: 'word' };
        case 'W':
          return { type: 'shorthand', kind: 'nonWord' };
        case 's':
          return { type: 'shorthand', kind: 'space' };
        case 'S':
          return { type: 'shorthand', kind: 'nonSpace' };
        case 'b':
          return { type: 'wordBoundary', kind: 'boundary' };
        case 'B':
          return { type: 'wordBoundary', kind: 'nonBoundary' };
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
        case '7':
        case '8':
        case '9':
          throw new Error('backreferences are not supported');
        case 'p':
        case 'P':
          throw new Error('Unicode property escapes are not supported');
        case 'A':
        case 'Z':
        case 'z':
        case 'G':
          throw new Error(`anchor '\\${esc}' is not supported`);
        default:
          return { type: 'char', ch: esc };
      }
    }

    if (ch === '*' || ch === '+' || ch === '?' || ch === '{' || ch === '}' || ch === ')') {
      throw new Error(`unexpected '${ch}'`);
    }

    i++;
    return { type: 'char', ch };
  }

  const alt = parseAlt();
  if (i !== len) {
    throw new Error(`unexpected '${peek()}'`);
  }

  // Anchors are only honored at the very start/end of a single-concat pattern
  // with no alternation. Reject them inside alternations.
  let anchoredStart = false;
  let anchoredEnd = false;
  let node: RegExpNode = alt;
  if (node.type !== 'alt') {
    const walk = (n: RegExpNode): RegExpNode | null => {
      if (n.type === 'concat' && n.parts && n.parts.length > 0) {
        const first = n.parts[0]!;
        if (first.type === 'anchor' && first.kind === 'start') {
          anchoredStart = true;
          const rest = n.parts.slice(1);
          return rest.length === 0 ? { type: 'empty' } : rest.length === 1 ? rest[0]! : { type: 'concat', parts: rest };
        }
      }
      return n;
    };
    node = walk(node) ?? node;
    const walkEnd = (n: RegExpNode): RegExpNode | null => {
      if (n.type === 'concat' && n.parts && n.parts.length > 0) {
        const last = n.parts[n.parts.length - 1]!;
        if (last.type === 'anchor' && last.kind === 'end') {
          anchoredEnd = true;
          const rest = n.parts.slice(0, -1);
          return rest.length === 0 ? { type: 'empty' } : rest.length === 1 ? rest[0]! : { type: 'concat', parts: rest };
        }
      }
      return n;
    };
    node = walkEnd(node) ?? node;
  } else if (anchorsPresent(alt)) {
    throw new Error('anchors are not supported inside alternations');
  }

  return { node, anchoredStart, anchoredEnd };
}

function anchorsPresent(node: RegExpNode): boolean {
  if (node.type === 'anchor') {
    return true;
  }
  if (node.type === 'concat' && node.parts) {
    return node.parts.some(anchorsPresent);
  }
  if (node.type === 'alt' && node.parts) {
    return node.parts.some(anchorsPresent);
  }
  if (node.type === 'repeat' && node.child) {
    return anchorsPresent(node.child);
  }
  return false;
}

/**
 * Compiles a restricted regex pattern into a Thompson NFA.
 *
 * Throws on syntax errors or unsupported/dangerous constructs. The resulting
 * NFA simulates in linear time with no backtracking.
 */
export function compileRestrictedRegex(
  pattern: string,
  caseSensitive: boolean
): CompiledRegex {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`pattern exceeds maximum length of ${MAX_PATTERN_LENGTH}`);
  }
  const parsed = parsePattern(pattern);
  const builder = new NFABuilder(caseSensitive);

  const compile = (node: RegExpNode): Frag => {
    switch (node.type) {
      case 'empty':
        return builder.emptyNode();
      case 'char':
        return builder.charNode(node);
      case 'any':
        return builder.anyNode();
      case 'class':
        return builder.classNode(node);
      case 'shorthand':
        return builder.shorthandNode(node);
      case 'concat':
        return (node.parts as RegExpNode[]).reduce<Frag | null>(
          (acc, part) => (acc === null ? compile(part) : builder.concat(acc, compile(part))),
          null
        )!;
      case 'alt':
        return builder.alt((node.parts as RegExpNode[]).map(compile));
      case 'repeat': {
        const child = compile(node.child!);
        return builder.repeat(child, node.min!, node.max ?? null);
      }
      case 'anchor':
        return builder.anchorNode(node.kind as 'start' | 'end');
      case 'wordBoundary':
        return builder.wordBoundaryNode(node.kind as 'boundary' | 'nonBoundary');
      default:
        throw new Error('unsupported pattern node');
    }
  };

  const frag = compile(parsed.node);
  const accept = builder.state('match');
  builder.patch(frag.outs, accept);

  return {
    states: builder.getStates(),
    start: frag.start,
    accept,
    anchoredStart: parsed.anchoredStart,
    anchoredEnd: parsed.anchoredEnd,
  };
}

/**
 * Word-boundary assertion at a position within `input`.
 */
function wordBoundaryAt(input: string, pos: number, n: number): boolean {
  const prev = pos === 0 ? false : isWordChar(input[pos - 1]);
  const next = pos === n ? false : isWordChar(input[pos]);
  return prev !== next;
}

function nonWordBoundaryAt(input: string, pos: number, n: number): boolean {
  return !wordBoundaryAt(input, pos, n);
}

/**
 * Epsilon closure at a given input position. Anchor/boundary states are
 * position-aware zero-width assertions.
 */
function closure(
  states: NFAState[],
  current: Map<number, number>,
  input: string,
  pos: number,
  n: number
): Map<number, number> {
  const result = new Map<number, number>();
  const stack: [number, number][] = [...current.entries()];
  const visited = new Set<number>();
  while (stack.length) {
    const [st, startIdx] = stack.pop()!;
    if (visited.has(st)) continue;
    visited.add(st);
    const existing = result.get(st);
    if (existing === undefined || startIdx < existing) {
      result.set(st, startIdx);
    }
    const s = states[st];
    if (s.kind === 'split') {
      stack.push([s.out1!, startIdx]);
      stack.push([s.out2!, startIdx]);
    } else if (s.kind === 'anchorStart') {
      if (pos === 0) {
        stack.push([s.out1!, startIdx]);
      }
    } else if (s.kind === 'anchorEnd') {
      if (pos === n) {
        stack.push([s.out1!, startIdx]);
      }
    } else if (s.kind === 'wordBoundary') {
      if (wordBoundaryAt(input, pos, n)) {
        stack.push([s.out1!, startIdx]);
      }
    } else if (s.kind === 'nonWordBoundary') {
      if (nonWordBoundaryAt(input, pos, n)) {
        stack.push([s.out1!, startIdx]);
      }
    }
    // char and match states have no epsilon outs.
  }
  return result;
}

function addMatch(map: Map<number, number>, state: number, startIdx: number): void {
  const existing = map.get(state);
  if (existing === undefined || startIdx < existing) {
    map.set(state, startIdx);
  }
}

/**
 * Finds the first match at or after `fromPos`. Returns null when none exists.
 * Matches are leftmost-first; zero-length matches are skipped by the caller.
 */
export function findFirstMatch(
  input: string,
  compiled: CompiledRegex,
  fromPos: number
): { start: number; end: number } | null {
  const { states, start, accept, anchoredStart, anchoredEnd } = compiled;
  const n = input.length;

  if (anchoredStart && fromPos !== 0) {
    return null;
  }

  let current = new Map<number, number>();
  addMatch(current, start, fromPos);
  current = closure(states, current, input, fromPos, n);

  for (let i = fromPos; i <= n; i++) {
    let bestStart: number | null = null;
    for (const [st, startIdx] of current) {
      if (states[st].kind === 'match') {
        if (anchoredEnd && i !== n) {
          continue;
        }
        if (bestStart === null || startIdx < bestStart) {
          bestStart = startIdx;
        }
      }
    }
    if (bestStart !== null) {
      return { start: bestStart, end: i };
    }
    if (i === n) {
      break;
    }
    const next = new Map<number, number>();
    for (const [st, startIdx] of current) {
      const s = states[st];
      if (s.kind === 'char' && s.pred && s.pred(input[i])) {
        addMatch(next, s.out1!, startIdx);
      }
    }
    if (!anchoredStart) {
      addMatch(next, start, i + 1);
    }
    current = closure(states, next, input, i + 1, n);
  }
  return null;
}

/**
 * Finds all non-overlapping matches in `input`, leftmost-first.
 * Zero-length matches are skipped.
 */
export function findAllMatches(
  input: string,
  compiled: CompiledRegex
): ReadonlyArray<{ start: number; end: number; text: string }> {
  const matches: { start: number; end: number; text: string }[] = [];
  let pos = 0;
  const n = input.length;
  while (pos <= n) {
    const m = findFirstMatch(input, compiled, pos);
    if (!m) {
      break;
    }
    if (m.end > m.start) {
      matches.push({ start: m.start, end: m.end, text: input.slice(m.start, m.end) });
    }
    pos = m.end === m.start ? m.start + 1 : m.end;
    if (pos > n) {
      break;
    }
  }
  return matches;
}
