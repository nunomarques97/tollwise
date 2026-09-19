// <tw-access-form>: asks for the Tollwise access key when the API answers 401. A real <form>, so Enter
// submits. It hands the key to the page in an "access-key" event and keeps no copy; the page stores it in
// session storage only (../access.ts). The key is never placed in the URL, a cookie, the title or a log.

import { normalizeAccessKey } from '../access.ts';
import { h } from '../dom.ts';

const INPUT_ID = 'access-key-input';
const MESSAGE_ID = 'access-key-message';

export const REFUSED_MESSAGE = 'That key was not accepted. Check the value of TOLLWISE_ACCESS_KEY and try again.';
export const EMPTY_MESSAGE = 'Enter the access key first.';

export class AccessForm extends HTMLElement {
  private readonly input = h('input', {
    id: INPUT_ID,
    name: 'access-key',
    type: 'password',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    required: true,
  });
  private readonly reveal = h('button', { type: 'button', class: 'field-button', 'aria-pressed': 'false' }, ['Show']);
  private readonly message = h('p', { id: MESSAGE_ID, class: 'field-error', hidden: true });
  private readonly submit = h('button', { type: 'submit', class: 'primary-button' }, ['Open dashboard']);
  private readonly form = h('form', { class: 'access-panel', novalidate: true, 'aria-labelledby': 'access-title' });

  connectedCallback(): void {
    if (this.form.isConnected) return;
    this.reveal.addEventListener('click', () => {
      const showing = this.input.type === 'text';
      this.input.type = showing ? 'password' : 'text';
      this.reveal.textContent = showing ? 'Show' : 'Hide';
      this.reveal.setAttribute('aria-pressed', String(!showing));
    });
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const key = normalizeAccessKey(this.input.value);
      if (key === undefined) {
        this.showError(EMPTY_MESSAGE);
        return;
      }
      this.clearError();
      this.setPending(true);
      this.dispatchEvent(new CustomEvent<string>('access-key', { detail: key, bubbles: true }));
    });
    this.form.append(
      h('h1', { id: 'access-title', class: 'title-text' }, ['Enter the access key']),
      h('p', { class: 'access-intro' }, [
        'This Tollwise instance is protected by an access key. It is the value of ',
        h('code', {}, ['TOLLWISE_ACCESS_KEY']),
        ' where Tollwise runs.',
      ]),
      h('label', { for: INPUT_ID, class: 'field-label' }, ['Access key']),
      h('div', { class: 'field-row' }, [this.input, this.reveal]),
      this.message,
      h('p', { class: 'field-hint' }, [
        'Kept only in this browser tab and sent as a request header, never in the address bar.',
      ]),
      this.submit,
    );
    this.append(this.form);
  }

  /** Shows the form, empty or with the refused-key message, and moves focus to the field. */
  open(refused: boolean): void {
    this.hidden = false;
    this.setPending(false);
    if (refused) {
      this.showError(REFUSED_MESSAGE);
      this.input.focus();
      this.input.select();
    } else {
      this.clearError();
      this.input.focus();
    }
  }

  /** Hides the form and clears the field, so the key is not left in the page. */
  close(): void {
    this.hidden = true;
    this.setPending(false);
    this.clearError();
    this.input.value = '';
    this.input.type = 'password';
    this.reveal.textContent = 'Show';
    this.reveal.setAttribute('aria-pressed', 'false');
  }

  private setPending(pending: boolean): void {
    this.submit.disabled = pending;
    this.form.toggleAttribute('aria-busy', pending);
  }

  private showError(text: string): void {
    this.message.textContent = text;
    this.message.hidden = false;
    this.input.setAttribute('aria-invalid', 'true');
    this.input.setAttribute('aria-describedby', MESSAGE_ID);
    this.input.focus();
  }

  private clearError(): void {
    this.message.hidden = true;
    this.message.textContent = '';
    this.input.removeAttribute('aria-invalid');
    this.input.removeAttribute('aria-describedby');
  }
}
