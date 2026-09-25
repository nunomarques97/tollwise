// <tw-live-status>: the header's connection indicator. An 8 px shape and a text label; the text always
// names the state and the shape changes with it, so colour is never the only signal. The static demo has
// a state of its own, "Static demo": it is never shown as live, connecting or paused.

import { h, prefersReducedMotion } from '../dom.ts';

export type LiveState = 'live' | 'connecting' | 'paused' | 'offline' | 'demo';

const LABELS: Readonly<Record<LiveState, string>> = {
  live: 'Live',
  connecting: 'Connecting',
  paused: 'Reconnecting',
  offline: 'Not connected',
  demo: 'Static demo',
};

export class LiveStatus extends HTMLElement {
  private readonly dot = h('span', { class: 'live-dot', 'aria-hidden': 'true' });
  private readonly label = h('span', { class: 'live-label' });

  connectedCallback(): void {
    if (this.label.isConnected) return;
    this.setAttribute('role', 'status');
    this.dot.addEventListener('animationend', () => this.dot.classList.remove('is-pulsing'));
    this.append(this.dot, this.label);
    this.set(this.state);
  }

  get state(): LiveState {
    const value = this.dataset.state;
    return value === 'live' || value === 'paused' || value === 'offline' || value === 'demo' ? value : 'connecting';
  }

  set(state: LiveState): void {
    this.dataset.state = state;
    // Written only on a change, so assistive technology hears each state once.
    if (this.label.textContent !== LABELS[state]) this.label.textContent = LABELS[state];
  }

  /** The one signature moment of a live update: the dot scales once. Off under reduced motion. */
  pulse(): void {
    if (this.state !== 'live' || prefersReducedMotion()) return;
    this.dot.classList.remove('is-pulsing');
    // Reading layout restarts the animation when a second update lands while the first still runs.
    void this.dot.offsetWidth;
    this.dot.classList.add('is-pulsing');
  }
}
