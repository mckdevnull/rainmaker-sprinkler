import { describe, expect, it } from 'vitest';
import type { ProgramData } from '../../src/controller/types.js';
import { programToSchedule, scheduleToProgram } from '../../src/state/model.js';

const weekly: ProgramData = [0b00000011, 0b0010101, 0, [360, 1200, -1, -1], [600, 0, 300], 'Lawn'];
const interval: ProgramData = [0b00010001, 3, 1, [420, -1, -1, -1], [0, 900], 'Beds'];
const odd: ProgramData = [0b00000101, 0, 0, [300, -1, -1, -1], [120], 'Odd'];

describe('program mapping', () => {
  it('maps weekly, interval and odd-day kinds', () => {
    const w = programToSchedule(0, weekly);
    expect(w).toMatchObject({ kind: 'weekly', enabled: true, weatherAdjust: true, startMinutes: [360, 1200] });
    expect(w.days).toEqual([true, false, true, false, true, false, false]);
    expect(w.zoneMinutes).toEqual({ 0: 10, 2: 5 });
    expect(programToSchedule(1, interval)).toMatchObject({ kind: 'interval', days: [], enabled: true });
    expect(programToSchedule(2, odd).kind).toBe('odd-days');
    expect(programToSchedule(2, [0b1101, 0, 0, [], [], 'E']).kind).toBe('even-days');
  });

  it('program round-trip is lossless', () => {
    for (const pd of [weekly, interval, odd]) {
      expect(scheduleToProgram(programToSchedule(0, pd))).toEqual(pd);
    }
  });

  it('flipping only enabled changes only bit 0', () => {
    for (const pd of [weekly, interval, odd]) {
      const s = programToSchedule(0, pd);
      const out = scheduleToProgram({ ...s, enabled: !s.enabled });
      expect(out[0] ^ pd[0]).toBe(1);
      expect(out.slice(1)).toEqual(pd.slice(1));
    }
  });
});
