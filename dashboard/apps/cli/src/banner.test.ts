import {afterEach, describe, expect, it, vi} from 'vitest';
import {BANNER_HEIGHT, BANNER_INTERVAL_MS, BANNER_SPEED, DOCKING_DURATION_MS, bannerFits, bannerScene, createBannerAnimation, renderBanner} from './banner';

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, '');

afterEach(() => vi.useRealTimers());

describe('space banner', () => {
  it.each([1, 20, 40, 65, 80, 120, 200])('keeps exactly seven borderless ASCII rows within %i columns', (width) => {
    for (const time of [0, 9500, 13000, 17000, 37000]) {
      const rows = renderBanner(width, time, false);
      expect(rows).toHaveLength(BANNER_HEIGHT);
      expect(rows).toHaveLength(7);
      expect(rows[0]).not.toMatch(/^\+-+\+$/);
      expect(rows.at(-1)).not.toMatch(/^\+-+\+$/);
      expect(rows.every((row) => row.length <= width && /^[\x20-\x7e]*$/.test(row))).toBe(true);
      expect(renderBanner(width, time).map(plain)).toEqual(rows);
    }
  });

  it('brands the spacecraft on two lines and keeps the PC unlabelled', () => {
    const initial = renderBanner(80, 0, false).join('\n');
    expect(initial).toContain('AIppliance');
    expect(initial).toContain('Magic Stick');
    expect(initial).not.toMatch(/\bGPU\b|USB DOCK|USB \[__\]|\( \(\) \)/);
    expect(initial).toContain('.-====-.');
    expect(initial).toContain("'-====-'");
    expect(renderBanner(80, 0, false)[2]).toMatch(/\(\s+AIppliance/);
    expect(initial).not.toMatch(/~~|~==|\/\\|\\\//);
    expect(renderBanner(80, 0).join('\n')).not.toContain('\x1b[33m');
    const compact = renderBanner(49, 13000, false).join('\n');
    expect(compact).toContain('AIppliance');
    expect(compact).toContain('Magic Stick');
    expect(bannerScene(0)).toMatchObject({phase: 'docking', progress: 0, powered: false});
    expect(bannerScene(DOCKING_DURATION_MS / 2)).toMatchObject({phase: 'docking', progress: 0.5});
    expect(bannerScene(DOCKING_DURATION_MS)).toMatchObject({phase: 'docked', progress: 1, powered: true});
    expect(renderBanner(80, 13000, false).join('\n')).not.toBe(initial);
    expect(renderBanner(80, 600, false)).not.toEqual(renderBanner(80, 0, false));
  });

  it('docks once and stays connected and powered even hours later', () => {
    const plugged = renderBanner(80, DOCKING_DURATION_MS + 2000, false);
    const namePosition = plugged[2]!.indexOf('AIppliance');
    for (const time of [13000, 17500, 28000, 60000, 3600000, 86400000]) {
      expect(bannerScene(time)).toMatchObject({phase: 'docked', progress: 1, powered: true, power: 1});
      const rows = renderBanner(80, time, false);
      expect(rows[2]!.indexOf('AIppliance')).toBe(namePosition);
      expect(rows[2]).not.toContain(' :: |');
      expect(rows[3]).not.toContain('____|');
      expect(rows[3]).not.toContain('( o ) ( o ) ( o )');
      expect(rows.join('\n')).not.toMatch(/standby|BOOT|TURBO/);
    }
  });

  it.each([80, 120, 160, 240])('centers the connected pair on the full %i-column screen', (width) => {
    const rows = renderBanner(width, DOCKING_DURATION_MS + 2000, false);
    const shipLeft = rows[2]!.indexOf('(');
    const pcLeft = rows[0]!.indexOf(`.${'-'.repeat(22)}.`);
    const pcRight = pcLeft + 24;
    expect(rows.every((row) => row.length === width)).toBe(true);
    expect(Math.abs((shipLeft + pcRight) / 2 - width / 2)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(pcLeft - width / 2)).toBeLessThanOrEqual(4);
    expect(width - pcRight).toBeGreaterThan(width * 0.2);
  });

  it.each([49, 80, 120])('fully hides the connector inside the case at %i columns', (width) => {
    const unplugged = renderBanner(width, 0, false);
    const plugged = renderBanner(width, 13000, false);
    expect(unplugged[2]).toContain(' :: |');
    expect(unplugged[3]).toContain('____|');
    expect(plugged[2]).not.toContain(' :: |');
    expect(plugged[3]).not.toContain('____|');
    expect(plugged[2]).toContain('AIppliance');
    expect(plugged[3]).toContain('Magic Stick');
    expect(plugged.join('\n')).not.toContain('USB [__]');
    expect(plugged.join('\n')).not.toContain('GPU');
    const pcLeft = plugged[0]!.indexOf(`.${'-'.repeat(width < 66 ? 17 : 22)}.`);
    expect(plugged[2]!.slice(pcLeft).match(/\.-\./g)).toHaveLength(3);
    expect(plugged[3]!.slice(pcLeft).match(/\([^)]*\)/g)).toHaveLength(3);
    expect(plugged[4]!.slice(pcLeft).match(/'-'/g)).toHaveLength(3);
    expect(plugged[5]).toMatch(/\[[|+*]+\]/);
    expect(plugged[6]).toContain("'---");
  });

  it('powers up only when inserted and accelerates all three GPU fans', () => {
    const dockedAt = DOCKING_DURATION_MS;
    expect(bannerScene(dockedAt - 1)).toMatchObject({powered: false, power: 0, fanStep: 0});
    expect(bannerScene(dockedAt + 250)).toMatchObject({powered: true});
    expect(bannerScene(dockedAt + 250).power).toBeLessThan(1);
    expect(bannerScene(dockedAt + 2000)).toMatchObject({powered: true, power: 1});
    const earlySteps = bannerScene(dockedAt + 500).fanStep - bannerScene(dockedAt).fanStep;
    const fullSpeedSteps = bannerScene(dockedAt + 2500).fanStep - bannerScene(dockedAt + 2000).fanStep;
    expect(fullSpeedSteps).toBeGreaterThan(earlySteps);
    const idle = renderBanner(80, 0, false);
    expect(idle[3]).toContain('( o ) ( o ) ( o )');
    expect(idle[5]).toContain("'--[|||||||||||]--'");
    expect(renderBanner(80, dockedAt + 300, false)[3]).not.toContain('( o ) ( o ) ( o )');
    expect(renderBanner(80, 13100, false)[3]).not.toBe(renderBanner(80, 13000, false)[3]);
    expect(renderBanner(80, 17500, false)[3]).not.toContain('( o ) ( o ) ( o )');
  });

  it.each([49, 80, 120])('encloses all three fans in a separate shroud at %i columns', (width) => {
    for (const time of [0, 13000, 13100]) {
      const rows = renderBanner(width, time, false);
      const top = [...rows[1]!.matchAll(/\.-+\./g)].at(-1)!;
      expect(top).not.toBeNull();
      const left = top.index!;
      const right = left + top[0].length - 1;
      for (const row of rows.slice(2, 5)) {
        expect(row[left]).toBe('|');
        expect(row[right]).toBe('|');
      }
      expect(rows[3]!.slice(left + 1, right).match(/\([^)]*\)/g)).toHaveLength(3);
      expect(rows[5]![left]).toBe("'");
      expect(rows[5]![right]).toBe("'");
      expect(rows[3]!.slice(right + 1)).toContain('|'); // Outer PC case.
    }
  });

  it('uses neutral and warm accents rather than purple for fans and visitors', () => {
    for (let time = 0; time < 600000; time += 1000) {
      const screen = renderBanner(80, time).join('\n');
      expect(screen).not.toMatch(/\x1b\[(?:[\d;]*;)?(?:35|95)m/);
    }
    const powered = renderBanner(80, 13000);
    expect(powered[3]).toContain('\x1b[38;5;208m');
    expect(powered[3]).toContain('\x1b[37m');
  });

  it('floats a golden laptop in clear view without covering the branding', () => {
    const time = Array.from({length: 600}, (_, index) => index * 1000)
      .find((elapsed) => bannerScene(elapsed).visitor === 'laptop');
    expect(time).toBeDefined();
    for (const width of [49, 80, 160]) {
      const first = renderBanner(width, time!, true);
      const later = renderBanner(width, time! + 2000, true);
      for (const rows of [first, later]) {
        expect(rows.join('\n')).toContain('\x1b[0m\x1b[38;5;220m');
        const unstyled = rows.map(plain);
        expect(unstyled.join('\n')).toContain(' .------. ');
        expect(unstyled.join('\n')).toContain('/__[__]__\\');
        expect(unstyled[2]).toContain('AIppliance');
        expect(unstyled[3]).toContain('Magic Stick');
        expect(unstyled).toEqual(renderBanner(width, rows === first ? time! : time! + 2000, false));
      }
      expect(first.map(plain).find((row) => row.includes('/__[__]__\\')))
        .not.toBe(later.map(plain).find((row) => row.includes('/__[__]__\\')));
    }
    expect(renderBanner(80, 0).join('\n')).not.toContain('\x1b[38;5;220m');
  });

  it('starts with artwork and has no captions or PC power text', () => {
    for (let time = 0; time < 60000; time += 1000) {
      const rows = renderBanner(80, time, false);
      expect(rows[0]).toContain(`.${'-'.repeat(22)}.`);
      expect(rows[6]).toContain(`'${'-'.repeat(22)}'`);
      expect(rows.join('\n')).not.toMatch(/universe|Aligning|Waking|Golden laptop|standby|BOOT|TURBO/);
      expect(bannerScene(time)).not.toHaveProperty('caption');
    }
  });

  it('makes visitors brief, varied, and deterministic, rather than constantly visible', () => {
    const visitors = new Set<string>();
    let visibleSeconds = 0;
    for (let time = 0; time < 600000; time += 1000) {
      const scene = bannerScene(time, 0);
      if (scene.visitor) {
        visitors.add(scene.visitor);
        visibleSeconds += 1;
      }
    }
    expect(visitors).toEqual(new Set(['cat', 'ufo', 'comet', 'laptop']));
    expect(visibleSeconds).toBeGreaterThan(240);
    expect(visibleSeconds).toBeLessThan(290);
    expect(bannerScene(0).visitor).toBeUndefined();
    expect(renderBanner(80, 35000, false, 42)).toEqual(renderBanner(80, 35000, false, 42));
    expect(bannerFits(18)).toBe(false);
    expect(bannerFits(19)).toBe(true);
  });

  it('keeps each visitor unobscured in seven rows after startup', () => {
    const samples = Array.from({length: 120}, (_, index) => index * 1000);
    for (const [kind, visibleFeature] of [
      ['cat', '( o.o )'], ['ufo', '(_o_o_)'],
      ['comet', '---===*>'], ['laptop', '/__[__]__\\'],
    ]) {
      const time = samples.find((elapsed) => bannerScene(elapsed).visitor === kind);
      expect(time).toBeDefined();
      for (const width of [49, 80, 160]) {
        const rows = renderBanner(width, time!, false);
        expect(rows.join('\n')).toContain(visibleFeature);
        expect(rows).toHaveLength(7);
        expect(rows[2]).toContain('AIppliance');
        expect(rows[3]).toContain('Magic Stick');
      }
    }
    for (const time of samples) {
      const scene = bannerScene(time);
      if (time < DOCKING_DURATION_MS + 1500) expect(scene.visitor).toBeUndefined();
    }
  });

  it('runs continuously even when hidden and releases its only timer on exit', () => {
    vi.useFakeTimers();
    const repaint = vi.fn();
    let visible = true;
    const animation = createBannerAnimation(repaint, () => visible, 42);
    animation.start();
    animation.start();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(BANNER_INTERVAL_MS);
    expect(BANNER_SPEED).toBe(0.5);
    expect(repaint).toHaveBeenCalledWith({elapsedMs: BANNER_INTERVAL_MS / 2, seed: 42});
    expect(animation).not.toHaveProperty('toggle');
    expect(animation.frame).not.toHaveProperty('paused');
    visible = false;
    vi.advanceTimersByTime(1000);
    expect(repaint).toHaveBeenCalledOnce();
    expect(animation.frame.elapsedMs).toBe((BANNER_INTERVAL_MS + 1000) * BANNER_SPEED);
    visible = true;
    vi.advanceTimersByTime(BANNER_INTERVAL_MS);
    expect(repaint).toHaveBeenCalledTimes(2);
    expect(animation.frame.elapsedMs).toBe((BANNER_INTERVAL_MS * 2 + 1000) * BANNER_SPEED);
    animation.stop();
    animation.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(repaint).toHaveBeenCalledTimes(2);
  });
});