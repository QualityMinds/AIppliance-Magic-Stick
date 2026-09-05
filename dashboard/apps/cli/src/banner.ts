/** Decorative only: no appliance state, terminal input, or network access. */
export const BANNER_HEIGHT = 7;
export const BANNER_INTERVAL_MS = 125;
export const BANNER_SPEED = 0.5;
// Scene time runs at half real time; docking takes eight seconds on screen.
export const DOCKING_DURATION_MS = 4000;
const VISITOR_START_MS = 8000;
const VISITOR_CYCLE_MS = 20000;
const VISITOR_DURATION_MS = 9000;
export const bannerFits = (rows: number) => rows >= BANNER_HEIGHT + 12;

type Tone = 'space' | 'star' | 'stick' | 'dock' | 'metal' | 'orange' | 'gold';
type Visitor = 'cat' | 'ufo' | 'comet' | 'laptop';
const tones: Record<Tone, string> = {
  space: '\x1b[2;34m', star: '\x1b[37m', stick: '\x1b[36m',
  dock: '\x1b[2;36m', metal: '\x1b[37m', orange: '\x1b[38;5;208m', gold: '\x1b[38;5;220m',
};
const hash = (value: number) => Math.imul(value + 1, 2654435761) >>> 0;
const smooth = (value: number) => value * value * (3 - 2 * value);

const visitors: Record<Visitor, {art: string[]; tone: Tone}> = {
  cat: {art: [' /\\_/\\ ', '( o.o )', ' > ^ < '], tone: 'metal'},
  ufo: {art: ['  _===_  ', ' (_o_o_) ', '  .   .  '], tone: 'orange'},
  comet: {art: [' .   .     ', '  ---===*> '], tone: 'orange'},
  laptop: {art: [' .------. ', ' |  ..  | ', '/__[__]__\\'], tone: 'gold'},
};

export const bannerScene = (elapsedMs: number, seed = 0) => {
  const time = Math.max(0, elapsedMs);
  const phase = time < DOCKING_DURATION_MS ? 'docking' : 'docked';
  const progress = smooth(Math.min(1, time / DOCKING_DURATION_MS));
  const powered = phase === 'docked';
  const connectedMs = Math.max(0, time - DOCKING_DURATION_MS);
  const power = Math.min(1, connectedMs / 1500);
  // Integrate a speed ramp: the three fans spin up, then settle at full speed.
  const fanStep = Math.floor(connectedMs < 1500
    ? connectedMs ** 2 / (2 * 1500 * 100)
    : (connectedMs - 750) / 100);
  // Only visitors repeat: each gets a longer turn after startup, with a quiet gap.
  const visitorTime = time - VISITOR_START_MS;
  const slot = Math.floor(Math.max(0, visitorTime) / VISITOR_CYCLE_MS);
  const visitAge = visitorTime % VISITOR_CYCLE_MS - hash(seed + slot) % 4000;
  const kinds = Object.keys(visitors) as Visitor[];
  const visitor = visitorTime >= 0 && visitAge >= 0 && visitAge < VISITOR_DURATION_MS
    ? kinds[(hash(seed) + slot) % kinds.length] : undefined;
  return {
    phase, progress, powered, power, fanStep, visitor,
    visitorFromRight: slot % 2 === 1,
    visitorProgress: Math.max(0, Math.min(1, visitAge / VISITOR_DURATION_MS)),
  } as const;
};

/** Seven borderless ASCII rows before optional ANSI styling. */
export const renderBanner = (width: number, elapsedMs = 0, color = true, seed = 0): string[] => {
  const columns = Math.max(1, Math.floor(width));
  const grid = Array.from({length: BANNER_HEIGHT}, () => Array.from({length: columns}, () => ({char: ' ', tone: 'space' as Tone})));
  const put = (x: number, y: number, text: string, tone: Tone = 'space') => {
    for (let index = 0; index < text.length; index += 1) {
      const cell = grid[y]?.[x + index];
      if (cell) {
        cell.char = text[index] ?? ' ';
        cell.tone = tone;
      }
    }
  };
  const sprite = (x: number, y: number, lines: string[], tone: Tone) => lines.forEach((line, index) => put(x, y + index, line, tone));
  const tick = Math.floor(elapsedMs / 600);
  for (let index = 0; index < Math.floor(columns / 4); index += 1) {
    const value = hash(index + seed);
    const x = 2 + (value + Math.floor(elapsedMs / 2500)) % Math.max(1, columns - 4);
    const y = [0, 1, 5, 6][index % 4] ?? 0;
    const sparkle = (tick + value) % 13;
    put(x, y, sparkle === 0 ? '+' : sparkle < 3 ? '*' : '.', sparkle < 3 ? 'star' : 'space');
  }

  const scene = bannerScene(elapsedMs, seed);
  const compact = columns < 66;
  const pcWidth = compact ? 17 : 22;
  const bodyWidth = compact ? 12 : 16;
  // Center the connected pair across the actual terminal, not a capped canvas.
  const pairWidth = bodyWidth + 2 + pcWidth + 2;
  const finish = Math.max(0, Math.floor((columns - pairWidth) / 2));
  const pcX = finish + bodyWidth + 2;
  const center = (text: string, width: number) => text.padStart(Math.floor((width + text.length) / 2)).padEnd(width);

  const connectorWidth = 5;
  const stick = [
    ` .${'-'.repeat(bodyWidth - 1)}.${'_'.repeat(connectorWidth)}`,
    `(${center('AIppliance', bodyWidth)}| :: |`,
    `(${center('Magic Stick', bodyWidth)}|____|`,
    ` '${'-'.repeat(bodyWidth - 1)}'`,
  ];
  // At full insertion the body stops at the case; the entire metal connector
  // lies behind it. Painting the opaque PC last also masks partial insertion.
  const start = Math.max(0, Math.min(finish - connectorWidth - 2, Math.floor(columns * 0.13)));
  const x = Math.round(start + (finish - start) * scene.progress);
  sprite(x, 1, stick, 'stick');
  // Rounded nacelles replace sharp fins and visible exhaust.
  put(x + 1, 0, ' .-====-.', 'stick');
  put(x + 1, 5, " '-====-'", 'stick');

  const fan = scene.powered ? ['|', '/', '-', '\\'][scene.fanStep % 4] : '.';
  const fanFace = compact ? `(${fan})`
    : scene.powered ? ['(-o-)', '(\\o/)', '(|o|)', '(/o\\)'][scene.fanStep % 4]! : '( o )';
  const fanRows = [compact ? '.-.' : ' .-. ', fanFace, compact ? "'-'" : " '-' "]
    .map((cell) => [cell, cell, cell].join(compact ? '  ' : ' '));
  const fanWidth = fanRows[0]!.length;
  const fins = scene.powered ? (scene.fanStep % 2 ? '|*|+' : '|+|*') : '||||';
  const card = [
    `.${'-'.repeat(fanWidth)}.`,
    ...fanRows.map((row) => `|${row}|`),
    `'--[${fins.repeat(fanWidth).slice(0, fanWidth - 6)}]--'`,
  ];
  const panel = (text: string) => `|${center(text, pcWidth)}|`;
  const pcTone = scene.powered ? 'stick' : 'dock';
  sprite(pcX, 0, [
    `.${'-'.repeat(pcWidth)}.`,
    ...card.map(panel),
    `'${'-'.repeat(pcWidth)}'`,
  ], pcTone);
  // A separate inset shroud mounts all three fans inside the graphics card.
  const cardX = pcX + 1 + Math.floor((pcWidth - card[0]!.length) / 2);
  sprite(cardX, 1, card, 'metal');
  fanRows.forEach((row, index) => put(cardX + 1, 2 + index, row, scene.powered ? 'orange' : 'metal'));
  if (scene.powered) {
    // Small power sparks live outside the hull, never over its two-line name.
    put(pcX - 2, 0, scene.fanStep % 2 ? '+' : '*', 'orange');
    put(pcX - 3, 6, scene.fanStep % 2 ? '* +' : '+ *', 'orange');
  }

  if (scene.visitor) {
    const visitor = visitors[scene.visitor];
    const visitorWidth = Math.max(...visitor.art.map((line) => line.length));
    const pcRight = pcX + pcWidth + 2;
    // Side stages on wide terminals keep every visitor fully visible. Compact
    // terminals use a lower lane, clear of the two branding rows and the PC.
    const rightSide = scene.visitorFromRight && columns - pcRight >= visitorWidth + 2;
    const leftSide = !rightSide && finish >= visitorWidth + 2;
    const lowerLane = !leftSide && !rightSide;
    const minX = rightSide ? pcRight + 1 : 1;
    const maxX = rightSide ? columns - visitorWidth - 1
      : (lowerLane ? pcX : finish) - visitorWidth - 1;
    const progress = rightSide ? 1 - scene.visitorProgress : scene.visitorProgress;
    const visitorX = Math.round(minX + Math.max(0, maxX - minX) * progress);
    const bob = Math.sin(scene.visitorProgress * Math.PI * 2) > 0.4 ? 1 : 0;
    if (maxX >= minX) sprite(visitorX, lowerLane ? 4 : 1 + bob, visitor.art, visitor.tone);
  }

  return grid.map((row) => {
    if (!color) return row.map((cell) => cell.char).join('');
    let previous: Tone | undefined;
    let line = '';
    for (const cell of row) {
      if (cell.tone !== previous) line += `\x1b[0m${tones[cell.tone]}`;
      line += cell.char;
      previous = cell.tone;
    }
    return `${line}\x1b[0m`;
  });
};

export interface BannerFrame {
  elapsedMs: number;
  seed: number;
}

/** Owns the decorative clock; skipped frames never trigger data refreshes. */
export const createBannerAnimation = (
  onFrame: (frame: BannerFrame) => void,
  canRender: () => boolean = () => true,
  seed = Math.floor(Math.random() * 65536),
) => {
  const frame: BannerFrame = {elapsedMs: 0, seed};
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    get frame(): BannerFrame { return {...frame}; },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        frame.elapsedMs += BANNER_INTERVAL_MS * BANNER_SPEED;
        if (canRender()) onFrame({...frame});
      }, BANNER_INTERVAL_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
};