// Plain-language wording for engine events and morale causes.
import type { SimEvent } from '@napoleon/engine';

const CAUSES: Record<string, string> = {
  musketry: 'musketry',
  musketry_flank: 'musketry in the flank',
  musketry_close_on_column: 'close-range volleys into the column',
  roundshot: 'roundshot',
  canister: 'canister',
  melee: 'hand-to-hand fighting',
  charged_in_front: 'charged frontally by cavalry',
  charged_in_flank: 'charged in the flank by cavalry',
  charged_in_rear: 'charged in the rear by cavalry',
  charged_while_forming: 'charged while changing formation',
  square_broken_into: 'its shaken square was broken into',
  repulsed_by_square: 'repulsed by a square',
  guns_overrun: 'the guns were overrun',
  bayonet_charge: 'a column came on with the bayonet',
  friend_routed: 'a friend broke nearby',
  enemy_routed: 'an enemy broke nearby',
  army_broken: 'the army broke',
  pursuit: 'cut down in flight',
  skirmish_fire: 'skirmisher fire',
  commander_down: 'its commander was hit',
  fatigue: 'exhaustion',
};

export const desnake = (s: string): string => s.replace(/_/g, ' ');
export const causeWords = (c: string | undefined): string => (c ? CAUSES[c] ?? desnake(c) : 'no single cause');

/** "charged in the flank by Scots Greys": cause with its author, where the phrase allows one. */
export function causeBy(c: string, from: string | undefined): string {
  const w = causeWords(c);
  if (!from) return w;
  if (c.startsWith('charged_')) return w.replace('by cavalry', `by ${from}`).replace('while changing formation', `while changing formation by ${from}`);
  if (c === 'friend_routed') return `${from} broke nearby`;
  if (c === 'enemy_routed') return `${from} broke nearby`;
  if (c === 'bayonet_charge') return `${from} came on with the bayonet`;
  if (c === 'repulsed_by_square') return `repulsed by the square of ${from}`;
  if (c === 'guns_overrun') return `overrun by ${from}`;
  if (c === 'square_broken_into') return `its shaken square was broken into by ${from}`;
  if (c === 'melee') return `hand-to-hand fighting with ${from}`;
  return `${w} from ${from}`;
}

export interface Named {
  name(id: unknown): string;
  arm(id: unknown): string;
  sideName(i: number): string;
}

const CONTACT: Record<string, (a: string, b: string, e: SimEvent) => string> = {
  cavalry_charge: (a, b, e) => `${a} charge home on ${b}${e.forming ? ' before it can form' : e.facing && e.facing !== 'front' ? ` from the ${e.facing}` : ''}`,
  cavalry_repulsed_by_square: (a, b) => `${a} recoil from the square of ${b}`,
  cavalry_breaks_shaken_square: (a, b) => `${a} break into the shaken square of ${b}`,
  cavalry_overruns_guns: (a, b) => `${a} ride over ${b}`,
  cavalry_melee: (a, b) => `${a} cross swords with ${b}`,
  infantry_overruns_guns: (a, b) => `${a} storms the guns of ${b}`,
  bayonet_charge: (a, b) => `${a} goes in with the bayonet against ${b}`,
  cavalry_recoils_from_volley: (a, b) => `${a} recoil from the volley of ${b}`,
};

/** A sentence for the dispatches log, or null for events that do not belong there. */
export function sentence(e: SimEvent, n: Named): string | null {
  const who = e.unit ? n.name(e.unit) : '';
  const cav = e.unit ? n.arm(e.unit) === 'cav' : false;
  switch (e.type) {
    case 'fire':
    case 'morale':
      return null;
    case 'rout':
      if (e.kind === 'army_broken') return `${who} ${cav ? 'join' : 'joins'} the flight`;
      return `${who} ${cav ? 'break and ride for the rear' : 'breaks and runs'} (${causeWords(e.topCause as string)})`;
    case 'guns_abandoned':
      return `${who} abandons its guns (${causeWords(e.topCause as string)})`;
    case 'destroyed':
      return `${who} ${cav ? 'are' : 'is'} destroyed (${causeWords(e.topCause as string)})`;
    case 'gone':
      return e.reason === 'left_field' ? `${who} ${cav ? 'leave' : 'leaves'} the field` : e.reason === 'scattered' ? `${who} ${cav ? 'are' : 'is'} scattered` : `${who}: ${desnake(String(e.reason))}`;
    case 'rally':
      return `${who} ${cav ? 'rally' : 'rallies'}`;
    case 'contact': {
      const f = CONTACT[String(e.kind)];
      return f ? f(who, n.name(e.target), e) : `${who}: ${desnake(String(e.kind))} ${n.name(e.target)}`;
    }
    case 'formation':
      return `${who} forms ${e.to}`;
    case 'blown':
      return `${who} are blown`;
    case 'army_broken':
      return `The ${n.sideName(e.side ?? 0)} army breaks`;
    case 'input':
      if (e.kind === 'posture') return `Order to the ${n.sideName(e.side ?? 0)}: ${desnake(String(e.posture))}`;
      return `Order to ${who}: ${e.kind === 'unit_release' ? 'handed back to staff' : e.kind === 'unit_formation' ? `form ${e.detail}` : orderWords(e.detail, n)}`;
    case 'order_issued':
      return `${e.from} issues an order to ${e.commander}: ${e.order}`;
    case 'order_sent':
      return `A courier leaves ${e.from} for ${e.commander}: ${e.order}`;
    case 'order_received':
      return `${e.commander} receives the order: ${e.order}`;
    case 'order_active':
      return e.own ? `${e.commander} gives his own order: ${e.order}` : `${e.commander} puts the order into effect: ${e.order}${e.direct ? ' (direct)' : ''}`;
    case 'courier_lost':
      return `A courier to ${e.formation} is lost on the way (${e.order})`;
    case 'initiative':
      return `${e.commander} acts on his own: ${e.action} (${e.why})`;
    case 'commander_down':
      return `${e.commander} is hit; ${e.formation} is without a commander`;
    case 'commander_replaced':
      return `${e.commander} takes command of ${e.formation}`;
    case 'ammunition':
      return `${who}: ${e.state}`;
    case 'skirmishers':
      return e.state === 'out' ? `${who} throws out ${e.men ?? ''} skirmishers`.replace('  ', ' ') : `${who} calls in its skirmishers (${e.why})`;
    case 'end':
      return `The action ends (${desnake(String(e.reason))})`;
    default: {
      const bits = [desnake(e.type)];
      if (e.kind) bits.push(desnake(String(e.kind)));
      if (e.target) bits.push(n.name(e.target));
      return who ? `${who}: ${bits.join(' ')}` : bits.join(' ');
    }
  }
}

function orderWords(d: unknown, n: Named): string {
  const o = d as { type?: string; target?: string; x?: number; y?: number } | null;
  if (!o) return 'new orders';
  if (o.type === 'halt') return 'halt';
  if (o.type === 'attack') return `attack ${n.name(o.target)}`;
  return `march to (${Math.round(o.x ?? 0)}, ${Math.round(o.y ?? 0)})`;
}

export const BIG = new Set(['army_broken', 'end']);
/** Routine events shown only when the log is filtered to one unit. */
export const ROUTINE = new Set(['formation', 'skirmishers', 'order_sent']);
