// Client-side prediction + server reconciliation for the local player.
//
// Every input is applied locally immediately (no waiting for the host). Each
// snapshot tells us the authoritative state after the host processed input
// #ackSeq. If our stored prediction for #ackSeq matches exactly, nothing
// happens. Otherwise we rewind to the host state and replay the inputs the host
// hasn't processed yet. The visual jump is hidden by a decaying offset.

import { copyInput, makeInput, type InputCmd } from './input';
import type { GameMap } from './maps';
import { copySim, makePlayerSim, stepPlayer, type PlayerSim } from './physics';
import { seqDiff, seqNext } from './seq';

const RING = 256;
/** Corrections larger than this snap instantly instead of smoothing (teleport-sized). */
const SNAP_DISTANCE = 96;

export class Predictor {
  readonly state = makePlayerSim();
  /** State before the latest tick, for sub-tick render interpolation. */
  readonly prev = makePlayerSim();
  private hist: PlayerSim[] = [];
  private histSeq = new Int32Array(RING).fill(-1);
  private inputs: InputCmd[] = [];
  private inputSeqs = new Int32Array(RING).fill(-1);
  /** Visual error offset (decays to 0). */
  errX = 0;
  errY = 0;
  corrections = 0;
  replayedInputs = 0;

  constructor() {
    for (let i = 0; i < RING; i++) {
      this.hist.push(makePlayerSim());
      this.inputs.push(makeInput());
    }
  }

  /** Stored input for `seq` (callers only ask for seqs they have stored). */
  getInput(seq: number): InputCmd {
    return this.inputs[seq & (RING - 1)];
  }

  storeInput(cmd: InputCmd): void {
    copyInput(this.inputs[cmd.seq & (RING - 1)], cmd);
    this.inputSeqs[cmd.seq & (RING - 1)] = cmd.seq;
  }

  /** Applies one input to the predicted state. Returns true if the weapon fired. */
  step(cmd: InputCmd, map: GameMap): boolean {
    this.storeInput(cmd);
    copySim(this.prev, this.state);
    const fired = stepPlayer(this.state, cmd, map);
    const i = cmd.seq & (RING - 1);
    copySim(this.hist[i], this.state);
    this.histSeq[i] = cmd.seq;
    return fired;
  }

  /** Takes the host state without replay (e.g. while dead). */
  set(server: PlayerSim): void {
    copySim(this.state, server);
    copySim(this.prev, server);
    this.errX = this.errY = 0;
  }

  /** Compares the prediction for `ackSeq` against the host state and corrects if needed. */
  reconcile(server: PlayerSim, ackSeq: number, latestSeq: number, map: GameMap): boolean {
    const i = ackSeq & (RING - 1);
    if (this.histSeq[i] === ackSeq && sameOnGrid(this.hist[i], server)) return false;
    this.corrections++;
    this.rewindReplay(server, ackSeq, latestSeq, map, true);
    return true;
  }

  /** Hard reset to the host state at `ackSeq` and replay newer inputs (used on spawn). */
  resetTo(server: PlayerSim, ackSeq: number, latestSeq: number, map: GameMap): void {
    this.rewindReplay(server, ackSeq, latestSeq, map, false);
  }

  private rewindReplay(server: PlayerSim, ackSeq: number, latestSeq: number, map: GameMap, smooth: boolean): void {
    const oldX = this.state.x;
    const oldY = this.state.y;
    const btn = this.inputSeqs[ackSeq & (RING - 1)] === ackSeq ? this.inputs[ackSeq & (RING - 1)].buttons : this.state.btn;
    copySim(this.state, server);
    this.state.btn = btn;
    if (ackSeq >= 0) {
      const ai = ackSeq & (RING - 1);
      copySim(this.hist[ai], this.state);
      this.histSeq[ai] = ackSeq;
      if (seqDiff(latestSeq, ackSeq) > 0 && seqDiff(latestSeq, ackSeq) < RING) {
        for (let s = seqNext(ackSeq); ; s = seqNext(s)) {
          const k = s & (RING - 1);
          if (this.inputSeqs[k] !== s) break;
          stepPlayer(this.state, this.inputs[k], map);
          copySim(this.hist[k], this.state);
          this.histSeq[k] = s;
          this.replayedInputs++;
          if (s === latestSeq) break;
        }
      }
    }
    const dx = this.state.x - oldX;
    const dy = this.state.y - oldY;
    this.prev.x += dx;
    this.prev.y += dy;
    if (smooth && dx * dx + dy * dy < SNAP_DISTANCE * SNAP_DISTANCE) {
      this.errX -= dx;
      this.errY -= dy;
    } else {
      this.errX = this.errY = 0;
      copySim(this.prev, this.state);
    }
  }

  /** Decays the visual error offset (call once per rendered frame). */
  decayError(dtMs: number): void {
    const k = Math.exp(-dtMs / 90);
    this.errX *= k;
    this.errY *= k;
    if (Math.abs(this.errX) < 0.05) this.errX = 0;
    if (Math.abs(this.errY) < 0.05) this.errY = 0;
  }
}

function sameOnGrid(a: PlayerSim, b: PlayerSim): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.vx === b.vx &&
    a.vy === b.vy &&
    a.onGround === b.onGround &&
    a.fuel === b.fuel &&
    a.ammo === b.ammo &&
    a.reload === b.reload &&
    a.cooldown === b.cooldown &&
    a.weapon === b.weapon
  );
}
