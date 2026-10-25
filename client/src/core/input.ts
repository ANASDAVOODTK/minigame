// A player's input for one 60 Hz simulation tick. Values are pre-quantized
// (integers) so the host and the predicting client run on bit-identical input.

export const BTN = {
  JET: 1,
  FIRE: 2,
  RELOAD: 4,
  GRENADE: 8,
  SWITCH: 16,
  DOWN: 32,
} as const;
export const BTN_MASK = 63;

export interface InputCmd {
  seq: number;
  buttons: number;
  /** -127..127 horizontal stick. */
  moveX: number;
  /** Aim angle quantized to 0..65535 (full circle). */
  aim: number;
}

export function makeInput(): InputCmd {
  return { seq: 0, buttons: 0, moveX: 0, aim: 0 };
}

export function copyInput(dst: InputCmd, src: InputCmd): InputCmd {
  dst.seq = src.seq;
  dst.buttons = src.buttons;
  dst.moveX = src.moveX;
  dst.aim = src.aim;
  return dst;
}

const TWO_PI = Math.PI * 2;

export function aimFromAngle(rad: number): number {
  let a = Math.round((rad / TWO_PI) * 65536) % 65536;
  if (a < 0) a += 65536;
  return a;
}

export function angleFromAim(aim: number): number {
  return (aim / 65536) * TWO_PI;
}

export function quantizeMove(x: number): number {
  const v = Math.round(x * 127);
  return v > 127 ? 127 : v < -127 ? -127 : v;
}

/** What the input device layer produces each frame; sampled into InputCmds per tick. */
export interface InputState {
  buttons: number;
  moveX: number;
  aim: number;
}
